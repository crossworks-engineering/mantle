/**
 * Public sharing: share and unshare.
 *
 * Split out of builtins-pages.ts; bodies moved verbatim.
 */

import {
  getPage,
  createShare,
  unshareItem,
  setShareCascade,
  getActiveShareForNode,
  shareUrlForToken,
} from '@mantle/content';
import type { BuiltinToolDef } from '../types';
import { str } from '../coerce';
import { notFound } from '../errors';
import { errorMessage } from '@mantle/std';
import { PAGE_NODE_ID_PRE } from './common';
import { linkModeRefusal, unshareOutput } from '../builtins-share';

export const page_share: BuiltinToolDef = {
  slug: 'page_share',
  preconditions: PAGE_NODE_ID_PRE,
  name: 'Share a page',
  description:
    "Create (or fetch) a read-only link to a page and return its URL. Idempotent — one active link per page. The link is **public**: anyone with it can view, no login, and the page goes to public level (a client page stays client). There are no team links: members sign in with their own logins, so to show a page to members only, set its level with `access_set(level: 'team')` instead. `children: true` also shares every sub-page beneath it (a whole documentation section in one call); `children: false` revokes those sub-page links. Publishes brain content outward-facing. Use when the user asks to share or publish a page or a section; to turn a link off use `page_unshare`.",
  // Publishes brain content to the public web, so gated. `children` can share a
  // large subtree at once, so confirm.
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id (from page_list / page_create)' },
      mode: {
        type: 'string',
        enum: ['public'],
        description:
          "Always 'public' (the default). Team links are retired: use access_set(level: 'team') to show a page to members.",
      },
      children: {
        type: 'boolean',
        description:
          "Also share every sub-page nested under this page, at the page's level. false revokes those sub-page links. Omit to leave sub-pages untouched.",
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const refused = linkModeRefusal(input.mode);
    if (refused) return { ok: false, error: refused };
    const children = typeof input.children === 'boolean' ? input.children : undefined;
    try {
      const page = await getPage(ctx.ownerId, id);
      if (!page) return notFound('page', id, 'page_list / search_nodes');
      const share = await createShare(ctx.ownerId, id);
      let subpages: number | undefined;
      if (children !== undefined) {
        subpages = (await setShareCascade(ctx.ownerId, id, children)).count;
      }
      const url = shareUrlForToken(share.token);
      ctx.step?.setOutput({ id, url, mode: share.mode });
      return {
        ok: true,
        output: {
          id,
          title: page.title,
          url,
          token: share.token,
          mode: share.mode,
          ...(children === true ? { subpagesShared: subpages } : {}),
          ...(children === false ? { subpagesRevoked: subpages } : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const page_unshare: BuiltinToolDef = {
  slug: 'page_unshare',
  preconditions: PAGE_NODE_ID_PRE,
  name: 'Stop sharing a page',
  description:
    "Revoke a page's share link — and, if it was sharing its sub-pages, theirs too. The existing URL stops working immediately. No-op (still succeeds) if the page wasn't shared. Use when the user asks to unshare, unpublish, or make a page private again.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id whose share link to revoke' },
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
