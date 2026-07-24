import { Suspense } from 'react';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { SetPageTitle } from '@/components/layout/page-title';
import { InboxClient } from './inbox-client';

/**
 * Inbox — data-free server shell. Auth stays server-side; all reads happen
 * client-side in `InboxClient` (TanStack Query against `/api/email/**`), so the
 * 3-pane mail client is renderable by a detached client with no in-process DB
 * access. Wrapped in `<Suspense>` because `InboxClient` reads `useSearchParams`.
 */
export default async function InboxPage() {
  return (
    <>
      <SetPageTitle title="Inbox" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center py-16">
            <Spinner />
          </div>
        }
      >
        <InboxClient />
      </Suspense>
    </>
  );
}
