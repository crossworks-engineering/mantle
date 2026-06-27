import { Suspense } from 'react';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@/components/ui/spinner';
import { PagesClient } from './pages-client';

/**
 * /pages — rich-document KB (auth gate only). The list/tree, tag facets, and
 * pagination are client-fetched via `GET /api/pages` (Phase 2 · Task 4), keyed
 * off the URL params (`q`/`tag`/`sort`/`page`) which `PagesClient` reads with
 * useSearchParams — hence the Suspense boundary.
 */
export default async function PagesPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Pages" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <PagesClient />
      </Suspense>
    </>
  );
}
