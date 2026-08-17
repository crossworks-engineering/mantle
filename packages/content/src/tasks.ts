/**
 * Tasks surface. A task is a `nodes` row with type='task':
 *
 *   nodes.title       short imperative
 *   nodes.data.body   freeform notes (extractor reads this)
 *   nodes.data.status 'open' | 'in_progress' | 'blocked' | 'done'
 *   nodes.data.priority 'low' | 'normal' | 'high'
 *   nodes.data.due_at ISO timestamp (optional)
 *   nodes.data.todos  checklist items [{id, text, done}] (optional)
 *   nodes.data.rank   fractional board-order key (optional; see rank.ts)
 *
 * Under the `tasks` ltree root. Lazy-created on first write. The
 * extractor's special case in apps/api/src/agent/extractor.ts:readNodeBodyRaw
 * surfaces status + priority + due_at + todos into the body it summarises.
 * Comments live in the `node_comments` sidecar (node-comments.ts); rows here
 * carry only the count.
 */
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, type Node } from '@mantle/db';
import type { TaskRow, TaskStatus, TaskPriority, TaskTodo } from '@mantle/client-types';
import { isValidRank } from './rank';
export type { TaskRow, TaskStatus, TaskPriority, TaskTodo };

// ltree root label for the Tasks branch. Existing brains were re-pathed to it by
// migration 0108; queries filter by `type='task'` (below),
// so this label is purely organizational.
export const TASKS_ROOT_LABEL = 'tasks';
// `satisfies` pins these consts to the wire unions in @mantle/client-types, so
// adding a status here without updating the contract is a compile error.
export const TASK_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'done',
] as const satisfies readonly TaskStatus[];
export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const satisfies readonly TaskPriority[];

export const TASK_TODOS_MAX = 100;
export const TASK_TODO_TEXT_MAX = 500;

/** NOTIFY channel raised by the migration-0148 triggers on task UPDATE/DELETE
 *  (payload: owner id). Fills the two gaps node_ingested leaves: deletes and
 *  rank/tags-only edits. Consumed by server/web/lib/realtime.ts only. */
export const TASKS_CHANGED_CHANNEL = 'tasks_changed';

/** Coerce a stored `data.todos` value (or caller input) to clean items.
 *  Assigns ids to items that lack one so client edits can key on them. */
export function sanitizeTodos(value: unknown): TaskTodo[] {
  if (!Array.isArray(value)) return [];
  const out: TaskTodo[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const text = typeof item.text === 'string' ? item.text.trim().slice(0, TASK_TODO_TEXT_MAX) : '';
    if (!text) continue;
    out.push({
      id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID(),
      text,
      done: item.done === true,
    });
    if (out.length >= TASK_TODOS_MAX) break;
  }
  return out;
}

/** Scalar subquery: live comment count for the row (see node-comments.ts).
 *  The outer column must be table-qualified BY HAND — drizzle renders a bare
 *  `${nodes.id}` as unqualified `"id"`, which inside the subquery resolves to
 *  node_comments' own id and silently counts 0 (caught in the live audit). */
const commentCountSql = sql<number>`(
  select count(*)::int from node_comments nc where nc.node_id = ${nodes}."id"
)`;

function rowOf(n: Node, commentCount = 0): TaskRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const status =
    typeof d.status === 'string' && (TASK_STATUSES as readonly string[]).includes(d.status)
      ? (d.status as TaskStatus)
      : 'open';
  const priority =
    typeof d.priority === 'string' && (TASK_PRIORITIES as readonly string[]).includes(d.priority)
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
    todos: sanitizeTodos(d.todos),
    rank: isValidRank(d.rank) ? d.rank : null,
    commentCount,
    summary: typeof d.summary === 'string' ? d.summary : null,
    archivedAt: typeof d.archived_at === 'string' ? d.archived_at : null,
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

/** `active` = every not-done status — the natural default view now that the
 *  lifecycle has four states ('open' alone would hide in_progress/blocked). */
export type TaskStatusFilter = TaskStatus | 'all' | 'active';

type ListTasksOpts = {
  query?: string;
  status?: TaskStatusFilter;
  priority?: TaskPriority | 'all';
  tag?: string;
  /**
   * Archived tasks are excluded by default — omit this and you get live work,
   * which is what every existing caller already means. `'only'` is the archive
   * view; `'all'` is for exports and integrity checks.
   */
  archived?: 'exclude' | 'only' | 'all';
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
  if (opts.status === 'active') {
    conds.push(sql`coalesce(${nodes.data}->>'status', 'open') <> 'done'`);
  } else if (opts.status && opts.status !== 'all') {
    conds.push(sql`coalesce(${nodes.data}->>'status', 'open') = ${opts.status}`);
  }
  if (opts.priority && opts.priority !== 'all') {
    conds.push(sql`coalesce(${nodes.data}->>'priority', 'normal') = ${opts.priority}`);
  }
  // Archived tasks are hidden EVERYWHERE unless asked for. This is the single
  // door — every list, count and tool goes through `taskConds`, so a caller
  // cannot forget it. Without a default like this an archive is just a label,
  // and the board still pays to fetch a thousand finished tasks.
  if (opts.archived === 'only') {
    conds.push(sql`${nodes.data}->>'archived_at' is not null`);
  } else if (opts.archived !== 'all') {
    conds.push(sql`${nodes.data}->>'archived_at' is null`);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listTasks(
  ownerId: string,
  opts: ListTasksOpts & { limit?: number; offset?: number } = {},
): Promise<TaskRow[]> {
  // Sort by status (done last), then board rank, then due_at nulls last, then
  // updated_at desc. Rank precedes due date so a hand-ordered board keeps its
  // order in the list too; unranked tasks (rank null) keep the old behavior.
  const rows = await db
    .select({ node: nodes, commentCount: commentCountSql })
    .from(nodes)
    .where(and(...taskConds(ownerId, opts)))
    .orderBy(
      // Direction must precede the null-ordering: `<expr> asc nulls last`.
      // Don't wrap in asc()/desc() — they append the direction AFTER the
      // expression, producing the invalid `<expr> nulls last asc`.
      sql`coalesce(${nodes.data}->>'status', 'open') = 'done' asc`,
      sql`${nodes.data}->>'rank' asc nulls last`,
      sql`mantle_iso_to_ts(${nodes.data}->>'due_at') asc nulls last`,
      desc(nodes.updatedAt),
    )
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map((r) => rowOf(r.node, r.commentCount));
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
    .select({ node: nodes, commentCount: commentCountSql })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'task')))
    .limit(1);
  return row ? rowOf(row.node, row.commentCount) : null;
}

/** Caller-supplied checklist item — `id` optional (server assigns). */
export type TaskTodoInput = { id?: string; text: string; done?: boolean };

export type CreateTaskInput = {
  title: string;
  body?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueAt?: string | null;
  tags?: string[];
  /** Full checklist (replaces any existing list on update). */
  todos?: TaskTodoInput[];
  /** Board-order key; null clears it. Must match rank.ts's RANK_RE. */
  rank?: string | null;
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
    ...(input.todos?.length ? { todos: sanitizeTodos(input.todos) } : {}),
    ...(isValidRank(input.rank) ? { rank: input.rank } : {}),
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

export type UpdateTaskInput = Partial<CreateTaskInput> & {
  /**
   * ISO timestamp to archive, `null` to restore. Archiving is METADATA: it
   * deliberately does not appear in `contentChanged` below, so it never clears
   * the summary or the embedding and never queues an extractor pass. Filing a
   * thousand finished tasks away must not cost a thousand LLM calls.
   */
  archivedAt?: string | null;
};

export async function updateTask(
  ownerId: string,
  id: string,
  input: UpdateTaskInput,
): Promise<TaskRow | null> {
  const [found] = await db
    .select({ node: nodes, commentCount: commentCountSql })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'task')))
    .limit(1);
  if (!found) return null;
  const node = found.node;
  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const newData: Record<string, unknown> = { ...oldData };
  if (input.body !== undefined) newData.body = input.body;
  if (input.status !== undefined) newData.status = input.status;
  if (input.priority !== undefined) newData.priority = input.priority;
  if (input.archivedAt !== undefined) {
    if (input.archivedAt) newData.archived_at = input.archivedAt;
    else delete newData.archived_at;
  }
  if (input.dueAt !== undefined) {
    if (input.dueAt) newData.due_at = input.dueAt;
    else delete newData.due_at;
  }
  if (input.todos !== undefined) {
    const todos = sanitizeTodos(input.todos);
    if (todos.length) newData.todos = todos;
    else delete newData.todos;
  }
  if (input.rank !== undefined) {
    if (isValidRank(input.rank)) newData.rank = input.rank;
    else delete newData.rank;
  }
  // Title/body/priority/due/status/todos all matter for the summary —
  // invalidate when any of them CHANGES VALUE so the next extractor pass
  // re-summarises. Compare, don't test presence: a board drag PATCHes
  // {status, rank} with the status usually unchanged, and a presence test
  // would wipe the summary + embedding and queue an LLM pass per drag
  // (caught in review). Rank and tags deliberately never re-index (cost
  // safety); the tasks_changed trigger still repaints other tabs.
  const newTitle =
    input.title !== undefined ? input.title.trim().slice(0, 200) || 'Untitled task' : node.title;
  const contentChanged =
    newTitle !== node.title ||
    (input.body !== undefined && input.body !== (oldData.body ?? '')) ||
    (input.status !== undefined && input.status !== (oldData.status ?? 'open')) ||
    (input.priority !== undefined && input.priority !== (oldData.priority ?? 'normal')) ||
    (input.dueAt !== undefined && (input.dueAt || null) !== (oldData.due_at ?? null)) ||
    (input.todos !== undefined &&
      JSON.stringify(newData.todos ?? null) !== JSON.stringify(oldData.todos ?? null));
  if (contentChanged) {
    delete newData.summary;
    delete newData.summary_model;
    delete newData.summary_at;
    delete newData.entities;
  }
  const [updated] = await db
    .update(nodes)
    .set({
      ...(input.title !== undefined ? { title: newTitle } : {}),
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
  return rowOf(updated, found.commentCount);
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
