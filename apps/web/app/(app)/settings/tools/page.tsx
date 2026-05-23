import { requireOwner } from '@/lib/auth';
import { listToolsForOwner } from '@/lib/tools';
import { SetPageTitle } from '@/components/layout/page-title';
import { ToolsClient } from './tools-client';

export default async function ToolsPage() {
  const user = await requireOwner();
  const rows = await listToolsForOwner(user.id);

  return (
    <>
      <SetPageTitle title="Tools" />
      <ToolsClient initialTools={rows} />
    </>
  );
}
