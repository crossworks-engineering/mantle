import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  countTasks,
  createTask,
  listTasks,
  type TaskStatus,
  type TaskPriority,
} from '@/lib/tasks';

const PAGE_SIZE = 50;

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(50_000).optional().default(''),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  const priorityParam = url.searchParams.get('priority');
  const status: TaskStatus | 'all' =
    statusParam &&
    statusParam !== 'all' &&
    (TASK_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as TaskStatus)
      : 'all';
  const priority: TaskPriority | 'all' =
    priorityParam &&
    priorityParam !== 'all' &&
    (TASK_PRIORITIES as readonly string[]).includes(priorityParam)
      ? (priorityParam as TaskPriority)
      : 'all';
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const opts = {
    query: url.searchParams.get('q') ?? undefined,
    status,
    priority,
    tag: url.searchParams.get('tag') ?? undefined,
  };
  const [tasks, total] = await Promise.all([
    listTasks(user.id, { ...opts, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countTasks(user.id, opts),
  ]);
  return NextResponse.json({ tasks, total, page, pageSize: PAGE_SIZE });
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
