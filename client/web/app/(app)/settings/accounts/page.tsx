import { Suspense } from 'react';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { AccountsClient } from './accounts-client';

/**
 * /settings/accounts — IMAP email accounts (auth gate only). The account list,
 * the live folder tree, and the add/edit/folders forms are all client-fetched
 * via `/api/email/accounts/**` (Phase 2 · Task 4). Master-detail is still
 * URL-driven (`?selected=&mode=`), read client-side via useSearchParams (hence
 * the Suspense boundary).
 */
export default async function AccountsSettingsPage() {
  return (
    <>
      <SetPageTitle title="Email accounts" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <AccountsClient />
      </Suspense>
    </>
  );
}
