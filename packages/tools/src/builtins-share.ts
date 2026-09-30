/**
 * Generic sharing builtins — the tool-surface counterpart of the editor's
 * ShareControl. `createShare` owns the rules (owned node, shareable type,
 * folders only under the files root); these are thin, type-agnostic wrappers
 * so the assistant can mint/revoke viewable links for ANY shareable item —
 * notes, tasks, events, files, apps, tables, folders — not just pages.
 * `page_share`/`page_unshare` remain the page-specific pair.
 */
import {
  createShare,
  getActiveShareForNode,
  shareUrlForToken,
  TeamLinkRetiredError,
  unshareItem,
  type AccessItem,
  type LoweredItem,
} from '@mantle/content';
import type { BuiltinToolDef } from './types';
import { str } from './coerce';
import { errorMessage } from '@mantle/std';

const node_share: BuiltinToolDef = {
  slug: 'node_share',
  name: 'Share an item',
  description:
    'Create (or fetch) a read-only link to any shareable item (a note, task, event, file, app, table, or folder under files) and return its URL. Idempotent: one active link per item. The link is **public**: anyone with it can view, no login, and the item goes to public level, its embeds with it (`alsoLowered`). No team or client links: members and clients sign in, so for them set the level with `access_set` instead (a client item is refused a link). Publishes brain content outward-facing. For a PAGE prefer `page_share` (same behavior); to turn a link off use `node_unshare`.',
  // Publishes brain content outward-facing — gated, same as page_share.
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
        description:
          "Always 'public' (the default). Team links are retired: use access_set(level: 'team') to show an item to members.",
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const refused = linkModeRefusal(input.mode);
    if (refused) return { ok: false, error: refused };
    try {
      // createShare validates ownership + shareability and throws a plain
      // corrective ("type 'email' is not shareable") we surface verbatim.
      const alsoLowered: LoweredItem[] = [];
      const share = await createShare(ctx.ownerId, id, { alsoLowered });
      const url = shareUrlForToken(share.token);
      ctx.step?.setOutput({ id, url, mode: share.mode });
      const warning = clientLeftWarning(alsoLowered);
      return {
        ok: true,
        output: {
          id,
          url,
          mode: share.mode,
          ...(alsoLowered.length ? { alsoLowered } : {}),
          ...(warning ? { warning } : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

/**
 * What a link (or the public level) on one item did to CLIENT items it
 * embeds (audit A10): embedding means sharing, so they went down to public
 * with it, and client logins read client items only (client logins C1,
 * decision 3), so they left the clients' view. Said out loud in the tool's
 * answer, never silently. Null when no client item moved.
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

/**
 * The unshare tools' output. An open link's item goes to admin with its
 * link; what it embeds (a page's files and drawings, a folder's contents)
 * keeps its own level, so name what is still below and how to raise it, as
 * access_set does.
 */
export function unshareOutput(
  id: string,
  revoked: boolean,
  stillBelow: readonly AccessItem[],
): Record<string, unknown> {
  if (!revoked || stillBelow.length === 0) return { id, unshared: revoked };
  const names = stillBelow.map((i) => `${i.title} (${i.type}, ${i.audience})`).join(', ');
  return {
    id,
    unshared: revoked,
    stillBelow,
    warning: `The item is admin now, but what it embeds is still below admin: ${names}. People at those levels can still open them. To raise them too: access_set(node_id: '${id}', level: 'admin', raise_closure: true).`,
  };
}

const node_unshare: BuiltinToolDef = {
  slug: 'node_unshare',
  name: 'Stop sharing an item',
  description:
    "Revoke an item's share link: the existing URL stops working immediately. No-op (still succeeds) if it wasn't shared. Works for any shareable item; `page_unshare` is the same for pages.",
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
      const share = await getActiveShareForNode(ctx.ownerId, id);
      if (!share) return { ok: true, output: { id, unshared: false } };
      const { revoked, stillBelow } = await unshareItem(ctx.ownerId, share.id);
      ctx.step?.setOutput({ id, unshared: revoked });
      return { ok: true, output: unshareOutput(id, revoked, stillBelow) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const SHARE_TOOLS: BuiltinToolDef[] = [node_share, node_unshare];
