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
  movePage,
  addPageMention,
  deletePage,
  getPage,
  listPages,
  markdownToDoc,
  docToText,
  saveDraft,
  splitPage,
  extractSectionToChild,
  listBlocks,
  findBlock,
  replaceBlock,
  insertAfterBlock,
  deleteBlock,
  type PMBlockNode,
  createShare,
  revokeShareTree,
  applyShareMode,
  setShareCascade,
  getActiveShareForNode,
  shareUrlForToken,
  nodeUrl,
  getNote,
  getJournal,
} from '@mantle/content';
import { fileById, readFileById } from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef } from './types';
import { str, strArr } from './coerce';
import { notFound } from './errors';
import type { ToolPrecondition } from './types';

// Shared referential preconditions (checked centrally in dispatch — see
// preconditions.ts): the id must name an EXISTING page the owner holds.
const PAGE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'page_id', nodeType: 'page', lookup: 'page_list / search_nodes' },
];
const PAGE_NODE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'page', lookup: 'page_list / search_nodes' },
];
const FILE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'file_id', nodeType: 'file', lookup: 'file_list / search_nodes' },
];
const NOTE_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'note_id', nodeType: 'note', lookup: 'note_list / search_nodes' },
];

const MARKDOWN_HINT =
  'Rich-markdown body. GFM markdown plus: callouts (`:::info` … `:::`, variants info|success|warning|danger), asides (`:::aside` … `:::`, a themed-gradient box; optional colour `:::aside chart-3`), columns (`:::columns` … `+++` … `:::`, 2+ parts), task lists (`- [ ]` / `- [x]`), tables, and `==highlight==`. Same dialect you write replies in.';

const page_create: BuiltinToolDef = {
  slug: 'page_create',
  name: 'Create a page',
  description:
    "Create a rich document (a `page` node under /pages) in the user's Mantle from content YOU compose. The page is indexed into the brain — summary, embedding, facts, entities — so it becomes searchable and recallable. To make a SUB-PAGE, pass `parent_id` (an existing page's id); omit for a top-level page. Prefer this over `note_create` when the content is long-form or structured (a plan, a doc, a comparison); use `note_create` for quick plain-text captures. **For importing an existing file use `page_from_file` instead — re-emitting the file body in `markdown` truncates silently above ~6 K output tokens. When the content already lives in a NOTE, use `page_from_note` — it copies the body server-side.**",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'page title, e.g. "Q3 Launch Plan"' },
      markdown: { type: 'string', description: MARKDOWN_HINT },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📄"' },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description:
          'optional — id of an existing page to nest this new page UNDER (creates a sub-page). Omit for a top-level page.',
      },
    },
    required: ['title'],
  },
  handler: async (input, ctx) => {
    const title = str(input.title).trim();
    if (!title) return { ok: false, error: 'title is required' };
    const markdown = str(input.markdown);
    const tags = strArr(input.tags);
    const icon = str(input.icon).trim();
    const parentId = str(input.parent_id).trim();
    try {
      const doc = markdownToDoc(markdown);
      const page = await createPage(ctx.ownerId, {
        title: title.slice(0, 200),
        doc,
        tags,
        ...(icon ? { icon } : {}),
        ...(parentId ? { parentId } : {}),
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
          ...(parentId ? { parentId } : {}),
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: markdown,
      });
      return {
        ok: true,
        output: {
          id: page.id,
          title: page.title,
          tags: page.tags,
          ...(parentId ? { parent_id: parentId } : {}),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // createPage throws ParentPageNotFoundError ("…parent page not found") when
      // parent_id isn't one of the owner's pages — surface that plainly.
      if (parentId && msg.includes('parent page not found')) {
        return {
          ok: false,
          error: `parent_id '${parentId}' is not one of your pages — pass the id of an existing page (see page_list / search_nodes).`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

const page_replace_from_file: BuiltinToolDef = {
  slug: 'page_replace_from_file',
  preconditions: [...PAGE_ID_PRE, ...FILE_ID_PRE],
  name: 'Replace an existing page from a file',
  description:
    "Rebuild an EXISTING page's body from a markdown/text file's bytes. Writes the new body to `draft_doc` ONLY — the published `doc` is untouched until the operator commits. Like `page_from_file` but updates a target page instead of creating a new one. **The right tool for: 'this page is corrupted, reimport from the source file' / 'I re-exported this page from Notion, refresh it here'.** Bytes go server-side without round-tripping through your output, so this scales to any file size — the deterministic recovery path. Title / tags / icon stay as-is unless you pass replacements. Only text-like files are accepted (markdown / plain text); binaries are rejected.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'id of the existing page to rebuild' },
      file_id: {
        type: 'string',
        format: 'uuid',
        description: 'id of the file node holding the new body',
      },
      title: { type: 'string', description: 'optional new page title; omit to keep current' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'optional new tags; omit to keep current',
      },
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
    if (!page) return notFound('page', pageId, 'page_list / search_nodes');

    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta) return notFound('file', fileId, 'file_list / search_nodes');
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
      // Intentionally UNCONDITIONAL (no baseRev): the new body is built wholesale
      // from the file bytes, never from a read of the page's current draft — this
      // tool's contract is a full-body replace, so there is no concurrent edit to
      // preserve. (Contrast the block-op tools, which DO thread baseRev.)
      const markdown = res.bytes.toString('utf8');
      const doc = markdownToDoc(markdown);
      const saved = await saveDraft(ctx.ownerId, pageId, doc);
      if (!saved.ok) return { ok: false, error: `page ${pageId} disappeared mid-call` };

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
  preconditions: PAGE_NODE_ID_PRE,
  description:
    "Update an existing page by id. **Pass ONLY the fields you're changing — every other field is left untouched.** Fixing the title? Pass `{ id, title }`, nothing else. Pass `markdown` ONLY when you intend to REPLACE the whole body in one shot (re-converted, page re-indexed) — re-emitting it just to bundle a metadata fix is wasted output tokens and risks truncation. Use `page_get` first if you need the current content before crafting a replacement. **For styling/restyling/reformatting an existing page (callouts, columns, restructure), DELEGATE to the `pages` agent via `invoke_agent` instead — the pages agent writes to draft_doc only and won't silently overwrite the live page on a bad transform.**",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id (from page_list / page_create)' },
      title: { type: 'string', description: 'new page title; replaces the current one' },
      markdown: { type: 'string', description: `Replacement body. ${MARKDOWN_HINT}` },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Labels for organisation and filtering, e.g. ['work']. Replaces the current tag set.",
      },
      icon: { type: 'string', description: 'new emoji icon, e.g. "📄"' },
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
      if (!page) return notFound('page', id, 'page_list / search_nodes');
      ctx.step?.setOutput({ id: page.id, title: page.title });
      return { ok: true, output: { id: page.id, title: page.title, tags: page.tags } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_update_draft: BuiltinToolDef = {
  slug: 'page_update_draft',
  preconditions: PAGE_NODE_ID_PRE,
  name: 'Update a page (draft-only)',
  description:
    "Update an existing page WITHOUT publishing. Body changes (`markdown`) go to `draft_doc` — the published `doc` and its brain index are untouched until the operator opens the editor and commits. Metadata (`title` / `tags` / `icon`) updates apply directly (easily reversible if wrong). **The Pages agent uses this instead of `page_update` so a misbehaving transform can never silently overwrite the published page.** Pass ONLY the fields you're changing — every other field is left untouched. Returns a hint telling the user where to review the draft.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id' },
      title: {
        type: 'string',
        description: 'new page title; replaces the current one (applies directly, not via draft)',
      },
      markdown: {
        type: 'string',
        description: `Replacement body — written to draft_doc, NOT the published doc. ${MARKDOWN_HINT}`,
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Labels for organisation and filtering, e.g. ['work']. Replaces the current tag set (applies directly, not via draft).",
      },
      icon: {
        type: 'string',
        description: 'new emoji icon, e.g. "📄" (applies directly, not via draft)',
      },
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
        if (!result) return notFound('page', id, 'page_list / search_nodes');
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
        // Intentionally UNCONDITIONAL (no baseRev): the draft is replaced wholesale
        // from agent-supplied markdown, never derived from a read of the current
        // draft — so there is no concurrent edit to lose. (The block-op tools, which
        // DO base their doc on a read, thread baseRev to guard the user's edits.)
        const doc = markdownToDoc(input.markdown);
        const res = await saveDraft(ctx.ownerId, id, doc);
        if (!res.ok) return notFound('page', id, 'page_list / search_nodes');
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
  preconditions: PAGE_NODE_ID_PRE,
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
      if (!ok) return notFound('page', id, 'page_list / search_nodes');
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_from_file: BuiltinToolDef = {
  slug: 'page_from_file',
  preconditions: FILE_ID_PRE,
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
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📄"' },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    if (!fileId) return { ok: false, error: 'file_id is required' };
    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta) return notFound('file', fileId, 'file_list / search_nodes');
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

const page_from_note: BuiltinToolDef = {
  slug: 'page_from_note',
  preconditions: NOTE_ID_PRE,
  name: 'Create page from note',
  description:
    "Promote an EXISTING note into a rich page — the note's body is copied server-side WITHOUT round-tripping through your output, byte-faithful however long the note is. **Always prefer this over `note_get` + `page_create` when the user wants a note turned into a page** — you pass the note id, NOT its text. Pass `parent_id` to nest the new page UNDER an existing page. Title/tags default to the note's own unless you override. The original note is LEFT IN PLACE (non-destructive). Returns the new page's id + title; the body is never echoed back (verify with `page_get`). **When delegating, hand off the note id + parent id only — never paste the note body into the prompt.**",
  inputSchema: {
    type: 'object',
    properties: {
      note_id: { type: 'string', format: 'uuid', description: 'id of the note to promote' },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description:
          'optional id of an existing page to nest the new page UNDER (makes it a sub-page); omit for top-level',
      },
      title: {
        type: 'string',
        description: "page title; defaults to the note's title if omitted",
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "page tags; defaults to the note's tags if omitted",
      },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📄"' },
    },
    required: ['note_id'],
  },
  handler: async (input, ctx) => {
    const noteId = str(input.note_id).trim();
    if (!noteId) return { ok: false, error: 'note_id is required' };

    const note = await getNote(ctx.ownerId, noteId);
    if (!note) {
      return {
        ok: false,
        error: `note ${noteId} not found — pass the id of an existing note (see note_list / search_nodes).`,
      };
    }

    const parentId = str(input.parent_id).trim();
    const titleArg = str(input.title).trim();
    const title = (titleArg || note.title || 'Untitled').slice(0, 200);
    const tagsArg = strArr(input.tags);
    const tags = tagsArg.length ? tagsArg : note.tags;
    const icon = str(input.icon).trim();

    try {
      const doc = markdownToDoc(note.content);
      const page = await createPage(ctx.ownerId, {
        title,
        doc,
        tags,
        ...(icon ? { icon } : {}),
        ...(parentId ? { parentId } : {}),
      });
      ctx.step?.setOutput({
        id: page.id,
        title: page.title,
        source_note_id: noteId,
        ...(parentId ? { parent_id: parentId } : {}),
      });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: page.id,
        summary: `Page created from note: ${page.title}`,
        payload: {
          via: 'page_from_note_tool',
          sourceNoteId: noteId,
          ...(parentId ? { parentId } : {}),
          tags,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: note.content.slice(0, 4000),
      });
      return {
        ok: true,
        output: {
          id: page.id,
          title: page.title,
          tags: page.tags,
          source_note_id: noteId,
          ...(parentId ? { parent_id: parentId } : {}),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // createPage throws ParentPageNotFoundError when parent_id isn't one of
      // the owner's pages — surface that plainly (mirrors page_create).
      if (parentId && msg.includes('parent page not found')) {
        return {
          ok: false,
          error: `parent_id '${parentId}' is not one of your pages — pass the id of an existing page (see page_list / search_nodes).`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

const page_from_notes: BuiltinToolDef = {
  slug: 'page_from_notes',
  name: 'Create page from several notes',
  description:
    "Stitch SEVERAL existing notes into ONE rich page — every note's body is copied server-side and concatenated in the order given, byte-faithful at any size. **Prefer this over `note_get` + re-typing into `page_create`** — you pass the note ids, NOT their text. Each note becomes a section under an `## ` heading from its title; `headings: false` concatenates the bodies raw. Pass `parent_id` to nest under an existing page. Tags default to the union of the source notes' tags. The originals are LEFT IN PLACE. Returns the new page's id + title; the body is never echoed back (verify with `page_get`). **When delegating, hand off note ids + title + parent id only — never paste note bodies.**",
  inputSchema: {
    type: 'object',
    properties: {
      note_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        description: 'ids of the notes to combine, in the order they should appear in the page',
      },
      title: { type: 'string', description: 'title for the combined page (required)' },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description:
          'optional id of an existing page to nest the new page UNDER (makes it a sub-page); omit for top-level',
      },
      headings: {
        type: 'boolean',
        description:
          "insert each note's title as an `## ` section heading above its body (default true); set false to concatenate bodies raw",
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "page tags; defaults to the union of the source notes' tags if omitted",
      },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📄"' },
    },
    required: ['note_ids', 'title'],
  },
  handler: async (input, ctx) => {
    const noteIds = strArr(input.note_ids)
      .map((id) => id.trim())
      .filter(Boolean);
    if (noteIds.length === 0) {
      return { ok: false, error: 'note_ids is required — pass at least one note id.' };
    }
    const title = str(input.title).trim().slice(0, 200);
    if (!title) {
      return {
        ok: false,
        error:
          'title is required when combining multiple notes (no single source note to borrow it from).',
      };
    }

    // Fetch all notes up front so a bad id fails the whole call cleanly rather
    // than producing a half-built page. Order is preserved from note_ids.
    const fetched = await Promise.all(noteIds.map((id) => getNote(ctx.ownerId, id)));
    const missing = noteIds.filter((_, i) => !fetched[i]);
    if (missing.length) {
      return {
        ok: false,
        error: `note(s) not found: ${missing.join(', ')} — pass ids of existing notes (see note_list / search_nodes).`,
      };
    }
    const notes = fetched as NonNullable<(typeof fetched)[number]>[];

    const parentId = str(input.parent_id).trim();
    const withHeadings = input.headings === undefined ? true : input.headings === true;
    const tagsArg = strArr(input.tags);
    const tags = tagsArg.length ? tagsArg : [...new Set(notes.flatMap((n) => n.tags))];
    const icon = str(input.icon).trim();

    const markdown = notes
      .map((n) => {
        const body = n.content.trim();
        if (!withHeadings) return body;
        const heading = `## ${(n.title || 'Untitled').trim()}`;
        return body ? `${heading}\n\n${body}` : heading;
      })
      .join('\n\n');

    try {
      const doc = markdownToDoc(markdown);
      const page = await createPage(ctx.ownerId, {
        title,
        doc,
        tags,
        ...(icon ? { icon } : {}),
        ...(parentId ? { parentId } : {}),
      });
      ctx.step?.setOutput({
        id: page.id,
        title: page.title,
        source_note_ids: noteIds,
        note_count: notes.length,
        ...(parentId ? { parent_id: parentId } : {}),
      });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: page.id,
        summary: `Page compiled from ${notes.length} notes: ${page.title}`,
        payload: {
          via: 'page_from_notes_tool',
          sourceNoteIds: noteIds,
          noteCount: notes.length,
          ...(parentId ? { parentId } : {}),
          tags,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: markdown.slice(0, 4000),
      });
      return {
        ok: true,
        output: {
          id: page.id,
          title: page.title,
          tags: page.tags,
          source_note_ids: noteIds,
          note_count: notes.length,
          ...(parentId ? { parent_id: parentId } : {}),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parentId && msg.includes('parent page not found')) {
        return {
          ok: false,
          error: `parent_id '${parentId}' is not one of your pages — pass the id of an existing page (see page_list / search_nodes).`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

const page_from_journal: BuiltinToolDef = {
  slug: 'page_from_journal',
  name: 'Create page from journal entries',
  description:
    "Compile SEVERAL Journal entries into ONE page — each entry's body is copied server-side and concatenated in the order given, byte-faithful at any size. The journal counterpart of `page_from_notes` — for 'compile this week's entries into a reflection doc'. You pass entry ids (from `journal_list`), NOT their text. Each entry lands under a date(+title) `## ` heading; `headings: false` concatenates raw. Pass `parent_id` to nest under an existing page. Tags default to the union of the source entries'. The originals are LEFT IN PLACE. Returns the new page's id + title; the body is never echoed back (verify with `page_get`). **When delegating, hand off entry ids + title + parent id only — never paste entry bodies.**",
  inputSchema: {
    type: 'object',
    properties: {
      journal_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        description:
          'ids of the journal entries to compile, in the order they should appear (see journal_list)',
      },
      title: { type: 'string', description: 'title for the compiled page (required)' },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description:
          'optional id of an existing page to nest the new page UNDER; omit for top-level',
      },
      headings: {
        type: 'boolean',
        description:
          'section each entry under a date(+title) `## ` heading (default true); set false to concatenate bodies raw',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "page tags; defaults to the union of the source entries' tags if omitted",
      },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📔"' },
    },
    required: ['journal_ids', 'title'],
  },
  handler: async (input, ctx) => {
    const journalIds = strArr(input.journal_ids)
      .map((id) => id.trim())
      .filter(Boolean);
    if (journalIds.length === 0) {
      return { ok: false, error: 'journal_ids is required — pass at least one journal entry id.' };
    }
    const title = str(input.title).trim().slice(0, 200);
    if (!title) {
      return {
        ok: false,
        error:
          'title is required when compiling journal entries (no single source to borrow it from).',
      };
    }

    // Fetch all entries up front so a bad id fails the whole call cleanly
    // rather than producing a half-built page. Order is preserved from input.
    const fetched = await Promise.all(journalIds.map((id) => getJournal(ctx.ownerId, id)));
    const missing = journalIds.filter((_, i) => !fetched[i]);
    if (missing.length) {
      return {
        ok: false,
        error: `journal entry(ies) not found: ${missing.join(', ')} — pass ids of existing entries (see journal_list / search_nodes).`,
      };
    }
    const entries = fetched as NonNullable<(typeof fetched)[number]>[];

    const parentId = str(input.parent_id).trim();
    const withHeadings = input.headings === undefined ? true : input.headings === true;
    const tagsArg = strArr(input.tags);
    const tags = tagsArg.length ? tagsArg : [...new Set(entries.flatMap((e) => e.tags))];
    const icon = str(input.icon).trim();

    const markdown = entries
      .map((e) => {
        const body = e.body.trim();
        if (!withHeadings) return body;
        // Date-first heading (entries are a chronological log); append the
        // title when it carries more than the auto-derived date would.
        const date = (e.entryDate ?? e.createdAt ?? '').slice(0, 10);
        const t = (e.title || '').trim();
        const heading = `## ${[date, t].filter(Boolean).join(' — ') || 'Entry'}`;
        return body ? `${heading}\n\n${body}` : heading;
      })
      .join('\n\n');

    try {
      const doc = markdownToDoc(markdown);
      const page = await createPage(ctx.ownerId, {
        title,
        doc,
        tags,
        ...(icon ? { icon } : {}),
        ...(parentId ? { parentId } : {}),
      });
      ctx.step?.setOutput({
        id: page.id,
        title: page.title,
        source_journal_ids: journalIds,
        entry_count: entries.length,
        ...(parentId ? { parent_id: parentId } : {}),
      });
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: page.id,
        summary: `Page compiled from ${entries.length} journal entries: ${page.title}`,
        payload: {
          via: 'page_from_journal_tool',
          sourceJournalIds: journalIds,
          entryCount: entries.length,
          ...(parentId ? { parentId } : {}),
          tags,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: markdown.slice(0, 4000),
      });
      return {
        ok: true,
        output: {
          id: page.id,
          title: page.title,
          tags: page.tags,
          source_journal_ids: journalIds,
          entry_count: entries.length,
          ...(parentId ? { parent_id: parentId } : {}),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parentId && msg.includes('parent page not found')) {
        return {
          ok: false,
          error: `parent_id '${parentId}' is not one of your pages — pass the id of an existing page (see page_list / search_nodes).`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

const page_blocks_list: BuiltinToolDef = {
  slug: 'page_blocks_list',
  preconditions: PAGE_ID_PRE,
  name: 'List the blocks in a page',
  description:
    "Return a TOC-style flat listing of every addressable block in a page — `id`, `kind`, `depth`, a short text `preview`, and structural `meta`. Lightweight: the body itself is not returned. **Lists the SAME baseline the block-edit tools operate on: the uncommitted DRAFT when one exists, else the published doc** — `baseline` in the output says which, so the ids are always valid targets for `page_block_get`/update/delete. **Use this BEFORE proposing any block-level edit**; ids are stable per block and survive across edits. **`kinds` is the SCALING knob — pass only the block types you care about** (e.g. `['heading']` for an outline): an unfiltered 300-block listing approaches 80 KB and costs extra paging turns. `max_depth: 1` is the other compactor.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'page node id' },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description:
          "optional kind filter — only blocks whose `kind` is in this array are returned. The walker still descends through other types, so nested matches are found. Common picks: ['blockquote'], ['heading'], ['callout'], ['paragraph']. Combine multiple kinds in one call when relevant.",
      },
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
    if (!page) return notFound('page', pageId, 'page_list / search_nodes');

    const maxDepth =
      typeof input.max_depth === 'number' && input.max_depth >= 1
        ? Math.min(10, Math.floor(input.max_depth))
        : undefined;
    const previewChars =
      typeof input.preview_chars === 'number' && input.preview_chars >= 10
        ? Math.min(400, Math.floor(input.preview_chars))
        : undefined;
    const kinds = Array.isArray(input.kinds)
      ? input.kinds.filter((k): k is string => typeof k === 'string' && k.length > 0)
      : [];

    // List from the SAME baseline the block-edit tools use (draft when one
    // exists). Listing page.doc here while get/update/delete edited the draft
    // is exactly how an agent once declared a broken draft "clean" — the
    // listing hid the draft's state and every id it returned was potentially
    // stale for the tools that followed (SOP-restructure incident, 2026-07-06).
    const baseline = pickEditingBaseline(page);
    const blocks = listBlocks(baseline, {
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(previewChars !== undefined ? { previewChars } : {}),
      ...(kinds.length > 0 ? { kinds } : {}),
    });

    const hasDraft = page.draft !== null;
    ctx.step?.setOutput({
      id: page.id,
      block_count: blocks.length,
      baseline: hasDraft ? 'draft' : 'published',
    });
    return {
      ok: true,
      output: {
        id: page.id,
        title: page.title,
        baseline: hasDraft ? 'draft' : 'published',
        has_draft: hasDraft,
        ...(hasDraft && page.draftUpdatedAt ? { draft_updated_at: page.draftUpdatedAt } : {}),
        ...(hasDraft
          ? {
              note:
                'This page has UNCOMMITTED draft edits — the listing (and all block-edit tools) reflect the draft, ' +
                'not the published doc. The user sees the draft in the editor and decides to commit or discard.',
            }
          : {}),
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
function pickEditingBaseline(page: {
  doc: Record<string, unknown>;
  draft: Record<string, unknown> | null;
}): Record<string, unknown> {
  return (page.draft ?? page.doc) as Record<string, unknown>;
}

const DRAFT_REVIEW_HINT = (pageId: string) =>
  `Edit applied to DRAFT — the published page is unchanged. Tell the ` +
  `user to open /pages/${pageId} to review; the editor shows the draft. ` +
  `Commit publishes, Discard reverts.`;

/**
 * The draft moved between our read and our conditional save — a user autosave
 * (or another agent op) bumped `draft_rev` under us, so `saveDraft` refused
 * rather than clobber it (optimistic concurrency, audit item #3). The block ops
 * computed their new doc from the stale baseline, so a blind retry would clobber
 * just the same: the correct merge point is the AGENT re-reading. Bounce it back
 * with that instruction — never auto-retry here.
 */
const draftConflict = (pageId: string): { ok: false; error: string } => ({
  ok: false,
  error:
    `page ${pageId} changed since you read it — a concurrent edit (a user autosave ` +
    `in the editor, or another block op) advanced the draft. Your change was ` +
    `computed against the older content and was NOT saved (saving it would have ` +
    `silently overwritten that edit). Re-read the page with page_blocks_list ` +
    `(or page_get for one block), re-apply your edit against the current content, ` +
    `then re-issue.`,
});

const page_block_get: BuiltinToolDef = {
  slug: 'page_block_get',
  preconditions: PAGE_ID_PRE,
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
    if (!page) return notFound('page', pageId, 'page_list / search_nodes');

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
  preconditions: PAGE_ID_PRE,
  name: 'Replace one block in a page',
  description:
    "Replace one block (by id) with new content (markdown). The first new block INHERITS the target's id so the next page_blocks_list still addresses the same logical slot. If your markdown produces multiple blocks (e.g. you wrap a paragraph in a heading + paragraph), they're all spliced in; subsequent blocks get fresh ids. Writes to DRAFT only — the published page is untouched until the user commits. **Output bytes are proportional to the new block, not the whole page** — this is the scalable edit path for TARGETED edits on large pages. **For a restructure touching more than ~10 blocks (resequencing / renumbering / merging sections), switch to ONE whole-body `page_update_draft` call instead — block-by-block surgery at that scale exhausts the turn's tool-call budget and strands the draft half-edited.** " +
    "⚠️ **MARKDOWN MUST INCLUDE THE STRUCTURAL PREFIX of the kind you want to keep.** If you're updating an `h2` heading and you submit `markdown: '📖 Title'`, the result is a PARAGRAPH (the heading is gone) — markdown without a `##` prefix parses as a paragraph. To keep block kind on the same edit: heading → `## new text`, h3 → `### new text`, blockquote → `> new text`, info callout → `:::info\\nnew text\\n:::`, bullet list item → `- new text` (wrap in a single-item list), code block → ```\\nnew code\\n```. Pre-flight check before each call: imagine your markdown rendered standalone — does the FIRST block produced match the kind you're replacing? If you intend to CHANGE the kind (e.g. heading → callout), that's a valid use; just be deliberate. If you intend to KEEP the kind, the structural prefix is part of the content.",
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
    if (!markdown)
      return {
        ok: false,
        error: 'markdown is required (cannot replace with nothing — use page_block_delete)',
      };

    const page = await getPage(ctx.ownerId, pageId);
    if (!page) return notFound('page', pageId, 'page_list / search_nodes');

    let parsedBlocks: unknown[];
    try {
      const parsed = markdownToDoc(markdown) as { content?: unknown[] };
      parsedBlocks = Array.isArray(parsed.content) ? parsed.content : [];
    } catch (err) {
      return {
        ok: false,
        error: `markdown parse failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (parsedBlocks.length === 0) {
      return { ok: false, error: 'markdown produced no blocks — nothing to splice' };
    }

    const baseline = pickEditingBaseline(page);
    // Rev of the draft we just read (0 when none) — threaded into saveDraft so a
    // user autosave that lands between this read and our write is not clobbered.
    const baseRev = page.draftRev ?? 0;
    const result = replaceBlock(baseline, blockId, parsedBlocks as PMBlockNode[]);
    if (!result.found) {
      return {
        ok: false,
        error: `block ${blockId} not found in page ${pageId}. Re-run page_blocks_list for current ids.`,
      };
    }
    try {
      const res = await saveDraft(ctx.ownerId, pageId, result.doc, { baseRev });
      if (!res.ok) {
        if ('conflict' in res) return draftConflict(pageId);
        return { ok: false, error: `page ${pageId} not found (race?)` };
      }
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
  preconditions: PAGE_ID_PRE,
  name: 'Insert blocks after a target block',
  description:
    'Insert one or more new blocks (parsed from markdown) directly after the block with the given id. Useful for adding a callout after a quote, or a new section heading after the previous section ends. Writes to DRAFT only. New blocks get fresh ids on save.',
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
    if (!page) return notFound('page', pageId, 'page_list / search_nodes');

    let parsedBlocks: unknown[];
    try {
      const parsed = markdownToDoc(markdown) as { content?: unknown[] };
      parsedBlocks = Array.isArray(parsed.content) ? parsed.content : [];
    } catch (err) {
      return {
        ok: false,
        error: `markdown parse failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (parsedBlocks.length === 0) {
      return { ok: false, error: 'markdown produced no blocks' };
    }

    const baseline = pickEditingBaseline(page);
    // Rev of the draft we just read (0 when none) — threaded into saveDraft so a
    // user autosave that lands between this read and our write is not clobbered.
    const baseRev = page.draftRev ?? 0;
    const result = insertAfterBlock(baseline, afterId, parsedBlocks as PMBlockNode[]);
    if (!result.found) {
      return {
        ok: false,
        error: `block ${afterId} not found in page ${pageId}. Re-run page_blocks_list for current ids.`,
      };
    }
    try {
      const res = await saveDraft(ctx.ownerId, pageId, result.doc, { baseRev });
      if (!res.ok) {
        if ('conflict' in res) return draftConflict(pageId);
        return { ok: false, error: `page ${pageId} not found (race?)` };
      }
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
  preconditions: PAGE_ID_PRE,
  name: 'Delete one block from a page',
  description:
    'Remove a single block (by id) from a page. Writes to DRAFT only. **Refuses** when removing the block would leave a container (callout / column / listItem / tableCell) empty — most ProseMirror schemas reject that. In that case, target the container itself instead.',
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
    if (!page) return notFound('page', pageId, 'page_list / search_nodes');

    const baseline = pickEditingBaseline(page);
    // Rev of the draft we just read (0 when none) — threaded into saveDraft so a
    // user autosave that lands between this read and our write is not clobbered.
    const baseRev = page.draftRev ?? 0;
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
      const res = await saveDraft(ctx.ownerId, pageId, result.doc, { baseRev });
      if (!res.ok) {
        if ('conflict' in res) return draftConflict(pageId);
        return { ok: false, error: `page ${pageId} not found (race?)` };
      }
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

/** Upper bound on ops per batch — big enough for real jobs (the 47-quote
 *  wrap, a 40-block renumber), small enough that a runaway payload is
 *  refused with guidance instead of accepted. */
const MAX_APPLY_OPS = 50;

const page_blocks_apply: BuiltinToolDef = {
  slug: 'page_blocks_apply',
  preconditions: PAGE_ID_PRE,
  name: 'Apply a batch of block edits to a page (atomic)',
  description:
    "Apply MANY block edits to one page in a SINGLE atomic call — the batch path between one-off block tools and a whole-body `page_update_draft` rewrite. `ops` is an ordered list of `{ op: 'update' | 'insert_after' | 'delete', block_id, markdown? }` applied sequentially against the editing baseline; the draft is saved ONCE at the end, so the batch is all-or-nothing: if any op fails (unknown block id, bad markdown, refused delete) NOTHING is saved and the error names the failing op's index. " +
    "**Use this for multi-block targeted edits** — wrap every quote, retitle several sections, delete a scattered set — up to 50 ops. One call replaces up to 50 individual block calls, so it cannot be severed mid-edit by the turn's tool-call budget. For a full restructure (resequencing, merging sections) still prefer ONE `page_update_draft`. " +
    "`block_id`s come from `page_blocks_list` (the baseline) — or, when chaining batches, from the PREVIOUS batch's `created_ids` output, which maps each op to the ids of the blocks it created (`deleted_ids` lists what's gone). Anchor follow-up batches on those instead of re-listing; a block deleted earlier in the SAME batch can't be referenced later in it. Same markdown rules as `page_block_update` — include the structural prefix (`##`, `>`, `:::info`, …) when you mean to KEEP the block's kind; on 'update' the first new block inherits the target's id.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'page node id' },
      ops: {
        type: 'array',
        description: `Ordered edits, applied sequentially (max ${MAX_APPLY_OPS}).`,
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['update', 'insert_after', 'delete'],
              description:
                "the edit to perform at `block_id`; 'update' and 'insert_after' also need `markdown`",
            },
            block_id: {
              type: 'string',
              description:
                "target block id from page_blocks_list; for 'insert_after' the new blocks land AFTER this block",
            },
            markdown: {
              type: 'string',
              description:
                "content for 'update' / 'insert_after' (required there, ignored on 'delete'). Keep the structural prefix to preserve block kind.",
            },
          },
          required: ['op', 'block_id'],
        },
      },
    },
    required: ['page_id', 'ops'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    if (!pageId) return { ok: false, error: 'page_id is required' };
    const opsIn = Array.isArray(input.ops) ? (input.ops as unknown[]) : null;
    if (!opsIn || opsIn.length === 0) {
      return {
        ok: false,
        error:
          "ops is required — a non-empty array of { op: 'update'|'insert_after'|'delete', block_id, markdown? }",
      };
    }
    if (opsIn.length > MAX_APPLY_OPS) {
      return {
        ok: false,
        error:
          `ops has ${opsIn.length} entries (max ${MAX_APPLY_OPS}). Split into two batches — ` +
          `or, for a full-document restructure, use ONE page_update_draft call instead.`,
      };
    }

    const page = await getPage(ctx.ownerId, pageId);
    if (!page) return notFound('page', pageId, 'page_list / search_nodes');

    let doc = pickEditingBaseline(page);
    // Rev of the draft this whole batch is computed against (0 when none) — the
    // single conditional save at the end conflicts (rather than clobbers) if a
    // user autosave lands while the batch is assembling.
    const baseRev = page.draftRev ?? 0;
    const counts = { updated: 0, inserted: 0, deleted: 0 };
    // Chaining record: multi-batch jobs died on stale anchors in the wild (a
    // 2026-07-08 pilot-deployment turn burned 4 batches re-listing after its own
    // earlier chunks consumed the anchors). markdownToDoc parse-mints ids, so the ids
    // of every block this batch creates are known BEFORE save — returning
    // them lets the next batch anchor on this one's output with no re-list.
    const createdIds: Array<{ op: number; ids: string[] }> = [];
    const deletedIds: string[] = [];
    // On a not-found failure, pre-scan the REMAINING ops against the evolved
    // doc so ALL doomed ids surface in ONE error instead of one per retry.
    const staleRemainderNote = (from: number): string => {
      const stale: string[] = [];
      for (let j = from; j < opsIn.length; j++) {
        const o = (opsIn[j] && typeof opsIn[j] === 'object' ? opsIn[j] : {}) as Record<
          string,
          unknown
        >;
        const bid = str(o.block_id).trim();
        if (bid && !findBlock(doc, bid)) stale.push(`op ${j} (${bid})`);
      }
      if (stale.length === 0) return '';
      return (
        ` Later ops reference ids ALSO missing from the current baseline and will fail the ` +
        `same way: ${stale.join(', ')} — refresh every id from ONE new page_blocks_list ` +
        `(or the previous batch's created_ids) before re-issuing`
      );
    };
    for (let i = 0; i < opsIn.length; i++) {
      const raw = opsIn[i];
      const op = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const kind = str(op.op).trim();
      const blockId = str(op.block_id).trim();
      // Atomicity is the contract: any failure aborts BEFORE saveDraft, so
      // the teaching error can promise "nothing was saved" truthfully.
      const fail = (msg: string): { ok: false; error: string } => ({
        ok: false,
        error:
          `op ${i}${kind ? ` ('${kind}'` + (blockId ? ` ${blockId}` : '') + ')' : ''}: ${msg}. ` +
          `The batch is atomic — NOTHING was saved. Fix this op and re-issue the whole batch.`,
      });
      if (!blockId) return fail('block_id is required');
      if (kind === 'update' || kind === 'insert_after') {
        const markdown = str(op.markdown);
        if (!markdown) {
          return fail(
            `markdown is required for '${kind}'` +
              (kind === 'update' ? " (to remove the block use op:'delete')" : ''),
          );
        }
        let parsedBlocks: unknown[];
        try {
          const parsed = markdownToDoc(markdown) as { content?: unknown[] };
          parsedBlocks = Array.isArray(parsed.content) ? parsed.content : [];
        } catch (err) {
          return fail(`markdown parse failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (parsedBlocks.length === 0) return fail('markdown produced no blocks');
        const result =
          kind === 'update'
            ? replaceBlock(doc, blockId, parsedBlocks as PMBlockNode[])
            : insertAfterBlock(doc, blockId, parsedBlocks as PMBlockNode[]);
        if (!result.found) {
          return fail(
            `block not found in page ${pageId} — re-run page_blocks_list for current ids ` +
              `(an earlier delete in this batch removes its id; a previous batch's new ` +
              `blocks are addressable via its created_ids output).` +
              staleRemainderNote(i + 1),
          );
        }
        doc = result.doc;
        // Top-level ids of the spliced fragment (parse-minted). On 'update'
        // the FIRST block inherits the target's id (replaceBlock invariant),
        // so only blocks 1..n are newly addressable.
        const topIds = (parsedBlocks as Array<{ attrs?: { id?: unknown } }>)
          .map((b) => b?.attrs?.id)
          .filter((x): x is string => typeof x === 'string');
        const newIds = kind === 'update' ? topIds.slice(1) : topIds;
        if (newIds.length > 0) createdIds.push({ op: i, ids: newIds });
        if (kind === 'update') counts.updated += 1;
        else counts.inserted += parsedBlocks.length;
      } else if (kind === 'delete') {
        const result = deleteBlock(doc, blockId);
        if (!result.found) {
          return fail(
            `block not found in page ${pageId} — re-run page_blocks_list for current ids ` +
              `(an earlier delete in this batch removes its id).` +
              staleRemainderNote(i + 1),
          );
        }
        if (result.refused) {
          return fail(
            result.reason ??
              'delete refused (it would leave a container empty — target the container instead)',
          );
        }
        doc = result.doc;
        deletedIds.push(blockId);
        counts.deleted += 1;
      } else {
        return fail("op must be one of: 'update', 'insert_after', 'delete'");
      }
    }

    try {
      const res = await saveDraft(ctx.ownerId, pageId, doc, { baseRev });
      if (!res.ok) {
        if ('conflict' in res) return draftConflict(pageId);
        return { ok: false, error: `page ${pageId} not found (race?)` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    ctx.step?.setOutput({ ops: opsIn.length, ...counts });
    return {
      ok: true,
      output: {
        page_id: pageId,
        ops_applied: opsIn.length,
        ...counts,
        // Chaining map: anchor the NEXT batch on these without re-listing.
        ...(createdIds.length > 0 ? { created_ids: createdIds } : {}),
        ...(deletedIds.length > 0 ? { deleted_ids: deletedIds } : {}),
        draft_saved: true,
        hint: DRAFT_REVIEW_HINT(pageId),
      },
    };
  },
};

const page_split: BuiltinToolDef = {
  slug: 'page_split',
  preconditions: PAGE_ID_PRE,
  name: 'Split a page into sub-pages',
  description:
    "Break a long page into sub-pages along its headings — the SCALING LEVER for documents too big to restyle or hold faithfully in one transform. Walks the page and turns every heading of the chosen level into a child page (heading text → child title; the blocks under it → child body), then replaces THIS page's body with a table-of-contents of links to the new children. **Byte-faithful: every word + block is preserved, just redistributed — nothing is rewritten or summarised.** Writes the TOC to DRAFT only (the published page is untouched until the user commits); each child page is created + indexed immediately, so they're independently searchable and each is small enough to restyle with the block tools afterwards. **When a 'restyle/reformat this whole document' request is too large to do faithfully in one pass, PROPOSE this instead of attempting a doomed full-document transform.**",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'id of the page to split' },
      by: {
        type: 'string',
        enum: ['h1', 'h2'],
        description:
          "heading level that marks the page boundaries: 'h1' for a few big top-level sections, 'h2' for many subsections. Run page_blocks_list({ kinds:['heading'] }) first if unsure which level gives the right granularity.",
      },
      preserve_intro: {
        type: 'boolean',
        description:
          'keep the content BEFORE the first heading at the top of this page (as an intro above the table of contents). Default true.',
      },
    },
    required: ['page_id', 'by'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    if (!pageId) return { ok: false, error: 'page_id is required' };
    const by = str(input.by).trim().toLowerCase();
    const level = by === 'h1' ? 1 : by === 'h2' ? 2 : null;
    if (!level) return { ok: false, error: "by must be 'h1' or 'h2'" };
    const preserveIntro = input.preserve_intro !== false;
    try {
      const res = await splitPage(ctx.ownerId, pageId, { by: level, preserveIntro });
      ctx.step?.setOutput({ split_into: res.children.length });
      const n = res.children.length;
      return {
        ok: true,
        output: {
          page_id: pageId,
          split_into: n,
          children: res.children,
          intro_kept: res.introKept,
          hint:
            `Created ${n} sub-page${n === 1 ? '' : 's'} (each indexed independently). ` +
            `This page's new table-of-contents is in DRAFT — tell the user to open ` +
            `/pages/${pageId} to review, then Commit to publish. Discarding the draft ` +
            `reverts THIS page only; the created sub-pages would then need manual cleanup.`,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_extract_section: BuiltinToolDef = {
  slug: 'page_extract_section',
  preconditions: PAGE_ID_PRE,
  name: 'Promote a section to a sub-page',
  description:
    "Lift ONE section out of a page into its own sub-page. Given a heading's block id (from page_blocks_list), moves that heading + everything under it (until the next heading of equal-or-higher level) into a new child page — heading text → child title, the blocks under it → child body — and drops a link card (childPage) where the section was. Byte-faithful (blocks moved, not rewritten). The surgical cousin of `page_split`: use it to peel off ONE oversized or self-contained section (e.g. 'pull the Appendix out into its own page') rather than splitting the whole document. Writes the parent's new body to DRAFT only; the child is created + indexed immediately.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'id of the page to extract from' },
      heading_block_id: {
        type: 'string',
        description:
          "block id of the section's heading (from page_blocks_list({ kinds:['heading'] })). Must be a top-level heading.",
      },
    },
    required: ['page_id', 'heading_block_id'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    const headingId = str(input.heading_block_id).trim();
    if (!pageId) return { ok: false, error: 'page_id is required' };
    if (!headingId) return { ok: false, error: 'heading_block_id is required' };
    try {
      const res = await extractSectionToChild(ctx.ownerId, pageId, headingId);
      ctx.step?.setOutput({ child_id: res.childId });
      return {
        ok: true,
        output: {
          page_id: pageId,
          child_id: res.childId,
          title: res.title,
          hint:
            `Section "${res.title}" moved into a new sub-page (indexed). This page's ` +
            `body — now with a link card where the section was — is in DRAFT; tell the ` +
            `user to open /pages/${pageId} to review, then Commit.`,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_move: BuiltinToolDef = {
  slug: 'page_move',
  preconditions: PAGE_NODE_ID_PRE,
  name: 'Move a page (re-parent)',
  description:
    "Move an EXISTING page to a new spot in the /pages tree — nest it UNDER another page or promote it back to the top level. Pass `parent_id` OR `to_top_level: true` (exactly one). The page keeps everything — body, tags, sharing link, draft, brain index — and its sub-pages move with it. **Publishes immediately: a structural move, not a body edit, so there is no draft/commit step.** Refuses to create a cycle (a page can't move under itself or its own descendants). Use when the user says 'move X under Y'. To create a NEW page already nested, pass `parent_id` to `page_create`; to carve sub-pages OUT of one page use `page_split` / `page_extract_section`.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'id of the page to move' },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description:
          'id of the page to nest this one UNDER (its new parent). Give this OR to_top_level, not both.',
      },
      to_top_level: {
        type: 'boolean',
        description:
          'set true to move the page out to the top level (no parent). Give this OR parent_id, not both.',
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const parentId = str(input.parent_id).trim();
    const toTop = input.to_top_level === true;
    if (parentId && toTop) {
      return { ok: false, error: 'give either parent_id OR to_top_level:true, not both' };
    }
    if (!parentId && !toTop) {
      return {
        ok: false,
        error:
          'specify a destination: parent_id (to nest under a page) or to_top_level:true (to move to the top level)',
      };
    }
    if (parentId && parentId === id) {
      return { ok: false, error: 'a page cannot be its own parent' };
    }
    try {
      const row = await movePage(ctx.ownerId, id, toTop ? null : parentId);
      if (!row) return notFound('page', id, 'page_list / search_nodes');
      ctx.step?.setOutput({ id, parent_id: row.parentId });
      return {
        ok: true,
        output: {
          id: row.id,
          title: row.title,
          parent_id: row.parentId,
          moved_to: row.parentId ? 'sub-page' : 'top-level',
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (parentId && msg.includes('parent page not found')) {
        return {
          ok: false,
          error: `parent_id '${parentId}' is not one of your pages — pass the id of an existing page (see page_list / search_nodes).`,
        };
      }
      if (msg.includes('under itself or one of its own descendants')) {
        return {
          ok: false,
          error: `cannot move page ${id} under '${parentId}' — that target is the page itself or one of its sub-pages, which would create a cycle.`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

const page_mention: BuiltinToolDef = {
  slug: 'page_mention',
  preconditions: PAGE_ID_PRE,
  name: 'Mention another doc/entity in a page',
  description:
    "Drop a real @-mention link into a page — the programmatic version of typing `@Target`. Unlike a plain markdown `[text](url)` link, a mention is a first-class reference: once the page is committed it becomes a graph edge (a backlink to the target page/note, or a `mentioned_in` edge to an entity), so it shows up in the target's 'Referenced by' panel and the brain's graph. **Use when the user asks to 'link this page to X', 'mention Sarah in this doc', or to cross-link related pages.** Adds a `[lead_text ]@Target` paragraph at the END of the page, or right after `after_block_id`. Writes to DRAFT only — the published page is untouched until the user commits; the edge is built on commit.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: {
        type: 'string',
        format: 'uuid',
        description: 'id of the page to add the mention into',
      },
      target_id: {
        type: 'string',
        format: 'uuid',
        description:
          "id of the thing being mentioned — a page/note (with ref='node') or an entity/person/project/place (with ref='entity')",
      },
      ref: {
        type: 'string',
        enum: ['node', 'entity'],
        description:
          "what target_id points at: 'node' for another page/note (default — the doc-to-doc link case), 'entity' for a person/project/place",
      },
      label: {
        type: 'string',
        description: "optional chip text; defaults to the target's current title/name",
      },
      lead_text: {
        type: 'string',
        description:
          "optional lead-in text before the chip, e.g. 'See also:' or 'Related:'. Omit for a bare chip.",
      },
      after_block_id: {
        type: 'string',
        description:
          'optional block id (from page_blocks_list) to insert the mention paragraph AFTER; omit to append to the end of the page',
      },
    },
    required: ['page_id', 'target_id'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    const targetId = str(input.target_id).trim();
    if (!pageId) return { ok: false, error: 'page_id is required' };
    if (!targetId) return { ok: false, error: 'target_id is required' };
    const ref = str(input.ref).trim() === 'entity' ? 'entity' : 'node';
    const label = str(input.label).trim();
    const leadText = str(input.lead_text).trim();
    const afterBlockId = str(input.after_block_id).trim();
    try {
      const res = await addPageMention(ctx.ownerId, pageId, {
        targetId,
        ref,
        ...(label ? { label } : {}),
        ...(leadText ? { leadText } : {}),
        ...(afterBlockId ? { afterBlockId } : {}),
      });
      if (!res) return notFound('page', pageId, 'page_list / search_nodes');
      ctx.step?.setOutput({ page_id: pageId, target_id: targetId, ref });
      return {
        ok: true,
        output: {
          page_id: pageId,
          target_id: targetId,
          ref: res.ref,
          label: res.label,
          placement: res.appended ? 'appended' : `after ${res.afterBlockId}`,
          draft_saved: true,
          hint: DRAFT_REVIEW_HINT(pageId),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        if (msg.includes('anchor block')) {
          return {
            ok: false,
            error: `after_block_id '${afterBlockId}' isn't a block in page ${pageId} — re-run page_blocks_list for current ids, or omit it to append.`,
          };
        }
        return {
          ok: false,
          error: `target_id '${targetId}' is not one of your ${ref === 'entity' ? 'entities' : 'pages/notes'} — pass a valid id (see page_list / search_nodes / entity_search).`,
        };
      }
      return { ok: false, error: msg };
    }
  },
};

const page_share: BuiltinToolDef = {
  slug: 'page_share',
  preconditions: PAGE_NODE_ID_PRE,
  name: 'Share a page',
  description:
    "Create (or fetch) a read-only link to a page and return its URL. Idempotent — one active link per page. The link is **public** (anyone with it can view, no login) unless `mode: 'team'`, which requires a team credential and lists the page on the Team Hub. `children: true` also shares every sub-page beneath it at the same mode (a whole documentation section in one call); `children: false` revokes those sub-page links. Publishes brain content outward-facing. Use when the user asks to share or publish a page or a section; to turn a link off use `page_unshare`.",
  // Publishes brain content outward-facing (public web, or the whole team) —
  // gated. Team + children can share a large subtree at once, so confirm.
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'page node id (from page_list / page_create)' },
      mode: {
        type: 'string',
        enum: ['public', 'team'],
        description:
          "Who may open the link: 'public' (anyone) or 'team' (team members only — also lists the page on the Team Hub). Omit to keep the link's current setting (public for a new link).",
      },
      children: {
        type: 'boolean',
        description:
          'Also share every sub-page nested under this page, matched to the same mode. false revokes those sub-page links. Omit to leave sub-pages untouched.',
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const mode = input.mode === 'team' ? 'team' : input.mode === 'public' ? 'public' : undefined;
    const children = typeof input.children === 'boolean' ? input.children : undefined;
    try {
      const page = await getPage(ctx.ownerId, id);
      if (!page) return notFound('page', id, 'page_list / search_nodes');
      const share = await createShare(ctx.ownerId, id);
      // Set mode before cascading so descendants inherit the intended mode.
      if (mode) await applyShareMode(ctx.ownerId, share.id, mode);
      let subpages: number | undefined;
      if (children !== undefined) {
        subpages = (await setShareCascade(ctx.ownerId, id, children)).count;
      }
      const url = shareUrlForToken(share.token);
      const finalMode = mode ?? share.mode;
      ctx.step?.setOutput({ id, url, mode: finalMode });
      return {
        ok: true,
        output: {
          id,
          title: page.title,
          url,
          token: share.token,
          mode: finalMode,
          ...(children === true ? { subpagesShared: subpages } : {}),
          ...(children === false ? { subpagesRevoked: subpages } : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const page_unshare: BuiltinToolDef = {
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
      const ok = await revokeShareTree(ctx.ownerId, share.id);
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
  page_from_note,
  page_from_notes,
  page_from_journal,
  page_replace_from_file,
  page_update,
  page_update_draft,
  page_blocks_list,
  page_block_get,
  page_block_update,
  page_block_insert_after,
  page_block_delete,
  page_blocks_apply,
  page_split,
  page_extract_section,
  page_move,
  page_mention,
  page_delete,
  page_list,
  page_get,
  page_share,
  page_unshare,
];

export const PAGE_TOOL_SLUGS: string[] = PAGE_TOOLS.map((t) => t.slug);
