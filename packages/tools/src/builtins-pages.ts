/**
 * Page builtins — let an agent author rich documents in the user's Mantle.
 * Pages store their body as ProseMirror JSON (`pages.doc`), so these wrap the
 * `@mantle/content` page CRUD and convert the agent's rich-markdown dialect to
 * that JSON via `markdownToDoc`. A page insert/commit fires `node_ingested`, so
 * the extractor indexes it (summary + embedding + facts + entities) like any
 * other content — created/updated pages are immediately searchable + recallable.
 *
 * The dialect (callouts/columns/tables/task-lists/highlights) is the same one
 * the rich_writing skill teaches and the /assistant renders, so a page Saskia
 * writes looks identical to the reply she showed in chat.
 */

import {
  createPage,
  updatePage,
  deletePage,
  getPage,
  listPages,
  markdownToDoc,
  docToText,
} from '@mantle/content';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}

const MARKDOWN_HINT =
  'Rich-markdown body. GFM markdown plus: callouts (`:::info` … `:::`, variants info|success|warning|danger), columns (`:::columns` … `+++` … `:::`, 2+ parts), task lists (`- [ ]` / `- [x]`), tables, and `==highlight==`. Same dialect you write replies in.';

const page_create: BuiltinToolDef = {
  slug: 'page_create',
  name: 'Create a page',
  description:
    "Create a rich document (a `page` node under /pages) in the user's Mantle. `title` required; `markdown` is the body in the rich dialect (callouts, columns, tables, task lists, highlights). The page is indexed into the brain — summary, embedding, facts, entities — so it becomes searchable and recallable. Prefer this over note_create when the content is long-form or structured (a plan, a doc, a comparison) that deserves real formatting; use note_create for quick plain-text captures.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'page title, e.g. "Q3 Launch Plan"' },
      markdown: { type: 'string', description: MARKDOWN_HINT },
      tags: { type: 'array', items: { type: 'string' } },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📄"' },
    },
    required: ['title'],
  },
  handler: async (input, ctx) => {
    const title = str(input.title).trim();
    if (!title) return { ok: false, error: 'title is required' };
    const markdown = str(input.markdown);
    const tags = strArr(input.tags);
    const icon = str(input.icon).trim();
    try {
      const doc = markdownToDoc(markdown);
      const page = await createPage(ctx.ownerId, {
        title: title.slice(0, 200),
        doc,
        tags,
        ...(icon ? { icon } : {}),
      });
      ctx.step?.setOutput({ id: page.id, title: page.title });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: page.id,
        summary: `Page created by tool: ${page.title}`,
        payload: {
          via: 'page_create_tool',
          tags,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: markdown,
      });
      return { ok: true, output: { id: page.id, title: page.title, tags: page.tags } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_update: BuiltinToolDef = {
  slug: 'page_update',
  name: 'Update a page',
  description:
    "Update an existing page by id. Any field omitted is left unchanged. Pass `markdown` to REPLACE the whole document body (it's re-converted and the page is re-indexed). Use page_get first to read the current content if you're making a targeted edit. `title`, `tags`, `icon` update metadata.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id (from page_list / page_create)' },
      title: { type: 'string' },
      markdown: { type: 'string', description: `Replacement body. ${MARKDOWN_HINT}` },
      tags: { type: 'array', items: { type: 'string' } },
      icon: { type: 'string' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const patch: Record<string, unknown> = {};
    if (typeof input.title === 'string') patch.title = input.title.trim().slice(0, 200);
    if (typeof input.markdown === 'string') patch.doc = markdownToDoc(input.markdown);
    if (Array.isArray(input.tags)) patch.tags = strArr(input.tags);
    if (typeof input.icon === 'string') patch.icon = input.icon.trim();
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: 'nothing to update — pass title, markdown, tags, or icon' };
    }
    try {
      const page = await updatePage(ctx.ownerId, id, patch);
      if (!page) return { ok: false, error: `page ${id} not found` };
      ctx.step?.setOutput({ id: page.id, title: page.title });
      return { ok: true, output: { id: page.id, title: page.title, tags: page.tags } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_delete: BuiltinToolDef = {
  slug: 'page_delete',
  name: 'Delete a page',
  description:
    'Permanently delete a page by id. This is irreversible — the document and its index entries are removed. Confirm with the user before calling.',
  // Destructive + irreversible: pause for operator approval by default. Flip
  // requires_confirm off in the tools table if you trust the agent fully.
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id to delete' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const ok = await deletePage(ctx.ownerId, id);
      if (!ok) return { ok: false, error: `page ${id} not found` };
      ctx.step?.setOutput({ id, deleted: true });
      return { ok: true, output: { id, deleted: true } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_list: BuiltinToolDef = {
  slug: 'page_list',
  name: 'List pages',
  description:
    "List the owner's pages, newest first. Optional `query` substring-matches title/body/summary; `tag` filters to pages carrying that tag. Bodies are omitted — use page_get for a page's content.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'substring match over title/body/summary' },
      tag: { type: 'string' },
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
          title: r.title,
          tags: r.tags,
          summary: r.summary,
          updatedAt: r.updatedAt,
        })),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_get: BuiltinToolDef = {
  slug: 'page_get',
  name: 'Get a page',
  description:
    'Read one page by id. Returns the title, tags, summary, and the document as plaintext (`content`). To edit it, send a full replacement body via page_update.',
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
      if (!page) return { ok: false, error: `page ${id} not found` };
      return {
        ok: true,
        output: {
          id: page.id,
          title: page.title,
          tags: page.tags,
          summary: page.summary,
          content: docToText(page.doc),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const PAGE_TOOLS: BuiltinToolDef[] = [
  page_create,
  page_update,
  page_delete,
  page_list,
  page_get,
];

export const PAGE_TOOL_SLUGS: string[] = PAGE_TOOLS.map((t) => t.slug);
