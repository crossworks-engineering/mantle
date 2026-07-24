import { Suspense } from 'react';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { EventsClient } from './events-client';

/**
 * /events — auth gate only. The list (paginated, filtered by window + search)
 * is client-fetched via `GET /api/events` (Phase 2 · Task 4), keyed off the URL
 * params (`q`/`window`/`page`) which `EventsClient` reads with useSearchParams
 * (via useListNav) — hence the Suspense boundary.
 */
export default async function EventsPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Events" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <EventsClient />
      </Suspense>
    </>
  );
}
