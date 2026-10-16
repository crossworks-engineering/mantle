/**
 * `workspaces_list` (workspaces W7b, plan 7.4): the workspaces the caller
 * reads, each with whether the caller is a Moderator there. On the one MCP
 * surface every login has, it is how a client finds the `workspace` a create
 * may name (a create may name only a workspace its caller moderates).
 *
 * In a user's scope (an MCP call) the answer is the scope itself: the
 * workspaces it reads and the ones it moderates. Outside one (system work)
 * it is the login's own user rows.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, workspaces, workspaceUsers, liveWorkspace } from '@mantle/db';
import { currentWorkspaceScope } from '@mantle/db/viewer';
import { errorMessage } from '@mantle/std';
import type { BuiltinToolDef } from './types';
import { ownerSurfaceLoginId } from './surface';

/** One workspace as workspaces_list answers it. */
export type WorkspaceListRow = {
  id: string;
  name: string;
  description: string;
  /** The Admin workspace (the brain's settings, users and assistants). */
  admin: boolean;
  /** The caller is a Moderator here: it may create items in it and edit
   *  what it holds. */
  moderator: boolean;
};

export const workspaces_list: BuiltinToolDef = {
  slug: 'workspaces_list',
  policy: { effect: 'read', spends: 'none', scope: 'any' },
  mcpOnly: true,
  name: 'List my workspaces',
  description:
    "The workspaces you read, each with `moderator` (you may create in it and edit what it holds) and `admin` (the Admin workspace). Pass a workspace's id or name as `workspace` to a create tool (`note_create`, `page_create`, `table_create`, `app_create`, …) to put the new item there; it must be one you moderate. Without it a create lands by the usual rule (the folder's workspace, else your own private one) and the reply says where.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) => {
    try {
      const scope = currentWorkspaceScope();
      let rows: WorkspaceListRow[];
      if (scope) {
        const mod = new Set(scope.modWs);
        const found = scope.ws.length
          ? await db
              .select({
                id: workspaces.id,
                name: workspaces.name,
                description: workspaces.description,
                admin: workspaces.isAdmin,
              })
              .from(workspaces)
              .where(and(inArray(workspaces.id, [...scope.ws]), liveWorkspace()))
              .orderBy(asc(workspaces.name))
          : [];
        rows = found.map((w) => ({ ...w, moderator: mod.has(w.id) }));
      } else {
        const loginId = ownerSurfaceLoginId(ctx.surface) ?? ctx.ownerId;
        rows = await db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            description: workspaces.description,
            admin: workspaces.isAdmin,
            moderator: workspaceUsers.moderator,
          })
          .from(workspaceUsers)
          .innerJoin(workspaces, eq(workspaces.id, workspaceUsers.workspaceId))
          .where(
            and(
              eq(workspaceUsers.loginId, loginId),
              eq(workspaces.ownerId, ctx.ownerId),
              liveWorkspace(),
            ),
          )
          .orderBy(asc(workspaces.name));
      }
      return { ok: true, output: { workspaces: rows } };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const WORKSPACE_TOOLS: readonly BuiltinToolDef[] = [workspaces_list];
