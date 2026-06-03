import { requireOwner } from '@/lib/auth';
import { listDocs } from '@/lib/docs';
import { SetPageTitle } from '@/components/layout/page-title';
import { DocsClient } from './docs-client';

export default async function DocsPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string }>;
}) {
  const user = await requireOwner();
  const sp = await searchParams;
  const docs = await listDocs(user.id);

  return (
    <>
      <SetPageTitle title="Docs" />
      <DocsClient docs={docs} initialSelectedId={sp.selected?.trim() || null} />
    </>
  );
}
