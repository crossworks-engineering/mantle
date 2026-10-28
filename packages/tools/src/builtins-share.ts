/**
 * Generic sharing builtins: the tool-surface counterpart of the editor's
 * ShareControl. `createShare` owns the rules (owned node, shareable type,
 * folders only under the files root) and link-serve.ts who may open a link
 * and what its served list may hold (workspaces plan 8.1); these are thin,
 * type-agnostic wrappers so the assistant can mint/revoke viewable links for
 * ANY shareable item (notes, tasks, events, files, apps, tables, folders),
 * not just pages. `page_share`/`page_unshare` remain the page-specific pair.
 * A link never changes a level or a grant.
 */
import {
  assertMayLink,
  checkServeList,
  createShare,
  getActiveShareForNode,
  LINK_APP_NO_MANAGE_MESSAGE,
  LINK_NO_EDIT_MESSAGE,
  LinkRefusedError,
  revokeShare,
  shareUrlForToken,
  TeamLinkRetiredError,
  type LoweredItem,
} from '@mantle/content';
import type { BuiltinToolDef, ToolHandlerContext } from './types';
import type { ToolItemArg } from './tool-policy';
import { db, nodes } from '@mantle/db';
import { eq } from 'drizzle-orm';
import { str } from './coerce';
import { isOwnerSurface, keyOrPeerVia, loginTurnSurfaceId, ownerSurfaceLoginId } from './surface';
import { errorMessage } from '@mantle/std';
import { callerHasArea, callerScope } from './admin-gate';
import { CS } from './client-sourced-rule';
import { ITEM_KINDS, ITEM_KIND_NAMES } from '@mantle/client-types/kinds';

/** The kinds an item link opens on (the registry's; a Files folder's is its
 *  own route). */
const LINK_KINDS = ITEM_KIND_NAMES.filter((k) => ITEM_KINDS[k].publicLink === true);

/** The `serve` input both share tools take. */
export const SERVE_INPUT = {
  type: 'array',
  items: { type: 'string' },
  description:
    "optional: the ids the link shows besides the item (its served list, replacing the one it has): for a page, note, task or event the items it names or embeds (pictures, files, drawings, mentions); for a drawing its images; for a folder the files and subfolders in it. Each must be one you may edit. Without it the list stays as it is (a new link shows the item alone: what it names reads 'Private item'). A file added to a shared folder later is not shown until it is added here.",
} as const;

/** The `serve` input as ids, or undefined when absent; an error string when
 *  it is not a list of strings. */
export function serveInput(v: unknown): string[] | undefined | string {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    return 'serve must be a list of item ids';
  }
  return v as string[];
}

/**
 * The login a link is opened or closed as (audit 2026-10-12): the CALLER,
 * as POST /api/shares passes the session's actor. An ALLOWLIST (A0 fix
 * round, M2): a surface that names its login (an owner surface's MCP
 * connection, API key, web or Telegram chat, a run or delegated child that
 * carries its login; a member login's turn) links as that login. The brain's
 * owner only on an owner path that names no login AND has no MCP channel,
 * and only via stdio MCP, a run with no login or the owner's own pending
 * approval (never a delegated child, whose parent chat may name none). Anything
 * else is refused, never read as the owner: a missing surface (the C4 rule
 * in surface.ts), a chat that names no login, a team or contact surface with
 * no login of its own, an MCP connection that names none (a peer bound to an
 * Admin login, W6b fix round 3).
 */
/** The owner paths that may link as the brain owner when they name no
 *  login. */
const OWNER_FALLBACK_VIAS: ReadonlySet<string> = new Set(['mcp', 'run', 'pending']);

export function linkLoginId(ctx: Pick<ToolHandlerContext, 'ownerId' | 'surface'>): string {
  const s = ctx.surface;
  const turnLogin = loginTurnSurfaceId(s);
  if (turnLogin) return turnLogin;
  if (isOwnerSurface(s)) {
    const named = ownerSurfaceLoginId(s);
    if (named) return named;
    // Only the owner paths that are the owner's own by construction: stdio
    // MCP, a run with no login, the owner's own pending approval. Never a
    // delegated child (its parent chat may name no login), nor any other
    // via (A0 fix round 2, M-1).
    if (s?.kind === 'owner' && !s.mcp && OWNER_FALLBACK_VIAS.has(s.via)) return ctx.ownerId;
  }
  throw new LinkRefusedError(
    403,
    'forbidden',
    'Only a signed-in login may open or close a link: ask a user who may edit the item.',
  );
}

/**
 * Open (or fetch) the link on `id` as the calling login, with its served
 * list replaced when `serve` is given: the checks of POST /api/shares (who
 * may link, what may be served), both on the caller's rights.
 */
export async function openLink(
  ctx: Pick<ToolHandlerContext, 'ownerId' | 'surface'>,
  id: string,
  serve: readonly string[] | undefined,
) {
  const login = linkLoginId(ctx);
  const item = await assertMayLink(ctx.ownerId, login, id);
  const current = await getActiveShareForNode(ctx.ownerId, id);
  const list =
    serve === undefined
      ? undefined
      : await checkServeList(ctx.ownerId, login, item, serve, current?.served ?? []);
  return createShare(ctx.ownerId, id, { serve: list });
}

/** A refusal as the tools word it: an item it cannot read is not found. */
export function linkError(err: unknown): string {
  if (err instanceof LinkRefusedError) {
    return err.code === 'not_found' ? LINK_NOT_FOUND_TEXT : err.message;
  }
  return errorMessage(err);
}

/** A link tool's words for an item the caller does not read. */
const LINK_NOT_FOUND_TEXT = 'not found (or not one you may read)';

/** The item a link opens on (`id`), in the link's own words when the
 *  queue-time check refuses it (assertMayLink's: an app's link is its home
 *  Moderators'). */
export const LINK_ITEM_ARG: readonly ToolItemArg[] = [
  {
    param: 'id',
    refused: async (detail, id) => {
      if (detail === 'no_read') return LINK_NOT_FOUND_TEXT;
      const [row] = await db
        .select({ type: nodes.type })
        .from(nodes)
        .where(eq(nodes.id, id))
        .limit(1);
      return row?.type === 'app' ? LINK_APP_NO_MANAGE_MESSAGE : LINK_NO_EDIT_MESSAGE;
    },
  },
];

const node_share: BuiltinToolDef = {
  slug: 'node_share',
  policy: {
    matrix: { action: 'link', param: 'id', kinds: LINK_KINDS },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: LINK_ITEM_ARG,
    peerRisky: true,
    lowering: 'always',
  },
  name: 'Share an item',
  description:
    'Create (or fetch) the public read-only link to a shareable item (note, task, event, file, app, table, drawing, or folder under files) and return its URL. One link per item; anyone with it can view, no login. It shows the item plus its served list (`serve`): what the item names or embeds, or a folder holds, shows only when on that list. A link is no grant: to show an item to members or clients, grant it to their workspace. Only someone who may edit the item may share it (an app: a home Moderator). For a PAGE prefer `page_share`; to turn a link off use `node_unshare`.',
  // Publishes brain content outward-facing, so gated, same as page_share.
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'node id of the item to share (from its listing tool or search_nodes)',
      },
      mode: {
        type: 'string',
        enum: ['public'],
        description: "Always 'public' (the default). Team links are retired.",
      },
      serve: SERVE_INPUT,
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const refused = linkModeRefusal(input.mode);
    if (refused) return { ok: false, error: refused };
    const serve = serveInput(input.serve);
    if (typeof serve === 'string') return { ok: false, error: serve };
    try {
      const share = await openLink(ctx, id, serve);
      const url = shareUrlForToken(share.token);
      ctx.step?.setOutput({ id, url, mode: share.mode });
      return { ok: true, output: { id, url, mode: share.mode, served: share.served } };
    } catch (err) {
      return { ok: false, error: linkError(err) };
    }
  },
};

/**
 * What the public level on one item did to CLIENT items it embeds (audit
 * A10): they went down to public with it and left client logins' view. Said
 * out loud in access_set's answer, never silently. Null when no client item
 * moved. (A link no longer lowers anything: only the old level path uses
 * this.)
 */
export function clientLeftWarning(alsoLowered: readonly LoweredItem[]): string | null {
  const moved = alsoLowered.filter((l) => l.from === 'client');
  if (moved.length === 0) return null;
  const names = moved.map((l) => `${l.title} (${l.type})`).join(', ');
  return (
    `${moved.length === 1 ? 'An embedded client item' : `${moved.length} embedded client items`} ` +
    `went from client to ${moved[0]!.to} with it and so left client logins' view: ${names}. ` +
    'Tell the owner; if clients should keep them, the owner decides what to change.'
  );
}

/**
 * The share tools' answer to a link mode other than public. Team links are
 * retired (member logins Phase 6 stage 6), so 'team' names what to do
 * instead; anything else unknown is refused too, never read as public. Null
 * when the mode is absent or public.
 */
export function linkModeRefusal(mode: unknown): string | null {
  if (mode === undefined || mode === null || mode === 'public') return null;
  if (mode === 'team') return new TeamLinkRetiredError().message;
  return "mode must be 'public' (the only link mode)";
}

/** Whether the caller is an Admin user with the users area: an owner
 *  surface in a workspace scope that holds that area. Outside any scope
 *  (callerHasArea's "yes, the surface decides") it is not. */
async function mayCloseAnyLink(ctx: Pick<ToolHandlerContext, 'surface'>): Promise<boolean> {
  if (!isOwnerSurface(ctx.surface) || !callerScope()) return false;
  // An API key or a linked brain has no users area of its own (its areas
  // are content areas, key-scope.ts): it closes only links it may edit,
  // whatever its login holds (A0 fix round 2, L-5).
  if (keyOrPeerVia(ctx)) return false;
  return callerHasArea('users');
}

/** Turn the link on `id` off as the calling login (the checks of DELETE
 *  /api/shares/:id). Changes no level and no grant. */
export async function closeLink(
  ctx: Pick<ToolHandlerContext, 'ownerId' | 'surface'>,
  id: string,
): Promise<{ id: string; unshared: boolean }> {
  const login = linkLoginId(ctx);
  // The rights check first (A0 fix round, L4): a caller that may not link
  // the item learns nothing about whether it has a link. An Admin user with
  // the users area may close any link (docs/workspaces.md), as DELETE
  // /api/shares/:id lets it.
  try {
    await assertMayLink(ctx.ownerId, login, id);
  } catch (err) {
    if (!(err instanceof LinkRefusedError) || !(await mayCloseAnyLink(ctx))) throw err;
  }
  const share = await getActiveShareForNode(ctx.ownerId, id);
  if (!share) return { id, unshared: false };
  return { id, unshared: await revokeShare(ctx.ownerId, share.id) };
}

const node_unshare: BuiltinToolDef = {
  slug: 'node_unshare',
  policy: {
    idempotent: true, // no-op when not shared
    matrix: { action: 'link', param: 'id', kinds: LINK_KINDS },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'id', least: 'none' }],
    clientSourced: CS.free('takes a link away'),
  },
  name: 'Stop sharing an item',
  description:
    "Revoke an item's share link: the existing URL stops working immediately. No-op (still succeeds) if it wasn't shared. Changes no one's access in the brain. Works for any shareable item; `page_unshare` is the same for pages.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'node id whose share link to revoke' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const out = await closeLink(ctx, id);
      if (out.unshared) ctx.step?.setOutput(out);
      return { ok: true, output: out };
    } catch (err) {
      return { ok: false, error: linkError(err) };
    }
  },
};

export const SHARE_TOOLS: BuiltinToolDef[] = [node_share, node_unshare];
