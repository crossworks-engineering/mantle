import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { SpendClient } from './spend-client';

/** Debug → Spend: token spend by model and by agent (7d). Data-free —
 *  SpendClient fetches GET /api/debug/spend. */
export default async function DebugSpendPage() {
  await requireOwner();

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Spend" />
      <SpendClient />
    </div>
  );
}
