import { requireOwner } from '@/lib/auth';
import { listDocCollections } from '@mantle/files';
import { formatInProfile, loadProfilePreferences } from '@mantle/content';
import { getReaderNav } from '@/lib/docs-reader';
import { DocumentationClient } from './documentation-client';

/**
 * Docs landing: read docs from the left sidebar; this pane is the single place to
 * manage indexing — enable/disable a collection for the brain and add new ones.
 * (Consolidated here from the former /settings/documentation page.)
 */
export default async function DocsLanding() {
  const user = await requireOwner();
  const [cols, prefs, nav] = await Promise.all([
    listDocCollections(user.id),
    loadProfilePreferences(user.id),
    getReaderNav(user.id),
  ]);

  // Pre-format "last synced" server-side (profile tz/locale) — avoids the
  // toLocaleString hydration mismatch. Keyed by collection id.
  const formattedReconciled: Record<string, string | null> = {};
  for (const c of cols) {
    formattedReconciled[c.id] = c.lastReconciledAt ? formatInProfile(c.lastReconciledAt, prefs) : null;
  }

  // First readable doc per collection (key → /docs URL) for a per-row "Open" link.
  const firstDocHref: Record<string, string | null> = {};
  for (const c of nav) {
    const first = c.files[0];
    firstDocHref[c.key] = first
      ? `/docs/${encodeURIComponent(c.key)}/${first.split('/').map(encodeURIComponent).join('/')}`
      : null;
  }

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Documentation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse and read the docs from the list on the left. Below, manage which collections are
          indexed into the brain so the assistant can search them.
        </p>
      </div>
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
        firstDocHref={firstDocHref}
      />
    </div>
  );
}
