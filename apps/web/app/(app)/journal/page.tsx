import { Suspense } from 'react';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { JournalClient } from './journal-client';

/**
 * /journal — auth gate only. The list (paginated/filtered by mood/category/tag/
 * search), tag facets, and the deep-linked selected entry are client-fetched via
 * `/api/journal(/[id])` (Phase 2 · Task 4), keyed off the URL params which
 * `JournalClient` reads with useSearchParams — hence the Suspense boundary.
 */
export default async function JournalPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Journal" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <JournalClient />
      </Suspense>
    </>
  );
}
