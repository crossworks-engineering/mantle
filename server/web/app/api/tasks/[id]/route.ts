import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  RANK_RE,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TODOS_MAX,
  TASK_TODO_TEXT_MAX,
  deleteTask,
  getTask,
  updateTask,
} from '@/lib/tasks';

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(50_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  /** Full checklist replace; [] clears it. */
  todos: z
    .array(
      z.object({
        id: z.string().max(64).optional(),
        text: z.string().min(1).max(TASK_TODO_TEXT_MAX),
        done: z.boolean().optional(),
      }),
    )
    .max(TASK_TODOS_MAX)
    .optional(),
  /** Board-order key (a drag writes status+rank together); null clears. */
  rank: z.string().regex(RANK_RE).nullable().optional(),
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
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const row = await updateTask(user.id, id, parsed.data);
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
