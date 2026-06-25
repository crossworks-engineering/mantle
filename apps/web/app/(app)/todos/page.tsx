import { requireOwner } from '@/lib/auth';
import { listTodos, countTodos, getTodo, type TodoStatus, type TodoPriority } from '@/lib/todos';
import { SetPageTitle } from '@/components/layout/page-title';
import { TodosClient } from './todos-client';

const PAGE_SIZE = 50;

export default async function TodosPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; status?: string; priority?: string; selected?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || undefined;
  const status = (sp.status?.trim() || 'open') as TodoStatus | 'all';
  const priority = (sp.priority?.trim() || 'all') as TodoPriority | 'all';
  const selectedId = sp.selected?.trim() || null;
  const opts = { query, status, priority };

  const [rows, total] = await Promise.all([
    listTodos(user.id, { ...opts, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countTodos(user.id, opts),
  ]);

  // Deep-link (`?selected=`, e.g. from `/n/<id>`) may point at a todo outside
  // this page slice or filtered out by the current status — fetch it directly
  // so the detail pane can still open it.
  const initialSelectedTodo =
    selectedId && !rows.some((r) => r.id === selectedId) ? await getTodo(user.id, selectedId) : null;

  return (
    <>
      <SetPageTitle title="Todos" />
      <TodosClient
        initialTodos={rows}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        query={query ?? ''}
        status={status}
        priority={priority}
        initialSelectedId={selectedId}
        initialSelectedTodo={initialSelectedTodo}
      />
    </>
  );
}
