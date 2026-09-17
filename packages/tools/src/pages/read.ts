/**
 * Reading pages: list and get.
 *
 * Split out of builtins-pages.ts; bodies moved verbatim.
 */

import { getPage, listPages, docToText, nodeUrl } from '@mantle/content';
import type { BuiltinToolDef } from '../types';
import { str } from '../coerce';
import { notFound } from '../errors';
import { errorMessage } from '@mantle/std';
import { PAGE_NODE_ID_PRE } from './common';

export const page_list: BuiltinToolDef = {
  slug: 'page_list',
  readOnly: true,
  name: 'List pages',
  description:
    "List the owner's pages, **newest first**. Optional `query` substring-matches title/body/summary; `tag` filters to pages carrying that tag. Bodies are omitted to keep the response small. " +
    "**Use this to browse recent pages or filter by tag/substring.** For topic/semantic search across pages ('pages about the contract') use `search_nodes` with `type='page'` — that's similarity-ranked, not date-sorted. For a single page's full content use `page_get`.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'substring match over title/body/summary' },
      tag: { type: 'string', description: 'Only return items carrying this tag.' },
      limit: { type: 'number', description: 'max rows (default 50)' },
    },
  },
  handler: async (input, ctx) => {
    const query = str(input.query).trim() || undefined;
    const tag = str(input.tag).trim() || undefined;
    const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(200, input.limit)) : 50;
    try {
      const rows = await listPages(ctx.ownerId, { query, tag, limit });
      ctx.step?.setOutput({ count: rows.length });
      return {
        ok: true,
        output: rows.map((r) => ({
          id: r.id,
          url: nodeUrl(r.id),
          title: r.title,
          tags: r.tags,
          summary: r.summary,
          updatedAt: r.updatedAt,
        })),
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const page_get: BuiltinToolDef = {
  slug: 'page_get',
  readOnly: true,
  preconditions: PAGE_NODE_ID_PRE,
  name: 'Get a page',
  description:
    'Read one page by id. Returns the title, tags, summary, and the document as plaintext (`content`). To edit metadata only (title / tags / icon), use `page_update`. **For body styling or restyling on an existing page, delegate to the `pages` agent via `invoke_agent` — it writes to draft_doc only (preserves the live page) and is configured with the right model + safety rules for whole-doc transforms.** For block-level structure (which blocks exist, addressable by id) use `page_blocks_list` instead — lighter, no body returned. Returns a `url` permalink — link the page as a markdown `[title](url)` when you reference it to the user.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const page = await getPage(ctx.ownerId, id);
      if (!page) return notFound('page', id, 'page_list / search_nodes');
      const hasDraft = page.draft !== null;
      return {
        ok: true,
        output: {
          id: page.id,
          title: page.title,
          tags: page.tags,
          summary: page.summary,
          url: nodeUrl(page.id),
          has_draft: hasDraft,
          ...(hasDraft && page.draftUpdatedAt ? { draft_updated_at: page.draftUpdatedAt } : {}),
          ...(hasDraft
            ? {
                note:
                  '`content` below is the PUBLISHED version. This page ALSO has uncommitted draft edits ' +
                  '(pending user review) — page_blocks_list and the block-edit tools operate on that draft, ' +
                  'so do not treat differences from `content` as missing work.',
              }
            : {}),
          content: docToText(page.doc),
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};
