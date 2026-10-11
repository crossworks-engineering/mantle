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
import { agents, db, workspaceResources, workspaceUsers, workspaces } from '@mantle/db';

/** The assistant, and the Team workspace it answers in. */
export type TeamAssistant = { id: string; slug: string; name: string; workspaceId: string };

/** The enabled assistant of the brain's live Team workspace, or null. */
export async function teamAssistant(ownerId: string): Promise<TeamAssistant | null> {
  const [row] = await db
    .select({ id: agents.id, slug: agents.slug, name: agents.name, workspaceId: workspaces.id })
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

/** An assistant a workspace holds, and whether that workspace is Admin. */
export type WorkspaceAssistant = TeamAssistant & { isAdmin: boolean };

/**
 * The enabled assistants of the brain's live workspaces (workspaces W7c):
 * each workspace's assistant resource. With `loginId`, only those of the
 * workspaces that login is a user of: the assistants it may chat with, each
 * in its own thread. Read on the system pool (the caller names the login).
 */
export async function workspaceAssistants(
  ownerId: string,
  loginId?: string,
): Promise<WorkspaceAssistant[]> {
  const rows = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      name: agents.name,
      workspaceId: workspaces.id,
      isAdmin: workspaces.isAdmin,
    })
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
        isNull(workspaces.archivedAt),
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        // The assistant answers in the workspace that holds it.
        sql`${agents.workspaceId} = ${workspaces.id}`,
        ...(loginId
          ? [
              sql`exists (select 1 from ${workspaceUsers} wu
                           where wu.workspace_id = ${workspaces.id} and wu.login_id = ${loginId})`,
            ]
          : []),
      ),
    )
    .orderBy(sql`${workspaces.isAdmin} desc`, workspaces.name);
  return rows;
}

/** The assistant a login names by slug, if a workspace it is a user of holds
 *  it (null otherwise: the login may not chat with it). */
export async function workspaceAssistantFor(
  ownerId: string,
  loginId: string,
  slug: string,
): Promise<WorkspaceAssistant | null> {
  return (await workspaceAssistants(ownerId, loginId)).find((a) => a.slug === slug) ?? null;
}
