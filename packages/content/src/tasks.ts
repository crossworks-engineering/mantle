/**
 * Tasks surface. A task is a `nodes` row with type='task':
 *
 *   nodes.title       short imperative
 *   nodes.data.body   freeform notes (extractor reads this)
 *   nodes.data.status 'open' | 'done'
 *   nodes.data.priority 'low' | 'normal' | 'high'
 *   nodes.data.due_at ISO timestamp (optional)
 *
 * Under the `tasks` ltree root. Lazy-created on first write. The
 * extractor's special case in apps/api/src/agent/extractor.ts:readNodeBodyRaw
 * surfaces status + priority + due_at into the body it summarises.
 */
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, type Node } from '@mantle/db';

// ltree root label for the Tasks branch. Existing brains were re-pathed to it by
// migration 0108; queries filter by `type='task'` (below),
// so this label is purely organizational.
export const TASKS_ROOT_LABEL = 'tasks';
export const TASK_STATUSES = ['open', 'done'] as const;
export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export type TaskRow = {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowOf(n: Node): TaskRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const status =
    typeof d.status === 'string' && (TASK_STATUSES as readonly string[]).includes(d.status)
      ? (d.status as TaskStatus)
      : 'open';
  const priority =
    typeof d.priority === 'string' &&
    (TASK_PRIORITIES as readonly string[]).includes(d.priority)
      ? (d.priority as TaskPriority)
      : 'normal';
  return {
    id: n.id,
    title: n.title,
    body: typeof d.body === 'string' ? d.body : '',
    status,
    priority,
    dueAt: typeof d.due_at === 'string' ? d.due_at : null,
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Tasks',
      slug: TASKS_ROOT_LABEL,
      path: TASKS_ROOT_LABEL,
      data: { description: 'Tasks.' },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

type ListTasksOpts = {
  query?: string;
  status?: TaskStatus | 'all';
  priority?: TaskPriority | 'all';
  tag?: string;
};

/** Shared WHERE conditions for task list/count queries. */
function taskConds(ownerId: string, opts: ListTasksOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'task')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${nodes.data}->>'body' ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.status && opts.status !== 'all') {
    conds.push(sql`coalesce(${nodes.data}->>'status', 'open') = ${opts.status}`);
  }
  if (opts.priority && opts.priority !== 'all') {
    conds.push(sql`coalesce(${nodes.data}->>'priority', 'normal') = ${opts.priority}`);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listTasks(
  ownerId: string,
  opts: ListTasksOpts & { limit?: number; offset?: number } = {},
): Promise<TaskRow[]> {
  // Sort by status (open first), then by due_at nulls last, then by updated_at desc.
  const rows = await db
    .select()
    .from(nodes)
    .where(and(...taskConds(ownerId, opts)))
    .orderBy(
      // Direction must precede the null-ordering: `<expr> asc nulls last`.
      // Don't wrap in asc()/desc() — they append the direction AFTER the
      // expression, producing the invalid `<expr> nulls last asc`.
      sql`coalesce(${nodes.data}->>'status', 'open') = 'done' asc`,
      sql`mantle_iso_to_ts(${nodes.data}->>'due_at') asc nulls last`,
      desc(nodes.updatedAt),
    )
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map(rowOf);
}

/** Total tasks matching the same filters as `listTasks` (drives pagination). */
export async function countTasks(ownerId: string, opts: ListTasksOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...taskConds(ownerId, opts)));
  return row?.n ?? 0;
}

export async function getTask(ownerId: string, id: string): Promise<TaskRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'task')))
    .limit(1);
  return row ? rowOf(row) : null;
}

export type CreateTaskInput = {
  title: string;
  body?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueAt?: string | null;
  tags?: string[];
  /** Extra `data` keys merged UNDER the canonical fields (canonical keys
   *  always win). Used by system callers that must stamp provenance the
   *  model can't forge — e.g. team_request_create's `teamRequest` block. */
  extraData?: Record<string, unknown>;
};

export async function createTask(ownerId: string, input: CreateTaskInput): Promise<TaskRow> {
  await ensureRoot(ownerId);
  const data: Record<string, unknown> = {
    ...(input.extraData ?? {}),
    body: input.body ?? '',
    status: input.status ?? 'open',
    priority: input.priority ?? 'normal',
    ...(input.dueAt ? { due_at: input.dueAt } : {}),
  };
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'task',
      title: input.title.trim().slice(0, 200) || 'Untitled task',
      path: TASKS_ROOT_LABEL,
      data,
      tags: dedupeTags(input.tags ?? []),
    })
    .returning();
  if (!row) throw new Error('createTask: insert returned no row');
  return rowOf(row);
}

export type UpdateTaskInput = Partial<CreateTaskInput>;

export async function updateTask(
  ownerId: string,
  id: string,
  input: UpdateTaskInput,
): Promise<TaskRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'task')))
    .limit(1);
  if (!node) return null;
  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const newData: Record<string, unknown> = { ...oldData };
  if (input.body !== undefined) newData.body = input.body;
  if (input.status !== undefined) newData.status = input.status;
  if (input.priority !== undefined) newData.priority = input.priority;
  if (input.dueAt !== undefined) {
    if (input.dueAt) newData.due_at = input.dueAt;
    else delete newData.due_at;
  }
  // Title/body/priority/due/status all matter for the summary — invalidate
  // when any of them moves so the next extractor pass re-summarises.
  const contentChanged =
    input.title !== undefined ||
    input.body !== undefined ||
    input.status !== undefined ||
    input.priority !== undefined ||
    input.dueAt !== undefined;
  if (contentChanged) {
    delete newData.summary;
    delete newData.summary_model;
    delete newData.summary_at;
    delete newData.entities;
  }
  const [updated] = await db
    .update(nodes)
    .set({
      ...(input.title !== undefined
        ? { title: input.title.trim().slice(0, 200) || 'Untitled task' }
        : {}),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      ...(contentChanged ? { embedding: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();
  if (!updated) throw new Error('updateTask: update returned no row');
  if (contentChanged) {
    await notifyNodeIngested(id);
  }
  return rowOf(updated);
}

export async function deleteTask(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'task')))
    .limit(1);
  if (!row) return false;
  await db.delete(nodes).where(eq(nodes.id, id));
  return true;
}

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}
