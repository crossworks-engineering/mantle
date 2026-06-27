import { Suspense } from 'react';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@/components/ui/spinner';
import { TodosClient } from './todos-client';

/**
 * /todos — auth gate only. The list (paginated/filtered by status+priority) and
 * the deep-linked selected todo are client-fetched via `/api/todos(/[id])`
 * (Phase 2 · Task 4), keyed off the URL params which `TodosClient` reads with
 * useSearchParams — hence the Suspense boundary.
 */
export default async function TodosPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Todos" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <TodosClient />
      </Suspense>
    </>
  );
}
