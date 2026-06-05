import { eq } from 'drizzle-orm';
import { db, tools } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { listToolGroups, listToolGroupBackrefs } from '@/lib/tool-groups';
import { SetPageTitle } from '@/components/layout/page-title';
import { ToolGroupsClient } from './tool-groups-client';

export default async function ToolGroupsPage() {
  const user = await requireOwner();
  const [groups, toolRows, backrefs] = await Promise.all([
    listToolGroups(user.id),
    db
      .select({
        slug: tools.slug,
        name: tools.name,
        description: tools.description,
        requiresConfirm: tools.requiresConfirm,
        handler: tools.handler,
      })
      .from(tools)
      .where(eq(tools.ownerId, user.id))
      .orderBy(tools.slug),
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
