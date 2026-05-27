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
  createShare,
  revokeShare,
  getActiveShareForNode,
  shareUrlForToken,
} from '@mantle/content';
import { fileById, readFileById } from '@mantle/files';
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
    "Create a rich document (a `page` node under /pages) in the user's Mantle from content YOU compose. `title` required; `markdown` is the body in the rich dialect (callouts, columns, tables, task lists, highlights). The page is indexed into the brain — summary, embedding, facts, entities — so it becomes searchable and recallable. Prefer this over note_create when the content is long-form or structured (a plan, a doc, a comparison) that deserves real formatting; use note_create for quick plain-text captures. **For importing an existing file (Notion export, sermon markdown, etc.) use `page_from_file` instead — re-emitting the file body in this tool's `markdown` arg truncates silently above ~6 K output tokens.**",
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
    "List the owner's pages, **newest first**. Optional `query` substring-matches title/body/summary; `tag` filters to pages carrying that tag. Bodies are omitted to keep the response small. " +
    "**Use this to browse recent pages or filter by tag/substring.** For topic/semantic search across pages ('pages about the contract') use `search_nodes` with `type='page'` — that's similarity-ranked, not date-sorted. For a single page's full content use `page_get`.",
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

const page_from_file: BuiltinToolDef = {
  slug: 'page_from_file',
  name: 'Create page from file',
  description:
    "Create a page by importing a markdown/text file's bytes directly — the bytes go server-side from `files` → `markdownToDoc` → `createPage` without round-tripping through your output. **Always prefer this over `file_read` + `page_create` for file → page operations.** It scales to arbitrarily large files (a 100 KB Notion export imports in one tool call instead of choking on your max_tokens cap) and the result is byte-faithful to the source. Returns the new page's id + title; the body is never echoed back to you (use page_get if you need to verify content). Title defaults to the file's basename without extension if you omit it. Only text-like files are accepted (markdown / plain text) — binaries (PDF / docx / xlsx) are rejected with a clear error since their indexed text already lives on the file node and can't be losslessly converted to a page.",
  inputSchema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', format: 'uuid', description: 'id of the file node to import' },
      title: {
        type: 'string',
        description: 'page title; defaults to the file basename (without extension) if omitted',
      },
      tags: { type: 'array', items: { type: 'string' } },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📄"' },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    if (!fileId) return { ok: false, error: 'file_id is required' };
    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta) return { ok: false, error: `file ${fileId} not found` };
    if (!meta.isText) {
      return {
        ok: false,
        error:
          `page_from_file: '${meta.filename}' is a binary file (mime='${meta.mimeType}') ` +
          `and cannot be imported as a page. The extractor already indexes its parsed ` +
          `text on the file node; reference it via file_get instead, or convert the ` +
          `source to markdown first.`,
      };
    }
    const res = await readFileById({ ownerId: ctx.ownerId, fileId });
    if (!res) return { ok: false, error: 'file bytes unavailable' };

    // Title resolution: explicit arg wins; otherwise derive from filename
    // (strip extension, swap dashes/underscores for spaces, fall back to
    // 'Untitled' on the empty result).
    const titleArg = str(input.title).trim();
    const derivedTitle =
      (meta.filename ?? 'Untitled')
        .replace(/\.[^.]+$/, '')
        .replace(/[-_]+/g, ' ')
        .trim() || 'Untitled';
    const title = (titleArg || derivedTitle).slice(0, 200);

    const tags = strArr(input.tags);
    const icon = str(input.icon).trim();

    try {
      const markdown = res.bytes.toString('utf8');
      const doc = markdownToDoc(markdown);
      const page = await createPage(ctx.ownerId, {
        title,
        doc,
        tags,
        ...(icon ? { icon } : {}),
      });
      ctx.step?.setOutput({
        id: page.id,
        title: page.title,
        source_file_id: fileId,
        source_byte_size: res.bytes.length,
      });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: page.id,
        summary: `Page imported from file: ${page.title}`,
        payload: {
          via: 'page_from_file_tool',
          sourceFileId: fileId,
          sourceFilename: meta.filename,
          sourceByteSize: res.bytes.length,
          tags,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        // Cap the snippet so we don't bloat trace storage on a 100 KB import —
        // the full source is on the file node, retrievable via file_read.
        snippet: markdown.slice(0, 4000),
      });
      return {
        ok: true,
        output: {
          id: page.id,
          title: page.title,
          tags: page.tags,
          source_file_id: fileId,
          source_byte_size: res.bytes.length,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_share: BuiltinToolDef = {
  slug: 'page_share',
  name: 'Share a page publicly',
  description:
    "Create (or fetch) a public, read-only link to a page and return its URL. Anyone with the link can view the page — fully formatted, with no login — but nothing else in the user's Mantle. Idempotent: a page has at most one active link, so calling this again returns the same URL. Use when the user asks to share, publish, or get a shareable link for a page. To turn a link off, use page_unshare.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id (from page_list / page_create)' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const page = await getPage(ctx.ownerId, id);
      if (!page) return { ok: false, error: `page ${id} not found` };
      const share = await createShare(ctx.ownerId, id);
      const url = shareUrlForToken(share.token);
      ctx.step?.setOutput({ id, url });
      return { ok: true, output: { id, title: page.title, url, token: share.token } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_unshare: BuiltinToolDef = {
  slug: 'page_unshare',
  name: 'Stop sharing a page',
  description:
    "Revoke a page's public link. The existing URL stops working immediately. No-op (still succeeds) if the page wasn't shared. Use when the user asks to unshare, unpublish, or make a page private again.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id whose public link to revoke' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const share = await getActiveShareForNode(ctx.ownerId, id);
      if (!share) return { ok: true, output: { id, unshared: false } };
      const ok = await revokeShare(ctx.ownerId, share.id);
      ctx.step?.setOutput({ id, unshared: ok });
      return { ok: true, output: { id, unshared: ok } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const PAGE_TOOLS: BuiltinToolDef[] = [
  page_create,
  page_from_file,
  page_update,
  page_delete,
  page_list,
  page_get,
  page_share,
  page_unshare,
];

export const PAGE_TOOL_SLUGS: string[] = PAGE_TOOLS.map((t) => t.slug);
