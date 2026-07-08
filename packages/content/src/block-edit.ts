/**
 * Block-addressed editing helpers — find / replace / insert-after / delete
 * a single block in a ProseMirror doc by its stable id. Foundation for the
 * Phase 2b page_block_* tools (find via page_blocks_list, then mutate via
 * these), and (later) for the Phase 3a editor's diff view.
 *
 * Pure. No DB, no markdown parsing — the caller arrives with already-
 * parsed PM block nodes and an id. The functions return a NEW doc with the
 * mutation applied; the input is never mutated. Block-id semantics:
 *
 *   - replaceBlock — the first NEW block ALWAYS takes the TARGET'S id
 *     (agent continuity: "edit block X" → the result is still addressable
 *     as X), overwriting any id the parsed block arrived with. Subsequent
 *     new blocks keep their parse-minted ids (or get fresh ones on the
 *     next saveDraft pass if they have none).
 *   - insertAfterBlock — every new block keeps its fresh parse-minted id
 *     (the agent didn't ask to rename anything, just to add).
 *   - deleteBlock — refuses to remove the LAST child of any container
 *     (callout / column / listItem / etc.) because that would leave the
 *     container with empty `content`, which most ProseMirror schemas
 *     reject. Caller can delete the container itself if that's the intent.
 *
 * All four helpers descend through the WHOLE tree, so the agent can
 * address a paragraph inside a callout, a list item inside a list, etc.
 * by its id directly.
 */

import { BLOCK_NODE_TYPES } from './block-ids';

/** Loose PM node shape — exported so tool handlers that pre-parse via
 *  markdownToDoc can cast their `content` array to the right type before
 *  calling replaceBlock / insertAfterBlock. */
export type PMBlockNode = {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: PMBlockNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};
type AnyNode = PMBlockNode;

export type FindResult = {
  /** The matched block node. */
  block: AnyNode;
  /** The block's parent (the doc root or a container). */
  parent: AnyNode;
  /** The block's index within `parent.content`. */
  index: number;
  /** Number of sibling blocks AT THE SAME LEVEL (i.e., `parent.content.length`). */
  siblingCount: number;
};

/**
 * Walk the doc, return the first block whose `attrs.id` matches `blockId`,
 * along with its parent + index. Returns null if not found.
 *
 * Walks the whole tree — addressable blocks nested inside callouts /
 * columns / list items / table cells are all findable by id.
 */
export function findBlock(
  doc: Record<string, unknown>,
  blockId: string,
): FindResult | null {
  return walk(doc as AnyNode, blockId);
}

function walk(node: AnyNode, blockId: string): FindResult | null {
  if (!Array.isArray(node.content) || node.content.length === 0) return null;
  for (let i = 0; i < node.content.length; i++) {
    const child = node.content[i]!;
    if (
      child.type &&
      BLOCK_NODE_TYPES.has(child.type) &&
      child.attrs &&
      typeof child.attrs.id === 'string' &&
      child.attrs.id === blockId
    ) {
      return { block: child, parent: node, index: i, siblingCount: node.content.length };
    }
    // Recurse — the target might live deeper (inside a callout/column/etc).
    const deeper = walk(child, blockId);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Return a new doc where the block matching `blockId` is replaced by
 * `newBlocks` (one or more). The first new block takes the target's id
 * so the agent's next address still points at the same logical slot;
 * any additional new blocks keep their parse-minted ids (id-less ones
 * get fresh ids on the next ensureBlockIds pass, which saveDraft runs
 * automatically).
 *
 * Returns `{ doc, found: false }` when the id doesn't match anything;
 * the caller distinguishes "not found" from "replaced with empty".
 */
export function replaceBlock(
  doc: Record<string, unknown>,
  blockId: string,
  newBlocks: AnyNode[],
): { doc: Record<string, unknown>; found: boolean } {
  const found = findBlock(doc, blockId);
  if (!found) return { doc, found: false };

  // Inherit the old id on the first new block (agent continuity) —
  // UNCONDITIONALLY. Blocks arriving from markdownToDoc already carry
  // fresh parse-minted ids, so an "only when missing" check would never
  // fire (the target's id would silently churn on every update), and
  // respecting an arbitrary caller-set id is how a duplicate could be
  // smuggled into the doc.
  const first = newBlocks[0];
  if (first) {
    newBlocks = [
      { ...first, attrs: { ...(first.attrs ?? {}), id: blockId } },
      ...newBlocks.slice(1),
    ];
  }

  // Splice into a clone of the tree.
  const next = clone(doc as AnyNode);
  const target = findBlock(next as unknown as Record<string, unknown>, blockId)!;
  target.parent.content!.splice(target.index, 1, ...newBlocks);
  return { doc: next as unknown as Record<string, unknown>, found: true };
}

/**
 * Return a new doc with `newBlocks` inserted directly after the block
 * matching `blockId`. New blocks keep the fresh ids markdownToDoc minted
 * at parse (id-less ones get fresh ids on the next ensureBlockIds pass
 * via saveDraft).
 */
export function insertAfterBlock(
  doc: Record<string, unknown>,
  blockId: string,
  newBlocks: AnyNode[],
): { doc: Record<string, unknown>; found: boolean } {
  const found = findBlock(doc, blockId);
  if (!found) return { doc, found: false };

  const next = clone(doc as AnyNode);
  const target = findBlock(next as unknown as Record<string, unknown>, blockId)!;
  target.parent.content!.splice(target.index + 1, 0, ...newBlocks);
  return { doc: next as unknown as Record<string, unknown>, found: true };
}

/**
 * Return a new doc with the block matching `blockId` removed. Refuses
 * (returns `{ refused: true }`) when removing it would leave the parent
 * container with zero children — most ProseMirror containers (callout,
 * column, listItem, tableCell) require at least one block, so leaving
 * them empty produces an invalid doc the editor would reject on next
 * load. Caller can delete the container itself instead.
 *
 * The doc root (`type: 'doc'`) is exempt — it's allowed to be empty
 * (or a single placeholder paragraph) and the editor handles that.
 */
export function deleteBlock(
  doc: Record<string, unknown>,
  blockId: string,
): { doc: Record<string, unknown>; found: boolean; refused?: boolean; reason?: string } {
  const found = findBlock(doc, blockId);
  if (!found) return { doc, found: false };

  // Refuse to empty a non-root container.
  if (found.parent.type && found.parent.type !== 'doc' && found.siblingCount <= 1) {
    return {
      doc,
      found: true,
      refused: true,
      reason:
        `deleting block ${blockId} would leave its ${found.parent.type} container empty, ` +
        `which most schemas reject. Delete the ${found.parent.type} itself instead, ` +
        `or replace this block with a placeholder.`,
    };
  }

  const next = clone(doc as AnyNode);
  const target = findBlock(next as unknown as Record<string, unknown>, blockId)!;
  target.parent.content!.splice(target.index, 1);
  return { doc: next as unknown as Record<string, unknown>, found: true };
}

/**
 * Structured clone of a PM node tree. Uses JSON round-trip — these are
 * pure JSON shapes (no functions, no cycles, no Dates), so the round-trip
 * is exact and fast. Avoids dragging in a structuredClone polyfill +
 * keeps the helper isomorphic (server + browser, no special deps).
 */
function clone<T>(node: T): T {
  return JSON.parse(JSON.stringify(node)) as T;
}
