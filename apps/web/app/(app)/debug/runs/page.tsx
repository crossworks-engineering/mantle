import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { RunsClient } from './runs-client';

/** Debug → Runs: the read-only run view (docs/runs.md) — recent runs +
 *  per-run collapsible item tree. Data-free: RunsClient fetches
 *  GET /api/debug/runs (detached-dev safe). */
export default async function DebugRunsPage() {
  await requireOwner();
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Runs" />
      <RunsClient />
    </div>
  );
}
