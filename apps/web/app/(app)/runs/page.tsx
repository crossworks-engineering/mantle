import { Suspense } from 'react';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { RunsClient } from './runs-client';

/**
 * /runs — the durable-run surface (docs/runs.md): a master-detail view of the
 * owner's runs. Auth gate only; the list + compiled-tree detail are
 * client-fetched via `GET /api/runs` (and `/api/runs/:id`), keyed off the URL
 * params (`run` = selected id, `page`) which `RunsClient` reads with
 * useSearchParams — hence the Suspense boundary. Data-free page keeps it
 * detached-dev safe (the /pages pattern). Promoted from /debug/runs in slice 4.
 */
export default async function RunsPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Runs" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <RunsClient />
      </Suspense>
    </>
  );
}
