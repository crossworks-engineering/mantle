/**
 * The assistants a login chats with: each workspace's
 * assistant, its workspace_resources row of type 'assistant'. No agent
 * level is read: who answers in a workspace is a resource of that
 * workspace, set on the workspace page, never the agent's own level.
 *
 * Team is a normal workspace (0286) and a new brain has none: a member's
 * chat with no assistant named goes to the assistant of the login's oldest
 * workspace beyond Admin that has one (defaultWorkspaceAssistant), which is
 * Team's on a brain that has a Team workspace.
 *
 * Read on the system pool, before any turn scope is entered.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  agents,
  db,
  workspaceResources,
  workspaceUsers,
  workspaces,
  liveWorkspace,
} from '@mantle/db';

/** An assistant a workspace holds, the workspace, and whether it is Admin. */
export type WorkspaceAssistant = {
  id: string;
  slug: string;
  name: string;
  workspaceId: string;
  isAdmin: boolean;
};

/**
 * The enabled assistants of the brain's live workspaces:
 * each workspace's assistant resource, Admin's first, then by the age of
 * their workspace (oldest first), then by name. With `loginId`, only those
 * of the workspaces that login is a user of: the assistants it may chat
 * with, each in its own thread. Read on the system pool (the caller names
 * the login).
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
        liveWorkspace(),
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
    .orderBy(sql`${workspaces.isAdmin} desc`, workspaces.createdAt, workspaces.name);
  return rows;
}

/**
 * The assistant a login's chat goes to when it names none, and the one its
 * notices land with: the first assistant of its workspaces beyond Admin
 * (the oldest workspace first, workspaceAssistants), or null when it is in
 * none with an enabled assistant. ONE rule for the member chat engine, the
 * chat routes and the key notices: no workspace is special.
 */
export async function defaultWorkspaceAssistant(
  ownerId: string,
  loginId: string,
): Promise<WorkspaceAssistant | null> {
  return (await workspaceAssistants(ownerId, loginId)).find((a) => !a.isAdmin) ?? null;
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
