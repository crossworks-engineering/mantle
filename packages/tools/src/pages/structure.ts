/**
 * Reshaping a page: split, extract a section, move, mention.
 *
 * Split out of builtins-pages.ts; bodies moved verbatim. Pages do not nest
 * (folder phase 7): a split or an extract makes pages NEXT TO the source,
 * and a move files a page in a folder of the pages tree.
 */

import { addPageMention, splitPage, extractSectionToPage, getPage } from '@mantle/content';
import { moveTreeItems, notifyTreeChanged } from '@mantle/content/tree';
import type { BuiltinToolDef } from '../types';
import { str } from '../coerce';
import { notFound } from '../errors';
import { errorMessage } from '@mantle/std';
import { DRAFT_REVIEW_HINT, PAGE_ID_PRE, PAGE_NODE_ID_PRE } from './common';
import { CONFIRM_INPUT, visibilityRefusal } from '../visibility-refusal';
import { isOwnerSurface, OWNER_ONLY_ERROR } from '../surface';

export const page_split: BuiltinToolDef = {
  slug: 'page_split',
  preconditions: PAGE_ID_PRE,
  name: 'Split a page into pages',
  description:
    "Break a long page into pages along its headings: the SCALING LEVER for documents too big to restyle or hold faithfully in one transform. Walks the page and turns every heading of the chosen level into a page of its own, in the same folder (heading text → title; the blocks under it → body), then replaces THIS page's body with a table-of-contents of link cards to the new pages. **Byte-faithful: every word + block is preserved, just redistributed, nothing is rewritten or summarised.** Writes the TOC to DRAFT only (the published page is untouched until the user commits); each new page is created + indexed immediately, so they're independently searchable and each is small enough to restyle with the block tools afterwards. **When a 'restyle/reformat this whole document' request is too large to do faithfully in one pass, PROPOSE this instead of attempting a doomed full-document transform.**",
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
      confirm: CONFIRM_INPUT,
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
      const res = await splitPage(ctx.ownerId, pageId, {
        by: level,
        preserveIntro,
        confirm: input.confirm === true,
      });
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
            `Created ${n} page${n === 1 ? '' : 's'} next to this one (each indexed independently). ` +
            `This page's new table-of-contents is in DRAFT — tell the user to open ` +
            `/pages/${pageId} to review, then Commit to publish. Discarding the draft ` +
            `reverts THIS page only; the created pages would then need manual cleanup.`,
        },
      };
    } catch (err) {
      // A draft-only embed of the source would open in a shared folder: the
      // list, until the user agrees (confirm: true).
      const refusal = visibilityRefusal(err);
      if (refusal) return { ok: false, error: refusal };
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const page_extract_section: BuiltinToolDef = {
  slug: 'page_extract_section',
  preconditions: PAGE_ID_PRE,
  name: 'Lift a section into its own page',
  description:
    "Lift ONE section out of a page into a page of its own, in the same folder. Given a heading's block id (from page_blocks_list), moves that heading + everything under it (until the next heading of equal-or-higher level) into a new page (heading text becomes the title, the blocks under it the body) and drops a link card (`[Title](page:<id>)`) where the section was. Byte-faithful (blocks moved, not rewritten). The surgical cousin of `page_split`: use it to peel off ONE oversized or self-contained section (e.g. 'pull the Appendix out into its own page') rather than splitting the whole document. Writes the source's new body to DRAFT only; the new page is created + indexed immediately.",
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'id of the page to extract from' },
      heading_block_id: {
        type: 'string',
        description:
          "block id of the section's heading (from page_blocks_list({ kinds:['heading'] })). Must be a top-level heading.",
      },
      confirm: CONFIRM_INPUT,
    },
    required: ['page_id', 'heading_block_id'],
  },
  handler: async (input, ctx) => {
    const pageId = str(input.page_id).trim();
    const headingId = str(input.heading_block_id).trim();
    if (!pageId) return { ok: false, error: 'page_id is required' };
    if (!headingId) return { ok: false, error: 'heading_block_id is required' };
    try {
      const res = await extractSectionToPage(ctx.ownerId, pageId, headingId, {
        confirm: input.confirm === true,
      });
      ctx.step?.setOutput({ child_id: res.childId });
      return {
        ok: true,
        output: {
          page_id: pageId,
          child_id: res.childId,
          title: res.title,
          hint:
            `Section "${res.title}" moved into a new page next to this one (indexed). This page's ` +
            `body — now with a link card where the section was — is in DRAFT; tell the ` +
            `user to open /pages/${pageId} to review, then Commit.`,
        },
      };
    } catch (err) {
      // A draft-only embed of the source would open in a shared folder: the
      // list, until the user agrees (confirm: true).
      const refusal = visibilityRefusal(err);
      if (refusal) return { ok: false, error: refusal };
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const page_move: BuiltinToolDef = {
  slug: 'page_move',
  // Like tree_item_move: a member or client organises through its own tree.
  ownerOnly: true,
  preconditions: [
    ...PAGE_NODE_ID_PRE,
    { kind: 'node_exists', param: 'folder_id', nodeType: 'branch', lookup: 'tree_folders' },
  ],
  name: 'Move a page into a folder',
  description:
    'File an EXISTING page in a folder of the pages tree, or move it to the top level. Pass `folder_id` (a pages folder from `tree_folders`, kind pages) OR `to_top_level: true` (exactly one). Only where the page sits changes: body, tags, link, draft and brain index stay. A move into or out of a shared folder changes who can see the page: it is refused with the list until the call repeats with `confirm: true`, which you send only once the user agreed. Pages do not nest: to keep pages together, file them in one folder (`tree_folder_create` makes it). The same as `tree_item_move` with kind pages.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'id of the page to move' },
      folder_id: {
        type: 'string',
        format: 'uuid',
        description:
          'the pages folder to file it in, from `tree_folders` (kind pages). Give this OR to_top_level, not both.',
      },
      to_top_level: {
        type: 'boolean',
        description:
          'set true to move the page out to the top level (no folder). Give this OR folder_id, not both.',
      },
      parent_id: {
        type: 'string',
        format: 'uuid',
        description:
          'DEPRECATED, pages do not nest: a page id here files this page in the SAME FOLDER as that page. Prefer `folder_id`.',
      },
      confirm: CONFIRM_INPUT,
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    if (!isOwnerSurface(ctx.surface)) return { ok: false, error: OWNER_ONLY_ERROR };
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const folderId = str(input.folder_id).trim();
    const parentId = str(input.parent_id).trim();
    const toTop = input.to_top_level === true;
    const given = [folderId, parentId, toTop ? 'top' : ''].filter(Boolean).length;
    if (given > 1) {
      return { ok: false, error: 'give either folder_id OR to_top_level:true, not both' };
    }
    if (given === 0) {
      return {
        ok: false,
        error:
          'specify a destination: folder_id (a pages folder from tree_folders) or to_top_level:true (the top level)',
      };
    }
    if (parentId && parentId === id) {
      return { ok: false, error: 'a page cannot be moved next to itself; name another page' };
    }
    try {
      let dest: string | null = folderId || null;
      if (parentId) {
        const beside = await getPage(ctx.ownerId, parentId);
        if (!beside) {
          return {
            ok: false,
            error: `parent_id '${parentId}' is not one of your pages: pass a folder_id (tree_folders, kind pages) instead.`,
          };
        }
        dest = beside.folderId ?? null;
      }
      const result = await moveTreeItems(ctx.ownerId, 'pages', [id], dest, {
        confirm: input.confirm === true,
      });
      if (!result.moved) {
        const why = result.failed[0]?.error ?? 'not found';
        return /not found/.test(why)
          ? notFound('page', id, 'page_list / search_nodes')
          : { ok: false, error: why };
      }
      await notifyTreeChanged(ctx.ownerId, 'pages');
      ctx.step?.setOutput({ id, folder_id: dest });
      return {
        ok: true,
        output: {
          id,
          folder_id: dest,
          moved_to: dest ? 'folder' : 'top-level',
        },
      };
    } catch (err) {
      const refusal = visibilityRefusal(err);
      if (refusal) return { ok: false, error: refusal };
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const page_mention: BuiltinToolDef = {
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
      const msg = errorMessage(err);
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
