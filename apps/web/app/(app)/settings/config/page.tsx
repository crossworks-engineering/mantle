import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { computeConfigDiff } from '@/lib/system-manifest/config-diff-db';
import { ConfigClient } from './config-client';

export const dynamic = 'force-dynamic';

/**
 * Config sanity checker (read-only). Diffs the brain's live agent/skill/tool-
 * group/worker config against the shipped manifest template, anchored on the
 * effective persona, and shows per-item what is OK / missing / modified / added.
 * Adopting changes from the template lands in a later update — this cut is the
 * visibility layer. See lib/system-manifest/config-diff.ts.
 */
export default async function ConfigPage() {
  const user = await requireOwner();
  const report = await computeConfigDiff(user.id);
  return (
    <>
      <SetPageTitle title="Config" />
      <ConfigClient report={report} />
    </>
  );
}
