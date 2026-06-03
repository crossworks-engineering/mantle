import { requireOwner } from '@/lib/auth';
import { listDocCollections } from '@mantle/files';
import { SetPageTitle } from '@/components/layout/page-title';
import { DocumentationClient } from './documentation-client';

export default async function DocumentationSettingsPage() {
  const user = await requireOwner();
  const cols = await listDocCollections(user.id);

  return (
    <>
      <SetPageTitle title="Documentation" />
      <DocumentationClient
        initial={cols.map((c) => ({
          id: c.id,
          key: c.key,
          label: c.label,
          origin: c.origin,
          brainDepth: c.brainDepth,
          enabled: c.enabled,
          lastReconciledAt: c.lastReconciledAt ? c.lastReconciledAt.toISOString() : null,
        }))}
      />
    </>
  );
}
