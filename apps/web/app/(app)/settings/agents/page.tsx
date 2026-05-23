import { eq } from 'drizzle-orm';
import { db, tools } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { listAgents } from '@/lib/agents';
import { listApiKeys } from '@/lib/api-keys';
import { listSkills } from '@/lib/skills';
import { SetPageTitle } from '@/components/layout/page-title';
import { AgentsClient } from './agents-client';

export default async function AgentsSettingsPage() {
  const user = await requireOwner();
  const [agents, keys, toolRows, skillRows] = await Promise.all([
    listAgents(user.id),
    listApiKeys(user.id),
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
    listSkills(user.id),
  ]);

  return (
    <>
      <SetPageTitle title="Agents" />
      <AgentsClient
        initialAgents={agents}
        apiKeys={keys.map((k) => ({
          id: k.id,
          service: k.service,
          label: k.label,
          masked: k.masked,
        }))}
        availableTools={toolRows.map((t) => ({
          slug: t.slug,
          name: t.name,
          description: t.description,
          requiresConfirm: t.requiresConfirm,
          kind: (t.handler as { kind: string }).kind,
        }))}
        availableSkills={skillRows
          .filter((s) => s.enabled)
          .map((s) => ({
            slug: s.slug,
            name: s.name,
            description: s.description,
            toolSlugs: s.toolSlugs,
          }))}
      />
    </>
  );
}
