import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { IntegrityClient } from './integrity-client';

export const dynamic = 'force-dynamic';

/**
 * Integrity screen. Two read-only views:
 *   • Live — the real content you add (notes, pages, files, email, …) as it
 *     lands in the brain, with its per-type footprint (summary · 768-dim
 *     embedding · facts · graph), updating live and with a per-row delete.
 *   • Corpus audit — invariant scan over the existing corpus.
 *
 * Neither writes fixtures, so nothing accumulates and leaving mid-load is safe.
 * See docs/data-flow-tracing.md for the signatures these footprints encode.
 */
export default async function IntegrityPage() {
  await requireOwner();

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Integrity" />
      <IntegrityClient />
    </div>
  );
}
