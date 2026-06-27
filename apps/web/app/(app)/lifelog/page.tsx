import { Suspense } from 'react';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@/components/ui/spinner';
import { LifelogClient } from './lifelog-client';

/**
 * /lifelog — auth gate only. The list (paginated/filtered by mood/category/tag/
 * search), tag facets, and the deep-linked selected entry are client-fetched via
 * `/api/lifelog(/[id])` (Phase 2 · Task 4), keyed off the URL params which
 * `LifelogClient` reads with useSearchParams — hence the Suspense boundary.
 */
export default async function LifelogPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Life Logs" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <LifelogClient />
      </Suspense>
    </>
  );
}
