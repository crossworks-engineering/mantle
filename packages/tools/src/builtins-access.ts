/**
 * Builtins of an item's access.
 *
 * access_get (owner-side): an item's grants, the workspaces that read it.
 * access_set (retired): items, agents and tool groups have no level any
 * more; it answers which tool makes the change instead.
 *
 * access_grant_add and access_grant_remove change one item's grants by the
 * Grant Access panel's own functions (@mantle/content grants.ts, the code
 * the /api/grants routes call): the same rules, the same refusals in the
 * same words, the same workspace_events rows. They run for the login the
 * call's scope acts for, with that login's own rights; the database's
 * grant checks run again. A grant that widens who reads an item is what an
 * injected instruction would ask for, so access_grant_add is confirm-gated:
 * an in-brain turn's call waits in Pending for a person, a mini app's needs
 * the runner's own confirm, and a person's own MCP client acts at once (the
 * owner's rule: whatever a person may do by hand, their agent may do).
 * access_grant_remove only narrows: it runs like any other edit.
 */
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq } from 'drizzle-orm';
import { currentWorkspaceScope, db, itemGrants, nodes, workspaces } from '@mantle/db';
import {
  addGrant,
  getGrants,
  GrantError,
  grantWorkspaceRef,
  patchGrant,
  removeGrant,
  type WsCaller,
} from '@mantle/content/grants';
import type { GrantErrorCode, GrantsWriteResponse } from '@mantle/client-types';
import { errorMessage, publicErrorText } from '@mantle/std';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { strOpt } from './coerce';
import { NODE_ID_PRE } from './builtins-common';
import { isOwnerSurface } from './surface';
import { lowersAccessSet } from './client-sourced';
import { CS } from './client-sourced-rule';

/** access_set's answer for a brain item. */
export const ITEM_LEVEL_GONE =
  'Brain items have no sharing level any more: the workspaces that read an item are its grants. ' +
  'Add a workspace or switch its Write on with `access_grant_add`; switch Write off or take a ' +
  "workspace away with `access_grant_remove` (or use the item's Grant Access panel).";

/** access_set's answer for an agent or a tool group. */
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
  policy: {
    matrix: {
      none: 'the Admin access panel: its grant rules are the grants panel cells (a8-surfaces web)',
    },
    effect: 'read',
    spends: 'none',
    scope: 'admin',
  },
  ownerOnly: true,
  preconditions: NODE_ID_PRE,
  name: 'Get who can read an item, or an access level',
  description:
    'For a brain item: its grants, the workspaces that read it (`home`: the workspace it lives in; `grants`: one row per workspace with `write`, `viaFolder` (the folder the row follows, or null) and `removedHere` (the folder grants that workspace, this item does not)). Change them with `access_grant_add` and `access_grant_remove`.',
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
        const { home, grants } = await itemGrantsOf(nodeId);
        return { ok: true, output: { item: row, home, grants } };
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
    matrix: {
      none: 'the Admin access panel: its grant rules are the grants panel cells (a8-surfaces web)',
    },
    effect: 'write',
    spends: 'none',
    scope: 'admin',
    // Retired: every call answers its retirement, so the queue asks nothing.
    itemArgs: [{ param: 'node_id', least: 'none' }],
    peerRisky: true,
    lowering: lowersAccessSet,
  },
  ownerOnly: true,
  preconditions: NODE_ID_PRE,
  name: 'Set an access level (retired)',
  description:
    "Retired: nothing has a level any more. A brain item's readers are its grants: change them with `access_grant_add` and `access_grant_remove` (see `access_get`). An assistant reads the workspace it answers in, and a tool group is system-wide or Admin only. Answers how to make the change instead.",
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

// ── Grant changes: the Grant Access panel over MCP ───────────────────────────

/** The refusal of a grant change with no login to act for: a call outside a
 *  login's request or turn scope (the Control Center's admin channel, a
 *  workspace assistant's own heartbeat). */
export const GRANT_NEEDS_LOGIN =
  "A grant change acts for a login, with that login's own rights, and this call has none. " +
  "Make it from the login's own MCP connection, or in the item's Grant Access panel.";

/** The login the call acts for: its scope's (the person's own request, or
 *  the person a turn answers), never a model argument. */
export function grantCallerOf(ctx: ToolHandlerContext): WsCaller | null {
  const loginId = currentWorkspaceScope()?.loginId ?? null;
  return loginId ? { loginId, anchorId: ctx.ownerId } : null;
}

/** The next step a refusal's code points at, over MCP (the panel's own
 *  words come first, unchanged). */
const GRANT_NEXT: Partial<Record<GrantErrorCode, string>> = {
  not_found: 'Find the item with `search_nodes` and the workspace with `workspaces_list`.',
  forbidden:
    "`access_get` names the item's home: a Moderator of it (and, to add or switch Write on, of the workspace too) can make this change.",
  confirm_required: 'Say so to the user, then call again with `confirm: true`.',
  already_granted:
    'It reads there already. Pass `write: true` to switch Write on; to switch it off use `access_grant_remove` with `keep_read: true`.',
  derived_row:
    "The row follows the item's folder: change the folder's grant instead, or use Change here in the item's Grant Access panel.",
  home_row: 'Move the item to another home in its Grant Access panel.',
};

/** A grant change's refusal: the panel's code and words, then the next step. */
function grantRefusal(err: unknown, where: string): ToolHandlerResult {
  if (err instanceof GrantError) {
    const next = GRANT_NEXT[err.code];
    return { ok: false, error: `${err.code}: ${err.message}${next ? ` ${next}` : ''}` };
  }
  return { ok: false, error: publicErrorText(err, where) };
}

/** The item's grants after a change, in access_get's shape (the panel's
 *  rows the caller may see), or `visible: false` when the change took the
 *  item out of every workspace the caller reads. */
function grantsAnswer(nodeId: string, out: GrantsWriteResponse): Record<string, unknown> {
  if ('visible' in out) {
    return {
      item: { id: nodeId },
      visible: false,
      note: 'Done. The item is no longer in a workspace you read.',
    };
  }
  return {
    item: out.item,
    home: out.home.name,
    grants: out.rows.map((r) => ({
      workspace: r.name,
      workspaceId: r.wsId,
      write: r.write,
      viaFolder: r.viaFolder ? (r.viaFolder.title ?? r.viaFolder.id) : null,
      removedHere: r.excluded,
    })),
  };
}

/** The arguments both grant tools take. */
function grantArgs(
  input: Record<string, unknown>,
): { nodeId: string; workspace: string; confirm: boolean } | string {
  const nodeId = strOpt(input.node_id);
  const workspace = strOpt(input.workspace);
  if (!nodeId) return 'node_id is required: find the item with search_nodes.';
  if (!workspace) {
    return 'workspace is required: its id or exact name (workspaces_list, or access_get for the ones the item has).';
  }
  return { nodeId, workspace, confirm: input.confirm === true };
}

/** The matrix line of a grant change, as the grants routes declare it. */
const GRANT_MATRIX = {
  none: "a grant change: its rule asks two workspaces (the item's home and the grant's), no one right of the item; the grants panel's definers decide it",
} as const;

const GRANT_SCHEMA_BASE = {
  node_id: {
    type: 'string',
    format: 'uuid',
    description: 'The item (page, file, folder, app, table, ...).',
  },
  workspace: {
    type: 'string',
    description: 'The workspace: its id, or its exact name, e.g. "Engineering".',
  },
  confirm: {
    type: 'boolean',
    description:
      'A folder only: the change reaches everything inside it. Send true once the user knows how many items (the refusal without it says).',
  },
} as const;

export const access_grant_add: BuiltinToolDef = {
  slug: 'access_grant_add',
  policy: {
    matrix: GRANT_MATRIX,
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'node_id', least: 'read' }],
    // A key or a linked brain calls it only when the owner named it.
    peerRisky: true,
    memberApp: 'refused',
    recipe: { step: 'forbidden', runItem: 'banned' },
    idempotent: true,
    clientSourced: CS.always('it widens who reads an item'),
  },
  // Widening is the injection case: an in-brain turn's call waits in
  // Pending for a person; a person's own MCP client acts at once.
  requiresConfirm: true,
  preconditions: NODE_ID_PRE,
  name: "Share an item with a workspace, or switch a grant's Write on",
  description:
    "Grant one item to a workspace, as the item's Grant Access panel does: the users of that workspace then read it (`write: true`: and edit it). On a workspace the item is already in, `write: true` switches Write on. Needs a Moderator of the item's home and of that workspace; the panel's refusals come back in its words. A folder passes the grant to everything inside it (`confirm`). Answers the item's grants after the change, as `access_get`. To narrow use `access_grant_remove`; a public link is `node_share`.",
  inputSchema: {
    type: 'object',
    properties: {
      ...GRANT_SCHEMA_BASE,
      write: {
        type: 'boolean',
        default: false,
        description: 'Whether the workspace may edit the item too.',
      },
    },
    required: ['node_id', 'workspace'],
  },
  handler: async (input, ctx) => {
    const args = grantArgs(input);
    if (typeof args === 'string') return { ok: false, error: args };
    const caller = grantCallerOf(ctx);
    if (!caller) return { ok: false, error: GRANT_NEEDS_LOGIN };
    const write = input.write === true;
    try {
      const wsId = await grantWorkspaceRef(caller, args.nodeId, args.workspace);
      // On a workspace the item is in already (a row the panel shows the
      // caller), Write on is the panel's Write switch, with its own rule
      // and words; anywhere else it is "Add workspace".
      const held =
        write &&
        (await getGrants(caller, args.nodeId)).rows.some((r) => r.wsId === wsId && !r.excluded);
      const out = held
        ? await patchGrant(caller, args.nodeId, wsId, { write: true, confirm: args.confirm })
        : await addGrant(caller, args.nodeId, { wsId, write, confirm: args.confirm });
      return { ok: true, output: grantsAnswer(args.nodeId, out) };
    } catch (err) {
      return grantRefusal(err, 'access_grant_add');
    }
  },
};

export const access_grant_remove: BuiltinToolDef = {
  slug: 'access_grant_remove',
  policy: {
    matrix: GRANT_MATRIX,
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'node_id', least: 'read' }],
    peerRisky: true,
    memberApp: 'refused',
    recipe: { step: 'forbidden', runItem: 'banned' },
    idempotent: true,
    // It takes a grant away (keep_read: only its Write): the MCP map's
    // delete class, as the other `_remove` tools.
    riskClass: 'delete',
    clientSourced: CS.onNodes('node_id'),
  },
  preconditions: NODE_ID_PRE,
  name: "Take an item from a workspace, or switch a grant's Write off",
  description:
    "Take one item away from a workspace, as the item's Grant Access panel does: its users no longer read it (a row that follows the item's folder becomes \"Removed here\"). `keep_read: true` only switches that grant's Write off. Needs a Moderator of the item's home or of that workspace; the home's own row never goes (move the item instead); the panel's refusals come back in its words. A folder's change reaches everything inside it (`confirm`). Answers the item's grants after the change, as `access_get`. To widen use `access_grant_add`.",
  inputSchema: {
    type: 'object',
    properties: {
      ...GRANT_SCHEMA_BASE,
      keep_read: {
        type: 'boolean',
        default: false,
        description: 'Keep the grant and switch only its Write off.',
      },
    },
    required: ['node_id', 'workspace'],
  },
  handler: async (input, ctx) => {
    const args = grantArgs(input);
    if (typeof args === 'string') return { ok: false, error: args };
    const caller = grantCallerOf(ctx);
    if (!caller) return { ok: false, error: GRANT_NEEDS_LOGIN };
    try {
      const wsId = await grantWorkspaceRef(caller, args.nodeId, args.workspace);
      const out =
        input.keep_read === true
          ? await patchGrant(caller, args.nodeId, wsId, { write: false, confirm: args.confirm })
          : await removeGrant(caller, args.nodeId, wsId, args.confirm);
      return { ok: true, output: grantsAnswer(args.nodeId, out) };
    } catch (err) {
      return grantRefusal(err, 'access_grant_remove');
    }
  },
};

/** An item's access: who reads it, and the grant changes. */
export const ACCESS_TOOLS: readonly BuiltinToolDef[] = [
  access_get,
  access_set,
  access_grant_add,
  access_grant_remove,
];
