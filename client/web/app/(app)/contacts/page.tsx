import { Suspense } from 'react';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { ContactsClient } from './contacts-client';

/**
 * /contacts — master-detail (auth gate only). The contact list IS the email
 * allowlist. The list (paginated/searched) and the selected contact are
 * client-fetched via `/api/contacts(/[id])` (Phase 2 · Task 4), keyed off the
 * URL (`q`/`page`/`id`) which `ContactsClient` reads via useListNav/useSearchParams
 * — hence the Suspense boundary.
 */
export default async function ContactsPage() {
  return (
    <>
      <SetPageTitle title="Contacts" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <ContactsClient />
      </Suspense>
    </>
  );
}
