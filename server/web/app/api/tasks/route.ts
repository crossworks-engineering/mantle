import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { TodosSchema } from '@/lib/task-schemas';
import {
  RANK_RE,
  TASK_PRIORITIES,
  TASK_STATUSES,
  countTasks,
  createTask,
  listTasks,
  type TaskPriority,
  type TaskStatusFilter,
} from '@/lib/tasks';

const PAGE_SIZE = 50;
/** The board view loads every column in one call — cap it, don't paginate it. */
const PAGE_SIZE_MAX = 500;

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(50_000).optional().default(''),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
  todos: TodosSchema.optional(),
  rank: z.string().regex(RANK_RE).nullable().optional(),
});

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  const priorityParam = url.searchParams.get('priority');
  // An unknown filter value is a caller bug — 400 with the vocabulary rather
  // than silently widening to 'all' (the old behavior masked client drift).
  if (
    statusParam &&
    statusParam !== 'all' &&
    statusParam !== 'active' &&
    !(TASK_STATUSES as readonly string[]).includes(statusParam)
  ) {
    return NextResponse.json(
      { error: `invalid status '${statusParam}' — use ${TASK_STATUSES.join('/')}/active/all` },
      { status: 400 },
    );
  }
  if (
    priorityParam &&
    priorityParam !== 'all' &&
    !(TASK_PRIORITIES as readonly string[]).includes(priorityParam)
  ) {
    return NextResponse.json(
      { error: `invalid priority '${priorityParam}' — use ${TASK_PRIORITIES.join('/')}/all` },
      { status: 400 },
    );
  }
  const status: TaskStatusFilter = statusParam ? (statusParam as TaskStatusFilter) : 'all';
  const priority: TaskPriority | 'all' = priorityParam
    ? (priorityParam as TaskPriority | 'all')
    : 'all';
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Number.parseInt(url.searchParams.get('pageSize') ?? '', 10) || PAGE_SIZE),
  );
  const opts = {
    query: url.searchParams.get('q') ?? undefined,
    status,
    priority,
    tag: url.searchParams.get('tag') ?? undefined,
  };
  const [tasks, total] = await Promise.all([
    listTasks(user.id, { ...opts, limit: pageSize, offset: (page - 1) * pageSize }),
    countTasks(user.id, opts),
  ]);
  return NextResponse.json({ tasks, total, page, pageSize });
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const row = await createTask(user.id, parsed.data);
  return NextResponse.json({ task: row }, { status: 201 });
}
