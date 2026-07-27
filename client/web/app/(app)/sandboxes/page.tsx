import { Suspense } from 'react';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { SandboxesClient } from './sandboxes-client';

/**
 * /sandboxes — the CLI-sandboxes surface: a master-detail view of the owner's
 * persistent sandbox containers (docs: packages/db/src/schema/sandboxes.ts).
 * Auth gate only; the list + per-sandbox command history are client-fetched
 * via `GET /api/sandboxes` (and `/api/sandboxes/:id`), keyed off the URL
 * params (`sandbox` = selected id) which `SandboxesClient` reads with
 * useSearchParams — hence the Suspense boundary. Data-free page keeps it
 * detached-dev safe (the /runs pattern).
 */
export default async function SandboxesPage() {
  return (
    <>
      <SetPageTitle title="Sandboxes" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <SandboxesClient />
      </Suspense>
    </>
  );
}
