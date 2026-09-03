/**
 * page_blocks_apply — the batched block editor and its op cap.
 *
 * Split out of builtins-pages.ts; bodies moved verbatim.
 */

import {
  getPage,
  markdownToDoc,
  saveDraft,
  findBlock,
  replaceBlock,
  insertAfterBlock,
  insertBeforeBlock,
  wrapBlocks,
  deleteBlock,
  type PMBlockNode,
  type WrapContainer,
} from '@mantle/content';
import type { BuiltinToolDef } from '../types';
import { str } from '../coerce';
import { notFound } from '../errors';
import { errorMessage } from '@mantle/std';
import { DRAFT_REVIEW_HINT, PAGE_ID_PRE, draftConflict, pickEditingBaseline } from './common';

/** Upper bound on ops per batch — big enough for real jobs (the 47-quote
 *  wrap, a 40-block renumber), small enough that a runaway payload is
 *  refused with guidance instead of accepted. */
const MAX_APPLY_OPS = 50;

/* No 'move' op (deliberately deferred, 2026-08-02): full restructures already
 * route to page_update_draft per the page_editing strategy ladder; a move is
 * the most anchor-churn-prone batch op there is (the same chaining incident
 * class the created_ids map exists for); and with wrap + insert_before +
 * insert_after available, small moves are losslessly expressible without it.
 * Revisit with usage evidence, not speculation. */

export const page_blocks_apply: BuiltinToolDef = {
  slug: 'page_blocks_apply',
  preconditions: [...PAGE_ID_PRE, { kind: 'markdown_refs', param: 'ops', itemKey: 'markdown' }],
  name: 'Apply a batch of block edits to a page (atomic)',
  description:
    "Apply MANY block edits to one page in a SINGLE atomic call — the batch path between one-off block tools and a whole-body `page_update_draft` rewrite. `ops` is an ordered list of `{ op: 'update' | 'insert_before' | 'insert_after' | 'delete' | 'wrap', block_id?, markdown?, block_ids?, container?, variant? }` applied sequentially against the editing baseline; the draft is saved ONCE at the end, so the batch is all-or-nothing: if any op fails (unknown block id, bad markdown, refused delete or wrap) NOTHING is saved and the error names the failing op's index. " +
    "**Use this for multi-block targeted edits** — wrap every quote, retitle several sections, delete a scattered set — up to 50 ops. One call replaces up to 50 individual block calls, so it cannot be severed mid-edit by the turn's tool-call budget. For a full restructure (resequencing, merging sections) still prefer ONE `page_update_draft`. " +
    "'wrap' folds a contiguous run of sibling blocks into a NEW callout / aside / columns container in place: the blocks move inside byte-for-byte (never re-emit content just to restyle it) and the wrapper's id lands in `created_ids`. " +
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
              enum: ['update', 'insert_before', 'insert_after', 'delete', 'wrap'],
              description:
                "the edit to perform; every op except 'wrap' targets `block_id`, the inserts and 'update' also need `markdown`, and 'wrap' takes `block_ids` + `container` instead. No 'append' op: anchor batch appends on the last listed block with 'insert_after'.",
            },
            block_id: {
              type: 'string',
              description:
                "target block id from page_blocks_list; the new blocks land AFTER this block on 'insert_after', BEFORE it on 'insert_before'. Unused by 'wrap'.",
            },
            markdown: {
              type: 'string',
              description:
                "content for 'update' and the inserts (required there, ignored elsewhere). Keep the structural prefix to preserve block kind.",
            },
            block_ids: {
              type: 'array',
              items: { type: 'string' },
              description:
                "'wrap' only: the blocks to move inside the new container. Must be a contiguous run of siblings under one parent; wrapped in document order.",
            },
            container: {
              type: 'string',
              enum: ['callout', 'aside', 'columns'],
              description:
                "'wrap' only: the container to build around `block_ids`. 'columns' makes one column per block (max 4 blocks).",
            },
            variant: {
              type: 'string',
              description:
                "'wrap' only, optional: callout variant (info / success / warning / danger) or aside themed colour (chart-1 … chart-5).",
            },
          },
          required: ['op'],
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
          "ops is required: a non-empty array of { op: 'update'|'insert_before'|'insert_after'|'delete'|'wrap', block_id?, markdown?, block_ids?, container?, variant? }",
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
    const counts = { updated: 0, inserted: 0, deleted: 0, wrapped: 0 };
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
        const bids = [
          str(o.block_id).trim(),
          ...(Array.isArray(o.block_ids)
            ? o.block_ids.filter((x): x is string => typeof x === 'string')
            : []),
        ];
        for (const bid of bids) {
          if (bid && !findBlock(doc, bid)) stale.push(`op ${j} (${bid})`);
        }
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
      if (kind === 'update' || kind === 'insert_after' || kind === 'insert_before') {
        if (!blockId) return fail('block_id is required');
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
          return fail(`markdown parse failed: ${errorMessage(err)}`);
        }
        if (parsedBlocks.length === 0) return fail('markdown produced no blocks');
        const result =
          kind === 'update'
            ? replaceBlock(doc, blockId, parsedBlocks as PMBlockNode[])
            : kind === 'insert_after'
              ? insertAfterBlock(doc, blockId, parsedBlocks as PMBlockNode[])
              : insertBeforeBlock(doc, blockId, parsedBlocks as PMBlockNode[]);
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
        if (!blockId) return fail('block_id is required');
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
      } else if (kind === 'wrap') {
        const wrapIds = Array.isArray(op.block_ids)
          ? op.block_ids.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
          : [];
        if (wrapIds.length === 0) {
          return fail("'wrap' needs block_ids: a non-empty array of sibling block ids");
        }
        const container = str(op.container).trim();
        if (container !== 'callout' && container !== 'aside' && container !== 'columns') {
          return fail("'wrap' needs container: 'callout', 'aside', or 'columns'");
        }
        const variant = str(op.variant).trim();
        const result = wrapBlocks(
          doc,
          wrapIds,
          container as WrapContainer,
          variant !== '' ? variant : undefined,
        );
        if (!result.found) {
          return fail(
            `block ${result.missingId} not found in page ${pageId}; re-run page_blocks_list ` +
              `for current ids (an earlier delete or wrap in this batch consumes its targets; ` +
              `a previous batch's new blocks are addressable via its created_ids output).` +
              staleRemainderNote(i + 1),
          );
        }
        if (result.refused) {
          return fail(result.reason ?? 'wrap refused');
        }
        doc = result.doc;
        // The wrapper is a NEW addressable block; report its minted id so a
        // follow-up batch can anchor on it (same contract as the inserts).
        if (result.wrapperId) createdIds.push({ op: i, ids: [result.wrapperId] });
        counts.wrapped += 1;
      } else {
        return fail("op must be 'update', 'insert_before', 'insert_after', 'delete', or 'wrap'");
      }
    }

    try {
      const res = await saveDraft(ctx.ownerId, pageId, doc, { baseRev });
      if (!res.ok) {
        if ('conflict' in res) return draftConflict(pageId);
        return { ok: false, error: `page ${pageId} not found (race?)` };
      }
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
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
