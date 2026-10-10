/**
 * Builtins: access_get / access_set, owner-side only. A brain item has no
 * level any more (workspaces W5b2): access_get answers its grants (the
 * workspaces that read it), and access_set refuses an item, since grants are
 * set in its Grant Access panel. Agents and tool groups keep their levels
 * (admin > team > client > public) until W7 (contract change 21).
 */
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq } from 'drizzle-orm';
import { agents, db, isViewerLevel, itemGrants, nodes, toolGroups, workspaces } from '@mantle/db';
import {
  AccessError,
  contactSharesForNode,
  setAgentAudience,
  setToolGroupAudience,
} from '@mantle/content';
import { errorMessage } from '@mantle/std';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { str, strOpt } from './coerce';
import { NODE_ID_PRE } from './builtins-common';
import { isOwnerSurface, keyOrPeerVia, OPENS_ADMIN_ONLY } from './surface';
import { queueAgentCallForApproval } from './pending-queue';

const LEVELS = ['admin', 'team', 'client', 'public'];
const RANK: Record<string, number> = { public: 0, client: 1, team: 2, admin: 3 };

/** access_set's answer for a brain item. */
export const ITEM_LEVEL_GONE =
  'Brain items have no sharing level any more: the workspaces that read an item are its grants. ' +
  "Use Grant Access (the item's Grant Access panel) to add or remove a workspace.";

/** One grant row of an item, as access_get answers it. */
export type AccessGrantRow = {
  workspace: string;
  write: boolean;
  /** The folder this row comes from (it follows that folder), or null. */
  viaFolder: string | null;
  /** "Removed here": the folder grants the workspace, this item does not. */
  removedHere: boolean;
};

/** An item's grants: its home workspace and every row, home first. */
async function itemGrantsOf(
  nodeId: string,
): Promise<{ home: string | null; grants: AccessGrantRow[] }> {
  const folder = alias(nodes, 'via_folder');
  const rows = await db
    .select({
      workspace: workspaces.name,
      write: itemGrants.write,
      isHome: itemGrants.isHome,
      excluded: itemGrants.excluded,
      viaFolder: folder.title,
    })
    .from(itemGrants)
    .innerJoin(workspaces, eq(workspaces.id, itemGrants.workspaceId))
    .leftJoin(folder, eq(folder.id, itemGrants.viaFolderId))
    .where(eq(itemGrants.nodeId, nodeId))
    .orderBy(desc(itemGrants.isHome), asc(workspaces.name));
  return {
    home: rows.find((r) => r.isHome)?.workspace ?? null,
    grants: rows.map((r) => ({
      workspace: r.workspace,
      write: r.write,
      viaFolder: r.viaFolder ?? null,
      removedHere: r.excluded,
    })),
  };
}

function ownerOnly(ctx: ToolHandlerContext): ToolHandlerResult | null {
  if (!isOwnerSurface(ctx.surface)) {
    return {
      ok: false,
      error: 'access_get / access_set are owner-side only: ask the owner to change a level.',
    };
  }
  return null;
}

export const access_get: BuiltinToolDef = {
  slug: 'access_get',
  ownerOnly: true,
  readOnly: true,
  preconditions: NODE_ID_PRE,
  name: 'Get who can read an item, or an access level',
  description:
    "For a brain item: its grants, the workspaces that read it (`home`: the workspace it lives in; `grants`: one row per workspace with `write`, `viaFolder` (the folder the row follows, or null) and `removedHere` (the folder grants that workspace, this item does not)), and the contacts it is shared with. Items have no level any more; grants are changed in the item's Grant Access panel. For an agent or a tool group: its level (admin, team, client or public).",
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description: 'a brain item id (page, file, folder, …)',
      },
      agent_slug: { type: 'string', description: "an agent's slug, e.g. 'team-responder'" },
      tool_group_slug: { type: 'string', description: "a tool group's slug, e.g. 'team-read'" },
    },
  },
  handler: async (input, ctx) => {
    const refused = ownerOnly(ctx);
    if (refused) return refused;
    try {
      const nodeId = strOpt(input.node_id);
      const agentSlug = strOpt(input.agent_slug);
      const groupSlug = strOpt(input.tool_group_slug);
      if (nodeId) {
        const [row] = await db
          .select({ id: nodes.id, type: nodes.type, title: nodes.title })
          .from(nodes)
          .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ctx.ownerId)))
          .limit(1);
        if (!row) return { ok: false, error: 'item not found: find its id with search_nodes' };
        const [{ home, grants }, contactShares] = await Promise.all([
          itemGrantsOf(nodeId),
          contactSharesForNode(ctx.ownerId, nodeId),
        ]);
        return {
          ok: true,
          output: {
            item: row,
            home,
            grants,
            // Contact shares (0214), read only: who it is shared with, by
            // name and right. No tool makes one (v1).
            ...(contactShares.length
              ? {
                  contactShares: contactShares.map((c) => ({
                    contactId: c.contactId,
                    name: c.name,
                    canWrite: c.canWrite,
                    lastOpenedAt: c.lastOpenedAt,
                  })),
                }
              : {}),
          },
        };
      }
      if (agentSlug) {
        const [row] = await db
          .select({ slug: agents.slug, audience: agents.audience, groups: agents.toolGroupSlugs })
          .from(agents)
          .where(and(eq(agents.ownerId, ctx.ownerId), eq(agents.slug, agentSlug)))
          .limit(1);
        if (!row)
          return { ok: false, error: `agent '${agentSlug}' not found: list them with agent_list` };
        return { ok: true, output: { agent: row } };
      }
      if (groupSlug) {
        const [row] = await db
          .select({ slug: toolGroups.slug, audience: toolGroups.audience })
          .from(toolGroups)
          .where(and(eq(toolGroups.ownerId, ctx.ownerId), eq(toolGroups.slug, groupSlug)))
          .limit(1);
        if (!row)
          return {
            ok: false,
            error: `tool group '${groupSlug}' not found: list them with tool_group_list`,
          };
        return { ok: true, output: { tool_group: row } };
      }
      return { ok: false, error: 'pass one of node_id, agent_slug or tool_group_slug' };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const access_set: BuiltinToolDef = {
  slug: 'access_set',
  ownerOnly: true,
  preconditions: NODE_ID_PRE,
  name: 'Set an access level',
  description:
    'Set the level of an agent or a tool group: admin (default), team, client or public. A brain item has no level any more: refused, with a pointer to its Grant Access panel (see access_get for who reads it).',
  inputSchema: {
    type: 'object',
    properties: {
      node_id: { type: 'string', format: 'uuid', description: 'a brain item id (refused)' },
      agent_slug: { type: 'string', description: "an agent's slug, e.g. 'team-responder'" },
      tool_group_slug: { type: 'string', description: "a tool group's slug, e.g. 'team-read'" },
      level: { type: 'string', enum: LEVELS, description: 'the new level' },
      drop_groups_above: {
        type: 'boolean',
        default: false,
        description:
          "agents only: also take off the agent the tool groups above the new level (listed in `removedGroups`); without it such an agent is refused. Opening the team responder: agent_slug 'team-responder', level 'team', drop_groups_above true",
      },
    },
    required: ['level'],
  },
  handler: async (input, ctx) => {
    const refused = ownerOnly(ctx);
    if (refused) return refused;
    if (strOpt(input.node_id)) return { ok: false, error: ITEM_LEVEL_GONE };
    const level = str(input.level).trim();
    if (!isViewerLevel(level))
      return { ok: false, error: `level must be one of ${LEVELS.join(', ')}` };
    try {
      const agentSlug = strOpt(input.agent_slug);
      const groupSlug = strOpt(input.tool_group_slug);
      if (agentSlug) {
        const [row] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.ownerId, ctx.ownerId), eq(agents.slug, agentSlug)))
          .limit(1);
        if (!row)
          return { ok: false, error: `agent '${agentSlug}' not found: list them with agent_list` };
        const res = await setAgentAudience(ctx.ownerId, row.id, level, {
          dropGroupsAbove: input.drop_groups_above === true,
        });
        ctx.step?.setOutput({ agent: agentSlug, level, removedGroups: res.removedGroups });
        return { ok: true, output: { agent: res } };
      }
      if (groupSlug) {
        // Lowering a connector opens every tool in it (and the outside data
        // behind them) to members, clients or links at once: an in-brain
        // agent never does that on its own say-so, it waits for the owner
        // (M4 audit, medium 1; the same rule as one tool's switch, N5). On
        // approval the call runs again with no agent context.
        if (ctx.agent || keyOrPeerVia(ctx)) {
          const [g] = await db
            .select({ audience: toolGroups.audience, integration: toolGroups.integration })
            .from(toolGroups)
            .where(and(eq(toolGroups.ownerId, ctx.ownerId), eq(toolGroups.slug, groupSlug)))
            .limit(1);
          const from = g?.audience ?? 'admin';
          if (g?.integration?.mcp && (RANK[level] ?? 0) < (RANK[from] ?? 3) && !ctx.agent) {
            // An API key or a peer acting as the owner (access matrix T9).
            return {
              ok: false,
              error: `'${groupSlug}' is a connector: lowering it from ${from} to ${level} opens all its tools below admin, which ${OPENS_ADMIN_ONLY}`,
            };
          }
          if (g?.integration?.mcp && (RANK[level] ?? 0) < (RANK[from] ?? 3) && ctx.agent) {
            return queueAgentCallForApproval(
              { ...ctx, agent: ctx.agent },
              'access_set',
              { tool_group_slug: groupSlug, level },
              `'${groupSlug}' is a connector: lowering it from ${from} to ${level} opens all its tools below admin, so it needs the owner's approval.`,
            );
          }
        }
        const res = await setToolGroupAudience(ctx.ownerId, groupSlug, level);
        ctx.step?.setOutput({ tool_group: groupSlug, level });
        return { ok: true, output: { tool_group: res } };
      }
      return { ok: false, error: 'pass one of node_id, agent_slug or tool_group_slug' };
    } catch (err) {
      if (err instanceof AccessError) return { ok: false, error: err.message };
      return { ok: false, error: errorMessage(err) };
    }
  },
};

/** The owner's access levers. */
export const ACCESS_TOOLS: readonly BuiltinToolDef[] = [access_get, access_set];
