import { requireOwner } from '@/lib/auth';
import { DebugTabs } from './debug-tabs';
import { SetPageTitle } from '@/components/layout/page-title';
import { OverviewClient } from './overview-client';

/**
 * Debug → Overview: system health at a glance. Spend / memory / agents /
 * telegram each live on their own tab (see DebugTabs). Data-free —
 * OverviewClient fetches the whole bundle from GET /api/debug/overview.
 */
export default async function DebugOverviewPage() {
  await requireOwner();

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Debug" />
      <OverviewClient />
    </div>
  );
}
