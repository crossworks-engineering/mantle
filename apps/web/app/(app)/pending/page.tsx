import { listPendingCalls } from '@mantle/tools';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { PendingClient } from './pending-client';

export default async function PendingPage() {
  const user = await requireOwner();
  const rows = await listPendingCalls(user.id, { limit: 200 });

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <SetPageTitle title="Pending approvals" />
      <PendingClient initialRows={rows} />
    </div>
  );
}
