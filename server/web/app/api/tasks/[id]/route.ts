import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
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
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const row = await getTask(user.id, id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ task: row });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const raw = await req.json().catch(() => ({}));
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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const ok = await deleteTask(user.id, id);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
