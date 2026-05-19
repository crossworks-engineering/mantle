/**
 * Todos surface. A todo is a `nodes` row with type='task':
 *
 *   nodes.title       short imperative
 *   nodes.data.body   freeform notes (extractor reads this)
 *   nodes.data.status 'open' | 'done'
 *   nodes.data.priority 'low' | 'normal' | 'high'
 *   nodes.data.due_at ISO timestamp (optional)
 *
 * Under the `todos` ltree root. Lazy-created on first write. The
 * extractor's special case in apps/agent/src/extractor.ts:readNodeBodyRaw
 * surfaces status + priority + due_at into the body it summarises.
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, nodes, type Node } from '@mantle/db';

export const TODOS_ROOT_LABEL = 'todos';
export const TODO_STATUSES = ['open', 'done'] as const;
export const TODO_PRIORITIES = ['low', 'normal', 'high'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

export type TodoRow = {
  id: string;
  title: string;
  body: string;
  status: TodoStatus;
  priority: TodoPriority;
  dueAt: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowOf(n: Node): TodoRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const status =
    typeof d.status === 'string' && (TODO_STATUSES as readonly string[]).includes(d.status)
      ? (d.status as TodoStatus)
      : 'open';
  const priority =
    typeof d.priority === 'string' &&
    (TODO_PRIORITIES as readonly string[]).includes(d.priority)
      ? (d.priority as TodoPriority)
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
      title: 'Todos',
      slug: TODOS_ROOT_LABEL,
      path: TODOS_ROOT_LABEL,
      data: { description: 'Tasks and todos.' },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

export async function listTodos(
  ownerId: string,
  opts: { query?: string; status?: TodoStatus | 'all'; priority?: TodoPriority | 'all'; tag?: string } = {},
): Promise<TodoRow[]> {
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
  // Sort by status (open first), then by due_at nulls last, then by updated_at desc.
  const rows = await db
    .select()
    .from(nodes)
    .where(and(...conds))
    .orderBy(
      asc(sql`coalesce(${nodes.data}->>'status', 'open') = 'done'`),
      asc(sql`mantle_iso_to_ts(${nodes.data}->>'due_at') nulls last`),
      desc(nodes.updatedAt),
    )
    .limit(500);
  return rows.map(rowOf);
}

export async function getTodo(ownerId: string, id: string): Promise<TodoRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'task')))
    .limit(1);
  return row ? rowOf(row) : null;
}

export type CreateTodoInput = {
  title: string;
  body?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  dueAt?: string | null;
  tags?: string[];
};

export async function createTodo(ownerId: string, input: CreateTodoInput): Promise<TodoRow> {
  await ensureRoot(ownerId);
  const data: Record<string, unknown> = {
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
      path: TODOS_ROOT_LABEL,
      data,
      tags: dedupeTags(input.tags ?? []),
    })
    .returning();
  if (!row) throw new Error('createTodo: insert returned no row');
  return rowOf(row);
}

export type UpdateTodoInput = Partial<CreateTodoInput>;

export async function updateTodo(
  ownerId: string,
  id: string,
  input: UpdateTodoInput,
): Promise<TodoRow | null> {
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
  if (!updated) throw new Error('updateTodo: update returned no row');
  if (contentChanged) {
    await db.execute(sql`SELECT pg_notify('node_ingested', ${id}::text)`);
  }
  return rowOf(updated);
}

export async function deleteTodo(ownerId: string, id: string): Promise<boolean> {
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
