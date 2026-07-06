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
  revokeShare,
  getActiveShareForNode,
  shareUrlForToken,
  nodeUrl,
  getNote,
  getJournal,
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
  'Rich-markdown body. GFM markdown plus: callouts (`:::info` … `:::`, variants info|success|warning|danger), asides (`:::aside` … `:::`, a themed-gradient box; optional colour `:::aside chart-3`), columns (`:::columns` … `+++` … `:::`, 2+ parts), task lists (`- [ ]` / `- [x]`), tables, and `==highlight==`. Same dialect you write replies in.';

const page_create: BuiltinToolDef = {
  slug: 'page_create',
  name: 'Create a page',
  description:
    "Create a rich document (a `page` node under /pages) in the user's Mantle from content YOU compose. `title` required; `markdown` is the body in the rich dialect (callouts, columns, tables, task lists, highlights). The page is indexed into the brain — summary, embedding, facts, entities — so it becomes searchable and recallable. To make a SUB-PAGE, pass `parent_id` (an existing page's id, e.g. from page_list / search_nodes) and the new page nests under it; omit for a top-level page. Prefer this over note_create when the content is long-form or structured (a plan, a doc, a comparison) that deserves real formatting; use note_create for quick plain-text captures. **For importing an existing file (Notion export, sermon markdown, etc.) use `page_from_file` instead — re-emitting the file body in this tool's `markdown` arg truncates silently above ~6 K output tokens.** **When the content already lives in an existing NOTE, use `page_from_note` (pass the note id) — it copies the body server-side instead of you re-typing it.**",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'page title, e.g. "Q3 Launch Plan"' },
      markdown: { type: 'string', description: MARKDOWN_HINT },
      tags: { type: 'array', items: { type: 'string' } },
      icon: { type: 'string', description: 'optional emoji icon, e.g. "📄"' },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description: 'optional — id of an existing page to nest this new page UNDER (creates a sub-page). Omit for a top-level page.',
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
      return { ok: true, output: { id: page.id, title: page.title, tags: page.tags, ...(parentId ? { parent_id: parentId } : {}) } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // createPage throws ParentPageNotFoundError ("…parent page not found") when
      // parent_id isn't one of the owner's pages — surface that plainly.
      if (parentId && msg.includes('parent page not found')) {
        return { ok: false, error: `parent_id '${parentId}' is not one of your pages — pass the id of an existing page (see page_list / search_nodes).` };
      }
      return { ok: false, error: msg };
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
    "Read one page by id. Returns the title, tags, summary, and the document as plaintext (`content`). To edit metadata only (title / tags / icon), use `page_update`. **For body styling or restyling on an existing page, delegate to the `pages` agent via `invoke_agent` — it writes to draft_doc only (preserves the live page) and is configured with the right model + safety rules for whole-doc transforms.** For block-level structure (which blocks exist, addressable by id) use `page_blocks_list` instead — lighter, no body returned. Returns a `url` permalink — link the page as a markdown `[title](url)` when you reference it to the user.",
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

const page_from_note: BuiltinToolDef = {
  slug: 'page_from_note',
  name: 'Create page from note',
  description:
    "Promote an EXISTING note into a rich page — the note's markdown body is copied server-side (`note → markdownToDoc → createPage`) WITHOUT round-tripping through your output. **Always prefer this over note_get + page_create when the user wants a note turned into a page** ('make this note a page', 'add this note to pages', 'turn my note into a doc'). It's effectively instant and byte-faithful no matter how long the note is — you pass the note id, NOT its text, so nothing is re-typed or truncated. Pass `parent_id` (an existing page's id) to nest the new page UNDER it as a sub-page; omit for top-level. Title/tags default to the note's own unless you override. The original note is LEFT IN PLACE (non-destructive) — delete it separately with note_delete if the user wants it gone. Returns the new page's id + title; the body is never echoed back (use page_get to verify). **When delegating a note→page move, hand off the note id + parent id only — never paste the note body into the prompt.**",
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
    "Stitch SEVERAL existing notes into ONE rich page — every note's markdown body is copied server-side and concatenated in the order you give, WITHOUT round-tripping any of it through your output. **Prefer this over reading each note and re-typing it into page_create when the user wants to combine/compile multiple notes into a single doc** ('turn these notes into a page', 'compile my meeting notes into one document', 'merge these into a page under X'). Instant and byte-faithful at any size — you pass the note ids, NOT their text. Each note becomes its own section under an `## ` heading made from the note's title (so the result stays navigable); pass `headings: false` to concatenate the bodies raw with no inserted headings. Pass `parent_id` (an existing page's id) to nest the new page UNDER it as a sub-page. `title` is required (there's no single source note to borrow it from); tags default to the union of all the source notes' tags. The original notes are LEFT IN PLACE (non-destructive). Returns the new page's id + title; the body is never echoed back (use page_get to verify). **When delegating, hand off the note ids + title + parent id only — never paste the note bodies into the prompt.**",
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
        error: 'title is required when combining multiple notes (no single source note to borrow it from).',
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
    const tags = tagsArg.length
      ? tagsArg
      : [...new Set(notes.flatMap((n) => n.tags))];
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
    "Compile SEVERAL existing Journal entries into ONE rich page — every entry's body is copied server-side and concatenated in the order you give, WITHOUT round-tripping any of it through your output. The journal counterpart of page_from_notes: use it for 'turn my journal into a page', 'compile this week's entries into a reflection doc', 'make a page from these journal entries'. Instant and byte-faithful at any size — you pass the journal entry ids (get them from journal_list), NOT their text. Each entry becomes its own section under an `## ` heading made from its date (and title, when it has one), so the result reads as a dated log; pass `headings: false` to concatenate the bodies raw. Pass `parent_id` (an existing page's id) to nest the new page UNDER it. `title` is required; tags default to the union of the source entries' tags. The original entries are LEFT IN PLACE (non-destructive). Returns the new page's id + title; the body is never echoed back (use page_get to verify). **When delegating, hand off the entry ids + title + parent id only — never paste the entry bodies into the prompt.**",
  inputSchema: {
    type: 'object',
    properties: {
      journal_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        description: 'ids of the journal entries to compile, in the order they should appear (see journal_list)',
      },
      title: { type: 'string', description: 'title for the compiled page (required)' },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description: 'optional id of an existing page to nest the new page UNDER; omit for top-level',
      },
      headings: {
        type: 'boolean',
        description: "section each entry under a date(+title) `## ` heading (default true); set false to concatenate bodies raw",
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
        error: 'title is required when compiling journal entries (no single source to borrow it from).',
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
  name: 'List the blocks in a page',
  description:
    "Return a TOC-style flat listing of every addressable block in a page — `id`, `kind` (paragraph / heading / callout / table / …), `depth`, and a short text `preview`. Lightweight: the body itself is not returned, so this works regardless of page size. **Lists the SAME baseline the block-edit tools operate on: the uncommitted DRAFT when one exists, else the published doc** — `baseline` in the output tells you which you got, so the ids here are always valid targets for page_block_get/update/delete. **Use this BEFORE proposing any block-level edit** so you know which blocks exist and can target them by stable id. The ids returned here survive across edits — they are stable per block, not per read. Headings also include `meta.level`, code blocks `meta.language`, callouts `meta.variant`, task items `meta.checked`, images `meta.alt`. **`kinds` is the SCALING knob — pass only the block types you care about** (e.g. `['blockquote']` for 'find every quote', `['heading']` for an outline). A large page can have hundreds of blocks; an unfiltered listing on a 300-block page approaches 80 KB and spills through the tool-result store, costing extra paging turns. `max_depth: 1` is the other compactor — top-level only. Default `preview_chars` is 80; bump only when you genuinely need more context per block.",
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
    if (!page) return { ok: false, error: `page ${pageId} not found` };

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
    // stale for the tools that followed (NATREF SOP incident, 2026-07-06).
    const baseline = pickEditingBaseline(page);
    const blocks = listBlocks(baseline, {
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(previewChars !== undefined ? { previewChars } : {}),
      ...(kinds.length > 0 ? { kinds } : {}),
    });

    const hasDraft = page.draft !== null;
    ctx.step?.setOutput({ id: page.id, block_count: blocks.length, baseline: hasDraft ? 'draft' : 'published' });
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

const page_split: BuiltinToolDef = {
  slug: 'page_split',
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
  name: 'Move a page (re-parent)',
  description:
    "Move an EXISTING page to a new spot in the /pages tree — nest it UNDER another page (making it a sub-page) or promote it back to the top level. Pass `parent_id` = the id of the page to nest under, OR `to_top_level: true` to move it to the top level (give exactly one). The page keeps everything — its body, tags, sharing link, draft, and brain index are all untouched; only its position changes, and any sub-pages it already has move along with it. Publishes immediately: this is a structural move, not a body edit, so there is no draft/commit step. Refuses to create a cycle (you can't move a page under itself or under one of its own descendants). **Use when the user says 'move X under Y', 'make X a sub-page of Y', 'nest these', or 'pull X back out to the top level'.** This is the tool for RE-PARENTING an existing page; to create a NEW page already nested, pass `parent_id` to page_create instead, and to carve sub-pages OUT of one page use page_split / page_extract_section.",
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
      if (!row) return { ok: false, error: `page ${id} not found` };
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
  name: 'Mention another doc/entity in a page',
  description:
    "Drop a real @-mention link into a page — the programmatic version of typing `@Target`. Unlike a plain markdown `[text](url)` link, a mention is a first-class reference: once the page is committed it becomes a graph edge (a backlink to the target page/note, or a `mentioned_in` edge to an entity), so it shows up in the target's 'Referenced by' panel and the brain's graph. **Use when the user asks to 'link this page to X', 'reference the Q3 plan here', 'mention Sarah in this doc', or to cross-link related pages.** `target_id` is the page/note id (ref='node', the default) or entity id (ref='entity'). The chip text is the target's current title unless you pass `label`. Adds a `[lead_text ]@Target` paragraph at the END of the page, or right after `after_block_id` (a block id from page_blocks_list). Writes to DRAFT only — the published page is untouched until the user commits; the edge is built on commit.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', format: 'uuid', description: 'id of the page to add the mention into' },
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
      if (!res) return { ok: false, error: `page ${pageId} not found` };
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
