/**
 * Builtins: access_get / access_set, owner-side only. A brain item has no
 * level any more (workspaces W5b2): access_get answers its grants (the
 * workspaces that read it), and access_set refuses an item, since grants are
 * set in its Grant Access panel. Agents and tool groups have no level either
 * since workspaces W7b: an assistant reads its workspace, and a tool group is
 * system-wide or Admin only (the manifest's adminOnly groups).
 */
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, itemGrants, nodes, workspaces } from '@mantle/db';
import { contactSharesForNode } from '@mantle/content';
import { errorMessage } from '@mantle/std';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { strOpt } from './coerce';
import { NODE_ID_PRE } from './builtins-common';
import { isOwnerSurface } from './surface';
import { manage } from './item-write-gate';
import { lowersAccessSet } from './client-sourced';

/** access_set's answer for a brain item. */
export const ITEM_LEVEL_GONE =
  'Brain items have no sharing level any more: the workspaces that read an item are its grants. ' +
  "Use Grant Access (the item's Grant Access panel) to add or remove a workspace.";

/** access_set's answer for an agent or a tool group (workspaces W7b). */
export const AGENT_LEVEL_GONE =
  'Agents and tool groups have no level any more: an assistant reads the workspace it answers in, ' +
  'and a tool group is either system-wide or Admin only. Change who uses an assistant on its workspace screen.';

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
  policy: { effect: 'read', spends: 'none', scope: 'admin' },
  ownerOnly: true,
  preconditions: NODE_ID_PRE,
  name: 'Get who can read an item, or an access level',
  description:
    "For a brain item: its grants, the workspaces that read it (`home`: the workspace it lives in; `grants`: one row per workspace with `write`, `viaFolder` (the folder the row follows, or null) and `removedHere` (the folder grants that workspace, this item does not)), and the contacts it is shared with. Items have no level any more; grants are changed in the item's Grant Access panel.",
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description: 'a brain item id (page, file, folder, …)',
      },
    },
  },
  handler: async (input, ctx) => {
    const refused = ownerOnly(ctx);
    if (refused) return refused;
    try {
      const nodeId = strOpt(input.node_id);
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
      return { ok: false, error: 'node_id is required: find the item with search_nodes' };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const access_set: BuiltinToolDef = {
  slug: 'access_set',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: 'admin',
    items: [manage('node_id')],
    peerRisky: true,
    lowering: lowersAccessSet,
  },
  ownerOnly: true,
  preconditions: NODE_ID_PRE,
  name: 'Set an access level (retired)',
  description:
    "Retired: nothing has a level any more. A brain item's readers are its grants (its Grant Access panel; see `access_get`), an assistant reads the workspace it answers in, and a tool group is system-wide or Admin only. Answers how to make the change instead.",
  inputSchema: {
    type: 'object',
    properties: {
      node_id: { type: 'string', format: 'uuid', description: 'a brain item id (refused)' },
    },
  },
  handler: async (input, ctx) => {
    const refused = ownerOnly(ctx);
    if (refused) return refused;
    if (strOpt(input.node_id)) return { ok: false, error: ITEM_LEVEL_GONE };
    return { ok: false, error: AGENT_LEVEL_GONE };
  },
};

/** The owner's access levers. */
export const ACCESS_TOOLS: readonly BuiltinToolDef[] = [access_get, access_set];
