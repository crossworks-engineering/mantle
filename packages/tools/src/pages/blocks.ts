/**
 * Block-level editing: list, get, update, insert, append, delete.
 *
 * Split out of builtins-pages.ts; bodies moved verbatim.
 */

import {
  getPage,
  markdownToDoc,
  docToText,
  saveDraft,
  listBlocks,
  findBlock,
  replaceBlock,
  insertAfterBlock,
  insertBeforeBlock,
  appendBlocks,
  deleteBlock,
  type PMBlockNode,
} from '@mantle/content';
import type { BuiltinToolDef } from '../types';
import { str } from '../coerce';
import { notFound } from '../errors';
import { errorMessage } from '@mantle/std';
import {
  DRAFT_REVIEW_HINT,
  MARKDOWN_HINT,
  MARKDOWN_REFS_PRE,
  PAGE_ID_PRE,
  draftConflict,
  pickEditingBaseline,
} from './common';

export const page_blocks_list: BuiltinToolDef = {
  slug: 'page_blocks_list',
  readOnly: true,
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

export const page_block_get: BuiltinToolDef = {
  slug: 'page_block_get',
  readOnly: true,
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

export const page_block_update: BuiltinToolDef = {
  slug: 'page_block_update',
  preconditions: [...PAGE_ID_PRE, ...MARKDOWN_REFS_PRE],
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
        error: `markdown parse failed: ${errorMessage(err)}`,
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
      return { ok: false, error: errorMessage(err) };
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

export const page_block_insert_after: BuiltinToolDef = {
  slug: 'page_block_insert_after',
  preconditions: [...PAGE_ID_PRE, ...MARKDOWN_REFS_PRE],
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
        error: `markdown parse failed: ${errorMessage(err)}`,
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
      return { ok: false, error: errorMessage(err) };
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

export const page_block_insert_before: BuiltinToolDef = {
  slug: 'page_block_insert_before',
  preconditions: [...PAGE_ID_PRE, ...MARKDOWN_REFS_PRE],
  name: 'Insert blocks before a target block',
  description:
    'Insert one or more new blocks (parsed from markdown) directly before the block with the given id: an intro above an existing section, a heading over an orphaned paragraph. Writes to DRAFT only. New blocks get fresh ids on save. Counterpart of `page_block_insert_after`; for the very start or end of the page `page_block_append` needs no anchor at all, and for 3+ insertions batch them in one `page_blocks_apply` call.',
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'page node id' },
      before_block_id: { type: 'string', description: 'insert BEFORE this block id' },
      markdown: {
        type: 'string',
        description: `Markdown for the new block(s). ${MARKDOWN_HINT}`,
      },
    },
    required: ['page_id', 'before_block_id', 'markdown'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    const beforeId = str(input.before_block_id).trim();
    const markdown = str(input.markdown);
    if (!pageId || !beforeId)
      return { ok: false, error: 'page_id and before_block_id are required' };
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
        error: `markdown parse failed: ${errorMessage(err)}`,
      };
    }
    if (parsedBlocks.length === 0) {
      return { ok: false, error: 'markdown produced no blocks' };
    }

    const baseline = pickEditingBaseline(page);
    // Rev of the draft we just read (0 when none) — threaded into saveDraft so a
    // user autosave that lands between this read and our write is not clobbered.
    const baseRev = page.draftRev ?? 0;
    const result = insertBeforeBlock(baseline, beforeId, parsedBlocks as PMBlockNode[]);
    if (!result.found) {
      return {
        ok: false,
        error: `block ${beforeId} not found in page ${pageId}. Re-run page_blocks_list for current ids.`,
      };
    }
    try {
      const res = await saveDraft(ctx.ownerId, pageId, result.doc, { baseRev });
      if (!res.ok) {
        if ('conflict' in res) return draftConflict(pageId);
        return { ok: false, error: `page ${pageId} not found (race?)` };
      }
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }

    ctx.step?.setOutput({ before: beforeId, inserted_count: parsedBlocks.length });
    return {
      ok: true,
      output: {
        page_id: pageId,
        before_block_id: beforeId,
        inserted_count: parsedBlocks.length,
        draft_saved: true,
        hint: DRAFT_REVIEW_HINT(pageId),
      },
    };
  },
};

export const page_block_append: BuiltinToolDef = {
  slug: 'page_block_append',
  preconditions: [...PAGE_ID_PRE, ...MARKDOWN_REFS_PRE],
  name: 'Add blocks at the start or end of a page',
  description:
    'Add one or more new blocks (parsed from markdown) at the very start or end of a page: no anchor id needed, so it works without a `page_blocks_list` first. The go-to for "append a section to my notes" or prepending an intro. Writes to DRAFT only. New blocks get fresh ids on save. To place blocks relative to existing content use `page_block_insert_after` / `page_block_insert_before`; for 3+ edits batch them in one `page_blocks_apply` call.',
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'page node id' },
      markdown: {
        type: 'string',
        description: `Markdown for the new block(s). ${MARKDOWN_HINT}`,
      },
      position: {
        type: 'string',
        enum: ['start', 'end'],
        default: 'end',
        description: 'where the new blocks land: the top of the page or the bottom',
      },
    },
    required: ['page_id', 'markdown'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    const markdown = str(input.markdown);
    if (!pageId) return { ok: false, error: 'page_id is required' };
    if (!markdown) return { ok: false, error: 'markdown is required' };
    const position = str(input.position).trim() === 'start' ? 'start' : 'end';

    const page = await getPage(ctx.ownerId, pageId);
    if (!page) return notFound('page', pageId, 'page_list / search_nodes');

    let parsedBlocks: unknown[];
    try {
      const parsed = markdownToDoc(markdown) as { content?: unknown[] };
      parsedBlocks = Array.isArray(parsed.content) ? parsed.content : [];
    } catch (err) {
      return {
        ok: false,
        error: `markdown parse failed: ${errorMessage(err)}`,
      };
    }
    if (parsedBlocks.length === 0) {
      return { ok: false, error: 'markdown produced no blocks' };
    }

    const baseline = pickEditingBaseline(page);
    // Rev of the draft we just read (0 when none) — threaded into saveDraft so a
    // user autosave that lands between this read and our write is not clobbered.
    const baseRev = page.draftRev ?? 0;
    const result = appendBlocks(baseline, parsedBlocks as PMBlockNode[], position);
    try {
      const res = await saveDraft(ctx.ownerId, pageId, result.doc, { baseRev });
      if (!res.ok) {
        if ('conflict' in res) return draftConflict(pageId);
        return { ok: false, error: `page ${pageId} not found (race?)` };
      }
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }

    ctx.step?.setOutput({ position, inserted_count: parsedBlocks.length });
    return {
      ok: true,
      output: {
        page_id: pageId,
        position,
        inserted_count: parsedBlocks.length,
        draft_saved: true,
        hint: DRAFT_REVIEW_HINT(pageId),
      },
    };
  },
};

export const page_block_delete: BuiltinToolDef = {
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
      return { ok: false, error: errorMessage(err) };
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
