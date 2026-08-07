import { Suspense } from 'react';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { DrawsClient } from './draws-client';

/**
 * /draw — the whiteboard workspace (auth gate only). The list, tag facets and
 * pagination are client-fetched via `GET /api/draws`, keyed off the URL params
 * which `DrawsClient` reads with useSearchParams — hence the Suspense
 * boundary. The editor lives at /draw/[id]; browsing the list never loads the
 * canvas chunk.
 */
export default async function DrawPage() {
  return (
    <>
      <SetPageTitle title="Draw" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <DrawsClient />
      </Suspense>
    </>
  );
}
