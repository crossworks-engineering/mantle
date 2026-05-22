import { requireOwner } from '@/lib/auth';
import { listTodos } from '@/lib/todos';
import { SetPageTitle } from '@/components/layout/page-title';
import { TodosClient } from './todos-client';

export default async function TodosPage() {
  const user = await requireOwner();
  const rows = await listTodos(user.id);
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <SetPageTitle title="Todos" />
      <TodosClient initialTodos={rows} />
    </div>
  );
}
