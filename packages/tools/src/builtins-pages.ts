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
  saveDraft,
  listBlocks,
  findBlock,
  replaceBlock,
  insertAfterBlock,
  deleteBlock,
  type PMBlockNode,
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

const page_replace_from_file: BuiltinToolDef = {
  slug: 'page_replace_from_file',
  name: 'Replace an existing page from a file',
  description:
    "Rebuild an EXISTING page's body from a markdown/text file's bytes. Writes the new body to `draft_doc` ONLY — the published `doc` is untouched until the operator commits. Like `page_from_file` but updates a target page instead of creating a new one. **The right tool for: 'this page is corrupted, reimport from the source file' / 'I re-exported this page from Notion, refresh it here'.** Bytes go server-side without round-tripping through your output, so this scales to any file size — the deterministic recovery path. Title / tags / icon stay as-is unless you pass replacements. Only text-like files are accepted (markdown / plain text); binaries are rejected.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'id of the existing page to rebuild' },
      file_id: { type: 'string', format: 'uuid', description: 'id of the file node holding the new body' },
      title: { type: 'string', description: 'optional new page title; omit to keep current' },
      tags: { type: 'array', items: { type: 'string' }, description: 'optional new tags; omit to keep current' },
      icon: { type: 'string', description: 'optional new emoji icon' },
    },
    required: ['page_id', 'file_id'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    const fileId = str(input.file_id).trim();
    if (!pageId) return { ok: false, error: 'page_id is required' };
    if (!fileId) return { ok: false, error: 'file_id is required' };

    // Verify the page exists + belongs to this owner BEFORE pulling file
    // bytes — clean 404 instead of an opaque draft-save failure.
    const page = await getPage(ctx.ownerId, pageId);
    if (!page) return { ok: false, error: `page ${pageId} not found` };

    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta) return { ok: false, error: `file ${fileId} not found` };
    if (!meta.isText) {
      return {
        ok: false,
        error:
          `page_replace_from_file: '${meta.filename}' is a binary file ` +
          `(mime='${meta.mimeType}') and cannot be imported as page content. ` +
          `Convert to markdown first.`,
      };
    }
    const res = await readFileById({ ownerId: ctx.ownerId, fileId });
    if (!res) return { ok: false, error: 'file bytes unavailable' };

    try {
      // Metadata patch — only if the caller asked. Goes directly to the
      // nodes row via updatePage (no doc field → published doc untouched).
      const metaPatch: Record<string, unknown> = {};
      if (typeof input.title === 'string' && input.title.trim()) {
        metaPatch.title = input.title.trim().slice(0, 200);
      }
      if (Array.isArray(input.tags)) metaPatch.tags = strArr(input.tags);
      if (typeof input.icon === 'string' && input.icon.trim()) {
        metaPatch.icon = input.icon.trim();
      }
      if (Object.keys(metaPatch).length > 0) {
        const r = await updatePage(ctx.ownerId, pageId, metaPatch);
        if (!r) return { ok: false, error: `page ${pageId} disappeared mid-call` };
      }

      // Body: bytes → doc → draft. saveDraft runs ensureBlockIds so the
      // imported content lands with stable per-block ids, ready for the
      // Phase 2b block tools + the editor diff view.
      const markdown = res.bytes.toString('utf8');
      const doc = markdownToDoc(markdown);
      const ok = await saveDraft(ctx.ownerId, pageId, doc);
      if (!ok) return { ok: false, error: `page ${pageId} disappeared mid-call` };

      ctx.step?.setOutput({
        page_id: pageId,
        source_file_id: fileId,
        source_byte_size: res.bytes.length,
        meta_updated: Object.keys(metaPatch).length > 0,
      });
      return {
        ok: true,
        output: {
          page_id: pageId,
          source_file_id: fileId,
          source_byte_size: res.bytes.length,
          meta_updated: Object.keys(metaPatch).length > 0,
          draft_saved: true,
          hint:
            `New body landed in DRAFT (${res.bytes.length} source bytes from ` +
            `'${meta.filename}'). Tell the user to open /pages/${pageId} to ` +
            `review; the editor shows the draft. Commit publishes the rebuild, ` +
            `Discard reverts to the current published doc.`,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_update: BuiltinToolDef = {
  slug: 'page_update',
  name: 'Update a page',
  description:
    "Update an existing page by id. **Pass ONLY the fields you're changing — every other field is left untouched.** Fixing the title? Pass `{ id, title }`, nothing else. Re-tagging? Pass `{ id, tags }`. Pass `markdown` ONLY when you intend to replace the whole body — re-emitting it just to bundle a metadata fix is wasted output tokens (a 5K-token body adds 5K tokens of cost + risks truncation). `markdown` REPLACES the body in one shot (re-converted, page re-indexed); use page_get first if you need to read the current content before crafting a replacement. **For styling/restyling/reformatting an existing page (callouts, columns, restructure), DELEGATE to the `pages` agent via `invoke_agent` instead — the pages agent writes to draft_doc only and won't silently overwrite the live page on a bad transform.**",
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

const page_update_draft: BuiltinToolDef = {
  slug: 'page_update_draft',
  name: 'Update a page (draft-only)',
  description:
    "Update an existing page WITHOUT publishing. Body changes (`markdown`) go to `draft_doc` — the published `doc` and its brain index are untouched until the operator opens the editor and commits. Metadata (`title` / `tags` / `icon`) updates apply directly (easily reversible if wrong). **The Pages agent uses this instead of `page_update` so a misbehaving transform can never silently overwrite the published page.** Pass ONLY the fields you're changing — every other field is left untouched. Returns a hint telling the user where to review the draft.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id' },
      title: { type: 'string' },
      markdown: {
        type: 'string',
        description: `Replacement body — written to draft_doc, NOT the published doc. ${MARKDOWN_HINT}`,
      },
      tags: { type: 'array', items: { type: 'string' } },
      icon: { type: 'string' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };

    // Metadata patch (low-risk, direct). Body change goes to draft separately.
    const metaPatch: Record<string, unknown> = {};
    if (typeof input.title === 'string') metaPatch.title = input.title.trim().slice(0, 200);
    if (Array.isArray(input.tags)) metaPatch.tags = strArr(input.tags);
    if (typeof input.icon === 'string') metaPatch.icon = input.icon.trim();

    let metaUpdated = false;
    if (Object.keys(metaPatch).length > 0) {
      try {
        const result = await updatePage(ctx.ownerId, id, metaPatch);
        if (!result) return { ok: false, error: `page ${id} not found` };
        metaUpdated = true;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // Body change → draft only. saveDraft writes to pages.draft_doc and
    // bumps draft_updated_at; the published `doc`, doc_text, summary,
    // embedding, entities all stay as they were.
    let draftSaved = false;
    if (typeof input.markdown === 'string') {
      try {
        const doc = markdownToDoc(input.markdown);
        const ok = await saveDraft(ctx.ownerId, id, doc);
        if (!ok) return { ok: false, error: `page ${id} not found` };
        draftSaved = true;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (!metaUpdated && !draftSaved) {
      return { ok: false, error: 'nothing to update — pass title, markdown, tags, or icon' };
    }

    ctx.step?.setOutput({ id, meta_updated: metaUpdated, draft_saved: draftSaved });
    return {
      ok: true,
      output: {
        id,
        ...(typeof metaPatch.title === 'string' ? { title: metaPatch.title } : {}),
        meta_updated: metaUpdated,
        draft_saved: draftSaved,
        ...(draftSaved
          ? {
              hint:
                `Body changes are in DRAFT only — the published page is unchanged. ` +
                `Tell the user to open /pages/${id} to review the proposed body; ` +
                `the editor shows the draft. Commit publishes, Discard reverts.`,
            }
          : {}),
      },
    };
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
    "Read one page by id. Returns the title, tags, summary, and the document as plaintext (`content`). To edit metadata only (title / tags / icon), use `page_update`. **For body styling or restyling on an existing page, delegate to the `pages` agent via `invoke_agent` — it writes to draft_doc only (preserves the live page) and is configured with the right model + safety rules for whole-doc transforms.** For block-level structure (which blocks exist, addressable by id) use `page_blocks_list` instead — lighter, no body returned.",
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

    // Title resolution: explicit arg wins; otherwise derive from filename.
    // Assistant + Telegram uploads land as
    //   '<unix-ms-timestamp>-<slug>-<hex-hash>.<ext>'
    // (the server's collision-safe naming scheme). The naive
    // strip-ext + dashes→spaces derivation surfaced that as a useless
    // 'Untitled' substitute — '1779877120189 he is the potter we are
    // the clay 3621047f3c9e80ba96a9e6f6c08'. Try to recover the slug
    // first; fall back to the naive form for hand-named uploads.
    const titleArg = str(input.title).trim();
    const baseName = (meta.filename ?? 'Untitled').replace(/\.[^.]+$/, '');
    const uploadPattern = /^\d{10,}-(.+?)-[a-f0-9]{20,}$/i;
    const uploadMatch = baseName.match(uploadPattern);
    const slugSource = uploadMatch ? uploadMatch[1]! : baseName;
    const derivedTitle =
      slugSource
        .replace(/[-_]+/g, ' ')
        .trim()
        .replace(/^./, (c) => c.toUpperCase()) || 'Untitled';
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

const page_blocks_list: BuiltinToolDef = {
  slug: 'page_blocks_list',
  name: 'List the blocks in a page',
  description:
    "Return a TOC-style flat listing of every addressable block in a page — `id`, `kind` (paragraph / heading / callout / table / …), `depth`, and a short text `preview`. Lightweight: the body itself is not returned, so this works regardless of page size. **Use this BEFORE proposing any block-level edit** so you know which blocks exist and can target them by stable id (Phase 2b block-edit tools land next). The ids returned here survive across edits — they are stable per block, not per read. Headings also include `meta.level`, code blocks `meta.language`, callouts `meta.variant`, task items `meta.checked`, images `meta.alt`. Use `max_depth: 1` for a high-level outline (only top-level blocks), omit for everything.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'page node id' },
      max_depth: {
        type: 'number',
        description:
          'optional depth cap — 1 = only top-level blocks (great for a page outline), 2 = top + first-nested (e.g. paragraphs inside callouts), default unlimited',
      },
      preview_chars: {
        type: 'number',
        description: 'optional cap on the per-block text preview, default 80',
      },
    },
    required: ['page_id'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    if (!pageId) return { ok: false, error: 'page_id is required' };
    const page = await getPage(ctx.ownerId, pageId);
    if (!page) return { ok: false, error: `page ${pageId} not found` };

    const maxDepth =
      typeof input.max_depth === 'number' && input.max_depth >= 1
        ? Math.min(10, Math.floor(input.max_depth))
        : undefined;
    const previewChars =
      typeof input.preview_chars === 'number' && input.preview_chars >= 10
        ? Math.min(400, Math.floor(input.preview_chars))
        : undefined;

    const blocks = listBlocks(page.doc as Record<string, unknown>, {
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(previewChars !== undefined ? { previewChars } : {}),
    });

    ctx.step?.setOutput({ id: page.id, block_count: blocks.length });
    return {
      ok: true,
      output: {
        id: page.id,
        title: page.title,
        block_count: blocks.length,
        blocks,
      },
    };
  },
};

/**
 * Pick the baseline doc for a block-edit op: the draft if one exists
 * (an in-flight editing session — the agent's previous edit + the user's
 * autosave land there), else the published doc. Block edits always
 * write back to draft_doc; the user reviews + commits.
 */
function pickEditingBaseline(page: { doc: Record<string, unknown>; draft: Record<string, unknown> | null }): Record<string, unknown> {
  return (page.draft ?? page.doc) as Record<string, unknown>;
}

const DRAFT_REVIEW_HINT = (pageId: string) =>
  `Edit applied to DRAFT — the published page is unchanged. Tell the ` +
  `user to open /pages/${pageId} to review; the editor shows the draft. ` +
  `Commit publishes, Discard reverts.`;

const page_block_get: BuiltinToolDef = {
  slug: 'page_block_get',
  name: 'Get one block from a page',
  description:
    "Read a single addressable block from a page by its id (from `page_blocks_list`). Returns the block's `kind`, depth, text content (plaintext, no formatting), structural `meta` (heading level / callout variant / etc.), and full PM `json` for fidelity-sensitive cases. Cheap: only the one block travels, not the whole page. **Use this BEFORE `page_block_update` so you craft the replacement with full knowledge of the current content.**",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'page node id' },
      block_id: { type: 'string', description: 'block id (from page_blocks_list)' },
    },
    required: ['page_id', 'block_id'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    const blockId = str(input.block_id).trim();
    if (!pageId || !blockId) return { ok: false, error: 'page_id and block_id are required' };
    const page = await getPage(ctx.ownerId, pageId);
    if (!page) return { ok: false, error: `page ${pageId} not found` };

    const baseline = pickEditingBaseline(page);
    const found = findBlock(baseline, blockId);
    if (!found) {
      return {
        ok: false,
        error:
          `block ${blockId} not found in page ${pageId}. The id may be stale ` +
          `(re-run page_blocks_list) or the user may have edited the page since.`,
      };
    }
    const text = docToText({ type: 'doc', content: [found.block] });
    ctx.step?.setOutput({ id: blockId, kind: found.block.type });
    return {
      ok: true,
      output: {
        page_id: pageId,
        block_id: blockId,
        kind: found.block.type,
        text,
        ...(found.block.attrs ? { meta: found.block.attrs } : {}),
        json: found.block,
      },
    };
  },
};

const page_block_update: BuiltinToolDef = {
  slug: 'page_block_update',
  name: 'Replace one block in a page',
  description:
    "Replace one block (by id) with new content (markdown). The first new block INHERITS the target's id so the next page_blocks_list still addresses the same logical slot. If your markdown produces multiple blocks (e.g. you wrap a paragraph in a heading + paragraph), they're all spliced in; subsequent blocks get fresh ids. Writes to DRAFT only — the published page is untouched until the user commits. **Output bytes are proportional to the new block, not the whole page** — this is the scalable edit path for large pages.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'page node id' },
      block_id: { type: 'string', description: 'block id to replace' },
      markdown: {
        type: 'string',
        description: `Replacement content. ${MARKDOWN_HINT} One or more blocks; the first inherits the target id.`,
      },
    },
    required: ['page_id', 'block_id', 'markdown'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    const blockId = str(input.block_id).trim();
    const markdown = str(input.markdown);
    if (!pageId || !blockId) return { ok: false, error: 'page_id and block_id are required' };
    if (!markdown) return { ok: false, error: 'markdown is required (cannot replace with nothing — use page_block_delete)' };

    const page = await getPage(ctx.ownerId, pageId);
    if (!page) return { ok: false, error: `page ${pageId} not found` };

    let parsedBlocks: unknown[];
    try {
      const parsed = markdownToDoc(markdown) as { content?: unknown[] };
      parsedBlocks = Array.isArray(parsed.content) ? parsed.content : [];
    } catch (err) {
      return { ok: false, error: `markdown parse failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (parsedBlocks.length === 0) {
      return { ok: false, error: 'markdown produced no blocks — nothing to splice' };
    }

    const baseline = pickEditingBaseline(page);
    const result = replaceBlock(
      baseline,
      blockId,
      parsedBlocks as PMBlockNode[],
    );
    if (!result.found) {
      return {
        ok: false,
        error: `block ${blockId} not found in page ${pageId}. Re-run page_blocks_list for current ids.`,
      };
    }
    try {
      const ok = await saveDraft(ctx.ownerId, pageId, result.doc);
      if (!ok) return { ok: false, error: `page ${pageId} not found (race?)` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    ctx.step?.setOutput({
      id: blockId,
      replaced_with_count: parsedBlocks.length,
    });
    return {
      ok: true,
      output: {
        page_id: pageId,
        block_id: blockId,
        replaced_with_count: parsedBlocks.length,
        draft_saved: true,
        hint: DRAFT_REVIEW_HINT(pageId),
      },
    };
  },
};

const page_block_insert_after: BuiltinToolDef = {
  slug: 'page_block_insert_after',
  name: 'Insert blocks after a target block',
  description:
    "Insert one or more new blocks (parsed from markdown) directly after the block with the given id. Useful for adding a callout after a quote, or a new section heading after the previous section ends. Writes to DRAFT only. New blocks get fresh ids on save.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'page node id' },
      after_block_id: { type: 'string', description: 'insert AFTER this block id' },
      markdown: {
        type: 'string',
        description: `Markdown for the new block(s). ${MARKDOWN_HINT}`,
      },
    },
    required: ['page_id', 'after_block_id', 'markdown'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    const afterId = str(input.after_block_id).trim();
    const markdown = str(input.markdown);
    if (!pageId || !afterId) return { ok: false, error: 'page_id and after_block_id are required' };
    if (!markdown) return { ok: false, error: 'markdown is required' };

    const page = await getPage(ctx.ownerId, pageId);
    if (!page) return { ok: false, error: `page ${pageId} not found` };

    let parsedBlocks: unknown[];
    try {
      const parsed = markdownToDoc(markdown) as { content?: unknown[] };
      parsedBlocks = Array.isArray(parsed.content) ? parsed.content : [];
    } catch (err) {
      return { ok: false, error: `markdown parse failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (parsedBlocks.length === 0) {
      return { ok: false, error: 'markdown produced no blocks' };
    }

    const baseline = pickEditingBaseline(page);
    const result = insertAfterBlock(
      baseline,
      afterId,
      parsedBlocks as PMBlockNode[],
    );
    if (!result.found) {
      return {
        ok: false,
        error: `block ${afterId} not found in page ${pageId}. Re-run page_blocks_list for current ids.`,
      };
    }
    try {
      const ok = await saveDraft(ctx.ownerId, pageId, result.doc);
      if (!ok) return { ok: false, error: `page ${pageId} not found (race?)` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    ctx.step?.setOutput({ after: afterId, inserted_count: parsedBlocks.length });
    return {
      ok: true,
      output: {
        page_id: pageId,
        after_block_id: afterId,
        inserted_count: parsedBlocks.length,
        draft_saved: true,
        hint: DRAFT_REVIEW_HINT(pageId),
      },
    };
  },
};

const page_block_delete: BuiltinToolDef = {
  slug: 'page_block_delete',
  name: 'Delete one block from a page',
  description:
    "Remove a single block (by id) from a page. Writes to DRAFT only. **Refuses** when removing the block would leave a container (callout / column / listItem / tableCell) empty — most ProseMirror schemas reject that. In that case, target the container itself instead.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'page node id' },
      block_id: { type: 'string', description: 'block id to delete' },
    },
    required: ['page_id', 'block_id'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    const blockId = str(input.block_id).trim();
    if (!pageId || !blockId) return { ok: false, error: 'page_id and block_id are required' };

    const page = await getPage(ctx.ownerId, pageId);
    if (!page) return { ok: false, error: `page ${pageId} not found` };

    const baseline = pickEditingBaseline(page);
    const result = deleteBlock(baseline, blockId);
    if (!result.found) {
      return {
        ok: false,
        error: `block ${blockId} not found in page ${pageId}. Re-run page_blocks_list for current ids.`,
      };
    }
    if (result.refused) {
      return { ok: false, error: result.reason ?? 'delete refused' };
    }
    try {
      const ok = await saveDraft(ctx.ownerId, pageId, result.doc);
      if (!ok) return { ok: false, error: `page ${pageId} not found (race?)` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    ctx.step?.setOutput({ id: blockId, deleted: true });
    return {
      ok: true,
      output: {
        page_id: pageId,
        block_id: blockId,
        deleted: true,
        draft_saved: true,
        hint: DRAFT_REVIEW_HINT(pageId),
      },
    };
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
  page_replace_from_file,
  page_update,
  page_update_draft,
  page_blocks_list,
  page_block_get,
  page_block_update,
  page_block_insert_after,
  page_block_delete,
  page_delete,
  page_list,
  page_get,
  page_share,
  page_unshare,
];

export const PAGE_TOOL_SLUGS: string[] = PAGE_TOOLS.map((t) => t.slug);
