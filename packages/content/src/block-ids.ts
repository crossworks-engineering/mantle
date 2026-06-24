/**
 * Block-id injection for ProseMirror docs (Phase 2b — block-addressed
 * editing). Walks a doc tree and adds `attrs.id` (a UUID) to every block
 * node that doesn't already have one, leaving everything else untouched.
 * Pure, idempotent, no DB.
 *
 * Why this exists: pages today are addressable only by position in the
 * tree ("the 3rd paragraph"). Position breaks on every insert/delete and
 * is brittle when an agent emits edits. Stable per-block ids give us
 * "edit block <id>" semantics that survive concurrent changes.
 *
 * The injection runs in three places:
 *  - `markdownToDoc`     — every freshly-generated doc gets ids at parse
 *  - `getPage`           — legacy docs (no ids) get them on read (lazy
 *                          backfill, no DB write — saveDraft / commitPage
 *                          persist them on the next user action)
 *  - `saveDraft` / `commitPage` — guarantees the stored doc carries ids
 *
 * The TipTap editor side is in `apps/web/components/page-editor/block-id.ts`
 * — a global attribute extension that PRESERVES the `id` on parse/serialize
 * so user edits don't strip ids the agent placed.
 *
 * Block coverage — every node type that's editorially meaningful as a unit:
 * paragraph, heading, blockquote, codeBlock, horizontalRule, callout, aside,
 * columnList, column, bulletList, orderedList, taskList, listItem, taskItem,
 * table, tableRow, tableCell, tableHeader, blockMath, image, pageImage,
 * fileEmbed, childPage. Inline text/marks + inlineMath stay un-id'd (they're not
 * addressable units; the model edits their containing block instead).
 */

const BLOCK_TYPES = new Set([
  // Standard structural
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  // Lists
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  // Tables
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  // Mantle custom blocks
  'callout',
  'aside',
  'columnList',
  'column',
  // Atoms still worth addressing (the agent might want to swap an image)
  'image',
  'pageImage',
  'fileEmbed',
  'blockMath',
  // Sub-page link card (Phase 4a) — addressable so block tools can move/remove it
  'childPage',
]);

type AnyNode = {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: AnyNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

function newId(): string {
  // crypto.randomUUID is in Node 19+ and modern browsers — both surfaces
  // we run on. Falls back to a Math.random hex string for older runtimes
  // (vitest in legacy modes, hypothetically) so a missing API never throws.
  try {
    return globalThis.crypto?.randomUUID?.() ?? fallbackId();
  } catch {
    return fallbackId();
  }
}

function fallbackId(): string {
  const r = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${r()}-${r().slice(0, 4)}-4${r().slice(1, 4)}-${r().slice(0, 4)}-${r()}${r().slice(0, 4)}`;
}

/**
 * Walk a ProseMirror JSON node, returning a new tree with `attrs.id` set
 * on every block-type node that's missing one. Existing ids are kept as-is.
 * Non-block nodes (text, inline math, marks) are unchanged.
 *
 * Returns the SAME reference when nothing changes (no allocations), so
 * call sites can skip a write when ids were already present.
 */
export function ensureBlockIds<T extends Record<string, unknown>>(doc: T): T {
  const result = walk(doc as AnyNode);
  return result as unknown as T;
}

function walk(node: AnyNode): AnyNode {
  if (!node || typeof node !== 'object') return node;

  let next: AnyNode = node;
  const isBlock = node.type !== undefined && BLOCK_TYPES.has(node.type);
  const needsId = isBlock && (!node.attrs || typeof node.attrs.id !== 'string' || !node.attrs.id);

  if (needsId) {
    next = {
      ...node,
      attrs: { ...(node.attrs ?? {}), id: newId() },
    };
  }

  if (Array.isArray(node.content) && node.content.length > 0) {
    let childrenChanged = false;
    const nextContent: AnyNode[] = new Array(node.content.length);
    for (let i = 0; i < node.content.length; i++) {
      const w = walk(node.content[i]!);
      nextContent[i] = w;
      if (w !== node.content[i]) childrenChanged = true;
    }
    if (childrenChanged) {
      next = { ...next, content: nextContent };
    }
  }

  return next;
}

/**
 * Repair invalid table structure so a doc stays renderable. ProseMirror's
 * `tableRow` content model is `(tableCell | tableHeader)+`; an agent block
 * edit (or any programmatic write) can drop a cell's wrapper, leaving a bare
 * `paragraph` (or other block) as a DIRECT row child. That doc is schema-
 * invalid, so the editor throws `RangeError: Invalid content for node
 * tableRow` the instant it loads — white-screening the whole page. Wrap any
 * stray non-cell child back into a `tableCell` (restoring the intended
 * column). Recurses, so nested tables (inside columns / callouts) are fixed
 * too. Idempotent; returns the SAME reference when nothing needed fixing, so
 * the getPage read-path no-op + lazy-persist optimisation still holds.
 */
export function repairTableRows<T extends Record<string, unknown>>(doc: T): T {
  return repairWalk(doc as AnyNode) as unknown as T;
}

const CELL_TYPES = new Set(['tableCell', 'tableHeader']);

/** Wrap a stray row child in a `tableCell`. A cell needs block content, so a
 *  bare inline/text node gets a `paragraph` wrapper first. */
function wrapInCell(child: AnyNode): AnyNode {
  const inner =
    child && typeof child.type === 'string' && child.type !== 'text'
      ? child
      : { type: 'paragraph', attrs: { id: newId() }, content: child ? [child] : [] };
  return { type: 'tableCell', attrs: { id: newId() }, content: [inner] };
}

function repairWalk(node: AnyNode): AnyNode {
  if (!node || typeof node !== 'object' || !Array.isArray(node.content) || node.content.length === 0) {
    return node;
  }
  // Recurse first so deeply-nested tables get repaired as well.
  let changed = false;
  const walked: AnyNode[] = new Array(node.content.length);
  for (let i = 0; i < node.content.length; i++) {
    const w = repairWalk(node.content[i]!);
    walked[i] = w;
    if (w !== node.content[i]) changed = true;
  }
  let content = walked;
  if (node.type === 'tableRow' && walked.some((c) => !c || !CELL_TYPES.has(c.type ?? ''))) {
    content = walked.map((c) => (c && CELL_TYPES.has(c.type ?? '') ? c : wrapInCell(c)));
    changed = true;
  }
  return changed ? { ...node, content } : node;
}

/**
 * Check whether a doc has ids on every block — handy for tests + for the
 * lazy-backfill paths that want to skip the rewrite when there's nothing
 * to do. Walks the whole tree; O(N) in nodes.
 */
export function allBlocksHaveIds(doc: Record<string, unknown>): boolean {
  return checkAll(doc as AnyNode);
}

function checkAll(node: AnyNode): boolean {
  if (!node || typeof node !== 'object') return true;
  if (node.type && BLOCK_TYPES.has(node.type)) {
    if (!node.attrs || typeof node.attrs.id !== 'string' || !node.attrs.id) return false;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (!checkAll(child)) return false;
    }
  }
  return true;
}

/** Exported for the TipTap-side extension and any other consumer. */
export const BLOCK_NODE_TYPES = BLOCK_TYPES;
