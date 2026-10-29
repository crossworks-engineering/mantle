import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { TodosSchema } from '@/lib/task-schemas';
import {
  RANK_RE,
  TASK_PRIORITIES,
  TASK_STATUSES,
  deleteTask,
  getTask,
  updateTask,
} from '@/lib/tasks';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). The item gate does not answer a bad id
 *  here. */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'content', open: 'owner' },
  PATCH: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'edit' },
  },
  DELETE: {
    class: 'content',
    open: 'owner',
    item: { param: 'id', need: 'manage' },
  },
});

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(50_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  /** Full checklist replace; [] clears it. */
  todos: TodosSchema.optional(),
  /** Board-order key (a drag writes status+rank together); null clears. */
  rank: z.string().regex(RANK_RE).nullable().optional(),
  /** `true` files the task away, `false` restores it. A boolean rather than a
   *  timestamp so a client cannot backdate the archive; the server stamps it. */
  archived: z.boolean().optional(),
  /** `true` takes a done task back to the status it had before it was marked
   *  done (the brain remembers it; 'open' when it does not know). An explicit
   *  `status` in the same body wins. */
  reopen: z.boolean().optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const row = await getTask(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ task: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const raw = await readJson(req);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { archived, ...rest } = parsed.data;
  const row = await updateTask(user.id, id, {
    ...rest,
    // The server owns the clock: `archived: true` stamps now, `false` clears.
    ...(archived === undefined ? {} : { archivedAt: archived ? new Date().toISOString() : null }),
  });
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ task: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const ok = await deleteTask(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
