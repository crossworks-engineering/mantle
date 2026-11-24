/**
 * Builtins of an item's access, by the Grant Access panel's own functions
 * (@mantle/content grants.ts, the code the /api/grants routes call).
 *
 * access_get: an item's grants as the calling login's panel shows them
 * (getGrants): no row, home or folder name that login could not see there.
 * access_set (retired): items, agents and tool groups have no level any
 * more; it answers which tool makes the change instead.
 *
 * access_grant_add and access_grant_remove change one item's grants: the
 * same rules, the same refusals in the same words, the same
 * workspace_events rows (their subject names where the change came from,
 * `via`). They run for the login the call's scope acts for, with that
 * login's own rights; the database's grant checks run again. A grant that
 * widens who reads an item is what an injected instruction would ask for,
 * so access_grant_add is confirm-gated: an in-brain turn's call waits in
 * Pending for a person, a mini app's needs the runner's own confirm, and a
 * person's own MCP client acts at once (the owner's rule: whatever a person
 * may do by hand, their agent may do). A folder's `confirm` counts only on
 * a person's own MCP connection: an approval shows the call, not how many
 * items the folder holds. access_grant_remove only narrows: it runs like
 * any other edit.
 */
import { currentWorkspaceScope } from '@mantle/db';
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
import { publicErrorText } from '@mantle/std';
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

// ── The Grant Access panel over MCP ─────────────────────────────────────────

/** The refusal of a grant read or change with no login to act for: a call
 *  outside a login's request or turn scope (the Control Center's admin
 *  channel, a workspace assistant's own heartbeat). */
export const GRANT_NEEDS_LOGIN =
  "Grants are read and changed for a login, with that login's own rights, and this call has none. " +
  "Make it from the login's own MCP connection, or in the item's Grant Access panel.";

/** Where a change comes from, for its workspace_events row: a login's MCP
 *  connection by how it came in (`mcp-oauth`, `mcp-key`, `mcp-peer`,
 *  `mcp-stdio`), else the dispatch entry (`pending`: an approved held
 *  call; `turn`, `run`, `owner-web`, `app`). Set by the server, never from
 *  model arguments. */
function viaOf(ctx: ToolHandlerContext): string {
  const c = ctx.caller;
  if (!c) return 'tool';
  return c.entry === 'mcp' ? `mcp-${c.via}` : c.entry;
}

/** The login the call acts for: its scope's (the person's own request, or
 *  the person a turn answers), never a model argument. */
export function grantCallerOf(ctx: ToolHandlerContext): WsCaller | null {
  const loginId = currentWorkspaceScope()?.loginId ?? null;
  return loginId ? { loginId, anchorId: ctx.ownerId, via: viaOf(ctx) } : null;
}

/**
 * Whether the call's `confirm` counts: on a person's own MCP connection (a
 * key's and a peer's is stripped before the handler, dispatch.ts) or the
 * dev console. Never on an in-brain call, approved or not: its approval
 * shows the call's arguments, not the count of items a folder's change
 * reaches, which the panel shows before its own confirm. A folder's change
 * an assistant asks for is the person's own, in the panel.
 */
export function grantConfirmCounts(ctx: ToolHandlerContext): boolean {
  const entry = ctx.caller?.entry;
  return entry === 'mcp' || entry === 'owner-web';
}

/** The next step a refusal's code points at, over MCP (the panel's own
 *  words come first, unchanged). */
const GRANT_NEXT: Partial<Record<GrantErrorCode, string>> = {
  not_found: 'Find the item with `search_nodes` and the workspace with `workspaces_list`.',
  forbidden:
    "`access_get` shows the item's home where you may see it: a Moderator of it (and, to add or switch Write on, of the workspace too) can make this change.",
  already_granted:
    'It reads there already. Pass `write: true` to switch Write on; to switch it off use `access_grant_remove` with `keep_read: true`.',
  derived_row:
    "The row follows the item's folder: change the folder's grant instead, or use Change here in the item's Grant Access panel.",
  home_row: 'Move the item to another home in its Grant Access panel.',
};

/** The confirm's next step: on a person's own connection, the call again;
 *  for an in-brain call, the person in the panel (grantConfirmCounts). */
const CONFIRM_AGAIN = 'Say so to the user, then call again with `confirm: true`.';
const CONFIRM_IN_PANEL =
  "A folder's change asked by an assistant is the person's own: they make it in the folder's Grant Access panel, which shows the count.";

/** A grant read's or change's refusal: the panel's code and words, then
 *  the next step. */
function grantRefusal(err: unknown, where: string, ctx: ToolHandlerContext): ToolHandlerResult {
  if (err instanceof GrantError) {
    const next =
      err.code === 'confirm_required'
        ? grantConfirmCounts(ctx)
          ? CONFIRM_AGAIN
          : CONFIRM_IN_PANEL
        : GRANT_NEXT[err.code];
    return { ok: false, error: `${err.code}: ${err.message}${next ? ` ${next}` : ''}` };
  }
  return { ok: false, error: publicErrorText(err, where) };
}

/** An item's grants in access_get's shape (the panel's rows the caller
 *  may see, its home only where the caller may name it), or `visible:
 *  false` when a change took the item out of every workspace the caller
 *  reads. */
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

/** The arguments both grant tools take (`confirm` only where it counts). */
function grantArgs(
  input: Record<string, unknown>,
  ctx: ToolHandlerContext,
): { nodeId: string; workspace: string; confirm: boolean } | string {
  const nodeId = strOpt(input.node_id);
  const workspace = strOpt(input.workspace);
  if (!nodeId) return 'node_id is required: find the item with search_nodes.';
  if (!workspace) {
    return 'workspace is required: its id or exact name (workspaces_list, or access_get for the ones the item has).';
  }
  return { nodeId, workspace, confirm: input.confirm === true && grantConfirmCounts(ctx) };
}

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

export const access_get: BuiltinToolDef = {
  slug: 'access_get',
  policy: {
    // The A8 read cells on a note, as the panel's own GET is read: the
    // grants only where the caller reads the item.
    matrix: { action: 'read', param: 'node_id', kinds: ['note'] },
    effect: 'read',
    spends: 'none',
    scope: 'any',
  },
  preconditions: NODE_ID_PRE,
  name: 'Get who can read an item',
  description:
    "An item's grants as your Grant Access panel shows them: `home` (the workspace it lives in, null where you may not name it) and `grants`, one row per workspace you may see with `workspace`, `workspaceId`, `write`, `viaFolder` (the folder the row follows, or null) and `removedHere` (the folder grants that workspace, this item does not). Change them with `access_grant_add` and `access_grant_remove`.",
  inputSchema: {
    type: 'object',
    properties: {
      node_id: {
        type: 'string',
        format: 'uuid',
        description: 'The item (page, file, folder, app, table, ...).',
      },
    },
    required: ['node_id'],
  },
  handler: async (input, ctx) => {
    const nodeId = strOpt(input.node_id);
    if (!nodeId)
      return { ok: false, error: 'node_id is required: find the item with search_nodes.' };
    const caller = grantCallerOf(ctx);
    if (!caller) return { ok: false, error: GRANT_NEEDS_LOGIN };
    try {
      return { ok: true, output: grantsAnswer(nodeId, await getGrants(caller, nodeId)) };
    } catch (err) {
      return grantRefusal(err, 'access_get', ctx);
    }
  },
};

/** access_set is the owner's, as it was: it changes nothing. */
function ownerOnly(ctx: ToolHandlerContext): ToolHandlerResult | null {
  if (!isOwnerSurface(ctx.surface)) {
    return {
      ok: false,
      error:
        'access_set is retired and owner-side only. Change grants with `access_grant_add` and `access_grant_remove`.',
    };
  }
  return null;
}

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

export const access_grant_add: BuiltinToolDef = {
  slug: 'access_grant_add',
  policy: {
    // The A8 cells of "Add a grant to workspace T" (Moderator of its home
    // and of T), on a note, as the panel's POST route's cells.
    matrix: { action: 'grantAdd', param: 'node_id', kinds: ['note'] },
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
    "Grant one item to a workspace, as the item's Grant Access panel does: the users of that workspace then read it (`write: true`: and edit it). On a workspace the item is already in, `write: true` switches Write on. Needs a Moderator of the item's home (or an Admin user who reads the item) and a Moderator of that workspace; the panel's refusals come back in its words. **An agent's call in a chat waits in Pending for a person.** A folder passes the grant to everything inside it (`confirm`). Answers the item's grants after the change, as `access_get`. To narrow use `access_grant_remove`; a public link is `node_share`.",
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
    const args = grantArgs(input, ctx);
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
      return grantRefusal(err, 'access_grant_add', ctx);
    }
  },
};

export const access_grant_remove: BuiltinToolDef = {
  slug: 'access_grant_remove',
  policy: {
    // The A8 cells of "Remove a grant from T" (Moderator of its home, or of
    // T), on a note, as the panel's DELETE route's cells.
    matrix: { action: 'grantRemove', param: 'node_id', kinds: ['note'] },
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
    "Take one item away from a workspace, as the item's Grant Access panel does: its users no longer read it (a row that follows the item's folder becomes \"Removed here\"). `keep_read: true` only switches that grant's Write off. Needs a Moderator of the item's home (or an Admin user who reads the item) or of that workspace; the home's own row never goes (move the item instead); the panel's refusals come back in its words. A folder's change reaches everything inside it (`confirm`). Answers the item's grants after the change, as `access_get`. To widen use `access_grant_add`.",
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
    const args = grantArgs(input, ctx);
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
      return grantRefusal(err, 'access_grant_remove', ctx);
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
