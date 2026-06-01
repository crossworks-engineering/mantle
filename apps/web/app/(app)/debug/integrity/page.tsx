import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { SPECS } from '@/lib/integrity/spec';
import { IntegrityClient } from './integrity-client';

export const dynamic = 'force-dynamic';

/**
 * Active integrity-probe grid. Inserts one synthetic fixture per content node
 * type, waits for the extractor, and asserts the expected per-type footprint
 * landed in the brain. See docs/data-flow-tracing.md for the signatures these
 * expectations encode.
 */
export default async function IntegrityPage() {
  await requireOwner();
  // Only metadata crosses to the client — the builders/expectations stay server-side.
  const specs = SPECS.map((s) => ({
    key: s.key,
    label: s.label,
    nodeType: s.nodeType,
    pipeline: s.pipeline,
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Integrity" />
      <IntegrityClient specs={specs} />
    </div>
  );
}
