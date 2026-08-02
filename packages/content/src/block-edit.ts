/**
 * Block-addressed editing helpers: find / replace / insert (before, after,
 * start/end) / delete / wrap blocks in a ProseMirror doc by stable id.
 * Foundation for the Phase 2b page_block_* tools (find via page_blocks_list,
 * then mutate via these), and (later) for the Phase 3a editor's diff view.
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

import { BLOCK_NODE_TYPES, mintBlockId } from './block-ids';

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
export function findBlock(doc: Record<string, unknown>, blockId: string): FindResult | null {
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
 * Return a new doc with `newBlocks` inserted directly before the block
 * matching `blockId`. Mirror of insertAfterBlock, with the same id semantics
 * (new blocks keep their fresh parse-minted ids; id-less ones get fresh
 * ids on the next ensureBlockIds pass via saveDraft).
 */
export function insertBeforeBlock(
  doc: Record<string, unknown>,
  blockId: string,
  newBlocks: AnyNode[],
): { doc: Record<string, unknown>; found: boolean } {
  const found = findBlock(doc, blockId);
  if (!found) return { doc, found: false };

  const next = clone(doc as AnyNode);
  const target = findBlock(next as unknown as Record<string, unknown>, blockId)!;
  target.parent.content!.splice(target.index, 0, ...newBlocks);
  return { doc: next as unknown as Record<string, unknown>, found: true };
}

/**
 * Return a new doc with `newBlocks` added at the very start or end of the
 * ROOT: the anchor-free insertion path (prepend an intro, append a
 * closing section) that doesn't require the caller to know any existing
 * block id first. Always succeeds: the doc root exists even when empty.
 */
export function appendBlocks(
  doc: Record<string, unknown>,
  newBlocks: AnyNode[],
  position: 'start' | 'end',
): { doc: Record<string, unknown> } {
  const next = clone(doc as AnyNode);
  if (!Array.isArray(next.content)) next.content = [];
  if (position === 'start') next.content.splice(0, 0, ...newBlocks);
  else next.content.push(...newBlocks);
  return { doc: next as unknown as Record<string, unknown> };
}

export type WrapContainer = 'callout' | 'aside' | 'columns';

const CALLOUT_VARIANTS = new Set(['info', 'success', 'warning', 'danger']);
const ASIDE_COLORS = new Set(['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']);
/** Block types that only exist as structural children of a specific parent
 *  (list / table / columnList); pulling one into a callout/aside/columns
 *  wrapper, or splicing a wrapper in among its siblings, is schema-invalid
 *  either way. */
const STRUCTURAL_CHILD_TYPES = new Set([
  'listItem',
  'taskItem',
  'tableRow',
  'tableCell',
  'tableHeader',
  'column',
]);
/** Wrapping more than this many blocks into columns would produce an
 *  unreadably narrow layout; the caller should group content first. */
const MAX_WRAP_COLUMNS = 4;

/**
 * Return a new doc where the blocks matching `blockIds`, which must be a
 * CONTIGUOUS run of siblings under ONE parent, are moved inside a freshly
 * built container (callout / aside / columns) spliced into the run's slot.
 * The blocks travel byte-for-byte (no re-emission), keeping their ids; the
 * wrapper gets a minted id, returned as `wrapperId` so tool output can
 * report it for chaining. `variant` carries the callout variant or aside
 * themed colour (unknown values fall back like the markdown fence parser:
 * 'info' / 'chart-1'); columns get one column per block.
 *
 * Refusals (all schema-safety): non-sibling or non-contiguous ids, blocks
 * that are structural children (list items, table rows/cells, columns),
 * a callout wrapped inside a callout, columns nested inside a column, and
 * a columns wrap of more blocks than fit side by side.
 */
export function wrapBlocks(
  doc: Record<string, unknown>,
  blockIds: string[],
  container: WrapContainer,
  variant?: string,
): {
  doc: Record<string, unknown>;
  found: boolean;
  refused?: boolean;
  reason?: string;
  missingId?: string;
  wrapperId?: string;
} {
  const refuse = (reason: string) => ({ doc, found: true, refused: true, reason });
  if (blockIds.length === 0) {
    return { doc, found: true, refused: true, reason: 'block_ids is empty; nothing to wrap' };
  }
  const seen = new Set<string>();
  for (const id of blockIds) {
    if (seen.has(id)) return refuse(`block id ${id} appears twice in block_ids`);
    seen.add(id);
  }

  const next = clone(doc as AnyNode);
  const hits: FindResult[] = [];
  for (const id of blockIds) {
    const hit = walk(next, id);
    if (!hit) return { doc, found: false, missingId: id };
    hits.push(hit);
  }

  const parent = hits[0]!.parent;
  if (hits.some((h) => h.parent !== parent)) {
    return refuse(
      'blocks span different parents; wrap only takes siblings under ONE container. ' +
        'Wrap each parent\'s run separately.',
    );
  }
  const indices = hits.map((h) => h.index).sort((a, b) => a - b);
  if (indices[indices.length - 1]! - indices[0]! + 1 !== indices.length) {
    return refuse(
      'blocks are not contiguous; wrap only takes an unbroken run of siblings. ' +
        'Wrap each contiguous run separately, or include the blocks in between.',
    );
  }
  if (hits.some((h) => h.block.type && STRUCTURAL_CHILD_TYPES.has(h.block.type))) {
    return refuse(
      'a targeted block is a structural child (list item / table row or cell / column) ' +
        'that cannot leave its parent; wrap the whole list / table / columnList instead.',
    );
  }
  if (parent.type && STRUCTURAL_CHILD_TYPES.has(parent.type) && parent.type !== 'column') {
    return refuse(
      `blocks live inside a ${parent.type}, which cannot hold a ${container}; ` +
        'wrap the enclosing list / table instead.',
    );
  }
  if (container === 'callout' && parent.type === 'callout') {
    return refuse('a callout cannot nest inside a callout; wrap the outer callout instead.');
  }
  if (container === 'columns' && (parent.type === 'column' || parent.type === 'columnList')) {
    return refuse('columns cannot nest inside columns; restructure the outer columnList instead.');
  }
  if (container === 'columns' && blockIds.length > MAX_WRAP_COLUMNS) {
    return refuse(
      `columns wraps one column per block and caps at ${MAX_WRAP_COLUMNS}; ` +
        `${blockIds.length} blocks would be unreadably narrow. Group the content first ` +
        '(e.g. wrap runs in callouts, then wrap those).',
    );
  }

  const start = indices[0]!;
  // Splice in DOCUMENT order regardless of the order ids were passed in.
  const run = parent.content!.slice(start, start + blockIds.length);
  const wrapperId = mintBlockId();
  let wrapper: AnyNode;
  if (container === 'callout') {
    const v = variant && CALLOUT_VARIANTS.has(variant) ? variant : 'info';
    wrapper = { type: 'callout', attrs: { id: wrapperId, variant: v }, content: run };
  } else if (container === 'aside') {
    const color = variant && ASIDE_COLORS.has(variant) ? variant : 'chart-1';
    wrapper = { type: 'aside', attrs: { id: wrapperId, color, angle: 135 }, content: run };
  } else {
    wrapper = {
      type: 'columnList',
      attrs: { id: wrapperId },
      content: run.map((b) => ({ type: 'column', content: [b] })),
    };
  }
  parent.content!.splice(start, blockIds.length, wrapper);
  return { doc: next as unknown as Record<string, unknown>, found: true, wrapperId };
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
