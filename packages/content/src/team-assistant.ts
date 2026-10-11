/**
 * The assistant a member chats with (workspaces W5c): the one attached to the
 * brain's Team workspace (bridge_key 'team'), as its workspace_resources row
 * of type 'assistant'. No agent level is read: who answers the team is a
 * resource of the Team workspace, set on the workspace page, never the
 * agent's own level. A brain with no live Team workspace, or a Team with no
 * assistant (or a disabled one), has no member chat.
 *
 * Read on the system pool, before any turn scope is entered.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { agents, db, workspaceResources, workspaces } from '@mantle/db';

export type TeamAssistant = { id: string; slug: string; name: string };

/** The enabled assistant of the brain's live Team workspace, or null. */
export async function teamAssistant(ownerId: string): Promise<TeamAssistant | null> {
  const [row] = await db
    .select({ id: agents.id, slug: agents.slug, name: agents.name })
    .from(workspaces)
    .innerJoin(
      workspaceResources,
      and(
        eq(workspaceResources.workspaceId, workspaces.id),
        eq(workspaceResources.type, 'assistant'),
      ),
    )
    .innerJoin(agents, sql`${agents.id}::text = ${workspaceResources.refId}`)
    .where(
      and(
        eq(workspaces.ownerId, ownerId),
        eq(workspaces.bridgeKey, 'team'),
        isNull(workspaces.archivedAt),
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
      ),
    )
    .limit(1);
  return row ?? null;
}
