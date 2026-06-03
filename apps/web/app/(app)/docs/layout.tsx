import { requireOwner } from '@/lib/auth';
import { getReaderNav } from '@/lib/docs-reader';
import { SetPageTitle } from '@/components/layout/page-title';
import { DocsNav } from './docs-nav';

/**
 * Shared frame for the disk-backed docs reader: a master-detail grid with the
 * collection/file navigation on the left (read from disk, works without
 * indexing) and the selected doc (or landing) on the right.
 */
export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireOwner();
  const nav = await getReaderNav(user.id);

  return (
    <>
      <SetPageTitle title="Docs" />
      <div className="md:grid md:h-full md:grid-cols-[300px_1fr] md:overflow-hidden">
        <div className="flex flex-col border-b md:h-full md:min-h-0 md:border-b-0 md:border-r">
          <DocsNav nav={nav} />
        </div>
        <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">{children}</div>
      </div>
    </>
  );
}
