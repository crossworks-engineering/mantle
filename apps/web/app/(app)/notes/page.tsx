import { Suspense } from 'react';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { Spinner } from '@/components/ui/spinner';
import { NotesClient } from './notes-client';

/**
 * /notes — auth gate only. The list (paginated/filtered), tag facets, and the
 * deep-linked selected note are client-fetched via `/api/notes(/[id])` (Phase 2
 * · Task 4), keyed off the URL params (`q`/`tag`/`digests`/`page`/`selected`/
 * `edit`) which `NotesClient` reads with useSearchParams — hence the Suspense.
 */
export default async function NotesPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Notes" />
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        }
      >
        <NotesClient />
      </Suspense>
    </>
  );
}
