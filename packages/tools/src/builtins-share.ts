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
  revokeShareTree,
  shareUrlForToken,
} from '@mantle/content';
import type { BuiltinToolDef } from './types';
import { str } from './coerce';

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
        description: "node id of the item to share (from its listing tool or search_nodes)",
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

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
      const ok = await revokeShareTree(ctx.ownerId, share.id);
      ctx.step?.setOutput({ id, unshared: ok });
      return { ok: true, output: { id, unshared: ok } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const SHARE_TOOLS: BuiltinToolDef[] = [node_share, node_unshare];
