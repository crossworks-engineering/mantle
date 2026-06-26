import { requireOwner } from '@/lib/auth';
import { listToolGroups, listToolGroupBackrefs } from '@/lib/tool-groups';
import { listToolsForOwner } from '@/lib/tools';
import { SetPageTitle } from '@/components/layout/page-title';
import { ToolGroupsClient } from './tool-groups-client';

export default async function ToolGroupsPage() {
  const user = await requireOwner();
  const [groups, toolRows, backrefs] = await Promise.all([
    listToolGroups(user.id),
    listToolsForOwner(user.id),
    listToolGroupBackrefs(user.id),
  ]);
  // Map → plain object for the client boundary, and attach the fan-out.
  const backrefsRecord: Record<string, string[]> = {};
  for (const [k, v] of backrefs.entries()) backrefsRecord[k] = v;

  return (
    <>
      <SetPageTitle title="Tool groups" />
      <ToolGroupsClient
        initialGroups={groups}
        availableTools={toolRows.map((t) => ({
          slug: t.slug,
          name: t.name,
          description: t.description,
          requiresConfirm: t.requiresConfirm,
          kind: (t.handler as { kind: string }).kind,
        }))}
        grantedTo={backrefsRecord}
      />
    </>
  );
}
