import { requireOwner } from '@/lib/auth';
import { listDocCollections } from '@mantle/files';
import { formatInProfile, loadProfilePreferences } from '@mantle/content';
import { SetPageTitle } from '@/components/layout/page-title';
import { DocumentationClient } from './documentation-client';

export default async function DocumentationSettingsPage() {
  const user = await requireOwner();
  const [cols, prefs] = await Promise.all([
    listDocCollections(user.id),
    loadProfilePreferences(user.id),
  ]);

  // Pre-format the "last synced" timestamp server-side using the user's profile
  // tz + locale. Critical: formatting on the client via toLocaleString() yields a
  // different string than the Node SSR pass (different tz/locale defaults), which
  // trips React's hydration check. Same pattern as /settings/heartbeats.
  const formattedReconciled: Record<string, string | null> = {};
  for (const c of cols) {
    formattedReconciled[c.id] = c.lastReconciledAt ? formatInProfile(c.lastReconciledAt, prefs) : null;
  }

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
        formattedReconciled={formattedReconciled}
      />
    </>
  );
}
