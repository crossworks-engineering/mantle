import { Suspense } from 'react';
import { requireOwner } from '@/lib/auth';
import { Spinner } from '@/components/ui/spinner';
import { FilesClient } from './files-client';

/**
 * Files: data-free. FilesClient fetches the folder tree + the current folder's
 * files from the /api/files endpoints, resolves the `?path` param against the
 * tree, and derives the current folder — no SSR DB read. (The root branch is
 * ensured by those GET handlers.) Wrapped in Suspense because the client reads
 * `useSearchParams`.
 */
export default async function FilesPage() {
  await requireOwner();
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <FilesClient />
    </Suspense>
  );
}
