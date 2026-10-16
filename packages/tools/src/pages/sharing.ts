/**
 * Public sharing: share and unshare.
 *
 * Split out of builtins-pages.ts. The `children` option (share the page's
 * sub-pages too) went with folder phase 7: pages do not nest. A page's link
 * shows the page plus its served list (workspaces plan 8.1): the embeds and
 * named items on that list. A link is not a grant: to show pages to members
 * or clients, grant them (or their folder) to the workspace.
 */

import { getPage, shareUrlForToken } from '@mantle/content';
import type { BuiltinToolDef } from '../types';
import { str } from '../coerce';
import { notFound } from '../errors';
import { PAGE_NODE_ID_PRE } from './common';
import {
  closeLink,
  linkError,
  linkModeRefusal,
  openLink,
  SERVE_INPUT,
  serveInput,
} from '../builtins-share';
import { edit } from '../item-write-gate';
import { CS } from '../client-sourced-rule';

export const page_share: BuiltinToolDef = {
  slug: 'page_share',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: 'any',
    legacyItemPrecheck: { need: [edit('id')], reason: 'answer-worse' },
    peerRisky: true,
    keyArea: 'pages',
    lowering: 'always',
  },
  preconditions: PAGE_NODE_ID_PRE,
  name: 'Share a page',
  description:
    "Create (or fetch) the public read-only link to a page and return its URL. One link per page; anyone with it can view, no login. It shows the page plus its served list (`serve`): a picture, file, drawing or mention shows only when on that list, else it is left out or reads 'Private item'. A link is no grant: to show pages to members or clients, grant them (or their folder) to their workspace. Only someone who may edit the page may share it. Use when the user asks to share or publish a page; to turn a link off use `page_unshare`.",
  // Publishes brain content to the public web, so gated.
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id (from page_list / page_create)' },
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
      const page = await getPage(ctx.ownerId, id);
      if (!page) return notFound('page', id, 'page_list / search_nodes');
      const share = await openLink(ctx, id, serve);
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
          served: share.served,
        },
      };
    } catch (err) {
      return { ok: false, error: linkError(err) };
    }
  },
};

export const page_unshare: BuiltinToolDef = {
  slug: 'page_unshare',
  policy: {
    effect: 'write',
    spends: 'none',
    scope: 'any',
    keyArea: 'pages',
    clientSourced: CS.free('takes a link away'),
  },
  preconditions: PAGE_NODE_ID_PRE,
  name: 'Stop sharing a page',
  description:
    "Revoke a page's share link. The existing URL stops working immediately. No-op (still succeeds) if the page wasn't shared. Changes no one's access in the brain. Use when the user asks to unshare or unpublish a page.",
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
      const out = await closeLink(ctx, id);
      if (out.unshared) ctx.step?.setOutput(out);
      return { ok: true, output: out };
    } catch (err) {
      return { ok: false, error: linkError(err) };
    }
  },
};
