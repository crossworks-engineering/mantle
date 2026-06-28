import { Suspense } from 'react';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@/components/ui/spinner';
import { TasksClient } from './tasks-client';

/**
 * /tasks — auth gate only. The list (paginated/filtered by status+priority) and
 * the deep-linked selected task are client-fetched via `/api/tasks(/[id])`
 * (Phase 2 · Task 4), keyed off the URL params which `TasksClient` reads with
 * useSearchParams — hence the Suspense boundary.
 */
export default async function TasksPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Tasks" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <TasksClient />
      </Suspense>
    </>
  );
}
