/**
 * Generic sharing builtins — the tool-surface counterpart of the editor's
 * ShareControl. `createShare` owns the rules (owned node, shareable type,
 * folders only under the files root); these are thin, type-agnostic wrappers
 * so the assistant can mint/revoke viewable links for ANY shareable item —
 * notes, tasks, events, files, apps, tables, folders — not just pages.
 * `page_share`/`page_unshare` remain the page-specific pair (they add the
 * sub-page cascade).
 */
import {
  applyShareMode,
  createShare,
  getActiveShareForNode,
  shareUrlForToken,
  unshareItem,
  type AccessItem,
} from '@mantle/content';
import type { BuiltinToolDef } from './types';
import { str } from './coerce';
import { errorMessage } from '@mantle/std';

const node_share: BuiltinToolDef = {
  slug: 'node_share',
  name: 'Share an item',
  description:
    "Create (or fetch) a read-only link to any shareable item — a note, task, event, file, app, table, or folder under files — and return its URL. Idempotent — one active link per item. The link is **public** (anyone with it can view, no login) unless `mode: 'team'` (team members only). Publishes brain content outward-facing. For a PAGE prefer `page_share` (same behavior, plus the sub-page cascade); to turn a link off use `node_unshare`.",
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
        enum: ['public', 'team'],
        description:
          "Who may open the link: 'public' (anyone) or 'team' (team members only). Omit to keep the link's current setting (public for a new link).",
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const mode = input.mode === 'team' ? 'team' : input.mode === 'public' ? 'public' : undefined;
    try {
      // createShare validates ownership + shareability and throws a plain
      // corrective ("type 'email' is not shareable") we surface verbatim.
      const share = await createShare(ctx.ownerId, id);
      if (mode) await applyShareMode(ctx.ownerId, share.id, mode);
      const url = shareUrlForToken(share.token);
      const finalMode = mode ?? share.mode;
      ctx.step?.setOutput({ id, url, mode: finalMode });
      return { ok: true, output: { id, url, mode: finalMode } };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

/**
 * The unshare tools' output. An open link's item goes to admin with its
 * link; what it embeds (a page's files and drawings, a folder's contents)
 * keeps its own level, so name what is still below and how to raise it, as
 * access_set does. A team link's item stays at team (`keptTeam`): say so.
 */
export function unshareOutput(
  id: string,
  revoked: boolean,
  stillBelow: readonly AccessItem[],
  keptTeam?: boolean,
): Record<string, unknown> {
  if (revoked && keptTeam) {
    return {
      id,
      unshared: true,
      level: 'team',
      note: `The team link is gone, but the item stays at team: member logins still read it. To hide it from them: access_set(node_id: '${id}', level: 'admin').`,
    };
  }
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
    "Revoke an item's share link — the existing URL stops working immediately. No-op (still succeeds) if it wasn't shared. Works for any shareable item; for pages `page_unshare` also revokes cascaded sub-page links.",
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
      const { revoked, stillBelow, keptTeam } = await unshareItem(ctx.ownerId, share.id);
      ctx.step?.setOutput({ id, unshared: revoked });
      return { ok: true, output: unshareOutput(id, revoked, stillBelow, keptTeam) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const SHARE_TOOLS: BuiltinToolDef[] = [node_share, node_unshare];
