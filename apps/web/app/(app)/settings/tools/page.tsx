import { requireOwner } from '@/lib/auth';
import { listToolsForOwner } from '@/lib/tools';
import { loadProfilePreferences } from '@mantle/content';
import { SetPageTitle } from '@/components/layout/page-title';
import { ToolsClient } from './tools-client';

export default async function ToolsPage() {
  const user = await requireOwner();
  const [rows, prefs] = await Promise.all([
    listToolsForOwner(user.id),
    loadProfilePreferences(user.id),
  ]);

  return (
    <>
      <SetPageTitle title="Tools" />
      <ToolsClient
        initialTools={rows}
        initialRequireApproval={prefs.toolsmithRequireApproval === true}
        initialEgressGate={prefs.heartbeatEgressGate === true}
      />
    </>
  );
}
