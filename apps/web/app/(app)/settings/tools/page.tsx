import { requireOwner } from '@/lib/auth';
import { listToolsForOwner } from '@/lib/tools';
import { SetPageTitle } from '@/components/layout/page-title';
import { ToolsClient } from './tools-client';

export default async function ToolsPage() {
  const user = await requireOwner();
  const rows = await listToolsForOwner(user.id);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <SetPageTitle title="Tools" />
      <ToolsClient initialTools={rows} />
    </div>
  );
}
