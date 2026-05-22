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

  // The active responder is whatever the runner picks: highest priority among
  // enabled rows with role='responder'. Surface it so the user can see which
  // agent is currently handling Telegram.
  const activeResponder = agents
    .filter((a) => a.enabled && a.role === 'responder')
    .sort((a, b) => b.priority - a.priority)[0];

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <SetPageTitle title="Agents" />
      <header className="space-y-1">
        {activeResponder ? (
          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            Active Telegram responder: <strong>{activeResponder.name}</strong>{' '}
            <span className="text-muted-foreground">
              ({activeResponder.model}, priority {activeResponder.priority})
            </span>
          </p>
        ) : (
          <p className="rounded-md border border-amber-400/40 bg-amber-100/30 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
            No enabled <code>responder</code> agent — Telegram messages will be received but
            unanswered until you create one below.
          </p>
        )}
      </header>

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
    </div>
  );
}
