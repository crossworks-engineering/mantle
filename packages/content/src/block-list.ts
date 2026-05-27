/**
 * Block TOC extraction — flat listing of every addressable block in a
 * ProseMirror doc, with type / depth / id / short text preview. Powers
 * `page_blocks_list` (the agent's "what's in this page?" tool) and the
 * Phase 3a editor's block picker.
 *
 * Designed to be cheap to send to a model: 50–80 bytes per block in
 * JSON, so a 200-block page is ~10–15 KB total — well under the
 * inline tool-result cap. Agent reads the TOC to decide WHICH blocks
 * to touch, then fetches only those (Phase 2b mutation tools).
 *
 * Pure, no DB. Companion to block-ids.ts — and imports the addressable
 * block-type set from there so the two stay in lockstep automatically.
 * A new block type added to block-ids.ts is picked up here for free.
 */

import { BLOCK_NODE_TYPES as BLOCK_TYPES } from './block-ids';

export type BlockListEntry = {
  /** Stable per-block id (assigned by ensureBlockIds). May be the
   *  empty string if the doc was somehow built without injection — the
   *  walker is defensive and still lists the block. */
  id: string;
  /** PM node type (e.g. 'heading', 'paragraph', 'callout'). */
  kind: string;
  /** Tree depth: 1 = direct child of doc, 2 = inside a container, etc. */
  depth: number;
  /** First ~80 chars of textContent, single-line, trimmed. Empty
   *  string for purely structural nodes (horizontalRule, table without
   *  inner text yet, etc.). */
  preview: string;
  /** For headings: their level (1/2/3). For codeBlock: language. For
   *  callout: variant. Helps the model choose. Omitted when N/A. */
  meta?: Record<string, unknown>;
};

export type ListBlocksOptions = {
  /** If set, only list blocks at this depth or shallower. Useful when
   *  the model just wants a high-level outline (depth: 1) or top-level
   *  + first-nested (depth: 2). Default: unlimited. */
  maxDepth?: number;
  /** Preview character cap. Default 80. */
  previewChars?: number;
  /** If set, only blocks whose `kind` is in this set are listed (but
   *  the walker still DESCENDS through other types — a paragraph inside
   *  a callout is still findable when filtering by 'paragraph'). Powers
   *  targeted edits: 'find every blockquote', 'list every heading',
   *  etc., without the spill risk of unfiltered output on a large doc. */
  kinds?: ReadonlyArray<string>;
};

type AnyNode = {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: AnyNode[];
  text?: string;
};

/**
 * Walk the doc, return flat block list in document order. Container
 * blocks appear BEFORE their children (so the agent sees structure
 * top-down — heading first, then the paragraphs under it).
 */
export function listBlocks(
  doc: Record<string, unknown>,
  opts: ListBlocksOptions = {},
): BlockListEntry[] {
  const maxDepth = opts.maxDepth ?? Infinity;
  const previewChars = opts.previewChars ?? 80;
  const kindFilter = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;
  const out: BlockListEntry[] = [];
  walk(doc as AnyNode, 0, out, maxDepth, previewChars, kindFilter);
  return out;
}

function walk(
  node: AnyNode,
  depth: number,
  out: BlockListEntry[],
  maxDepth: number,
  previewChars: number,
  kindFilter: Set<string> | null,
): void {
  if (!node || typeof node !== 'object') return;
  const kind = node.type;
  if (kind && BLOCK_TYPES.has(kind)) {
    // depth+1 because the doc root itself is depth 0; its first children
    // are depth 1 (the natural reading: "block 1, block 2, …" at the
    // top of the page).
    const blockDepth = depth + 1;
    // Two gates to PUSH: within maxDepth AND (no kind filter OR kind matches).
    // The recursion always descends regardless of kind — a paragraph inside
    // a filtered-out callout still gets listed if its own kind passes.
    if (blockDepth <= maxDepth && (!kindFilter || kindFilter.has(kind))) {
      out.push({
        id: typeof node.attrs?.id === 'string' ? node.attrs.id : '',
        kind,
        depth: blockDepth,
        preview: makePreview(node, previewChars),
        ...(blockMeta(kind, node) ? { meta: blockMeta(kind, node)! } : {}),
      });
    }
    // Always recurse INTO the block, even if we're at maxDepth — children
    // beyond the cap simply don't get listed, but we still walk them in
    // case of cap=1 (only top-level) the walker exits at the children
    // loop without adding more entries. That's fine.
    if (Array.isArray(node.content) && blockDepth < maxDepth) {
      for (const child of node.content) {
        walk(child, blockDepth, out, maxDepth, previewChars, kindFilter);
      }
    }
    return;
  }
  // Non-block (doc root, text, marks): recurse children with same depth.
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      walk(child, depth, out, maxDepth, previewChars, kindFilter);
    }
  }
}

function makePreview(node: AnyNode, max: number): string {
  const text = collectText(node).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

function collectText(node: AnyNode): string {
  if (!node || typeof node !== 'object') return '';
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  let acc = '';
  for (const child of node.content) {
    const t = collectText(child);
    if (t) {
      if (acc && !acc.endsWith(' ')) acc += ' ';
      acc += t;
    }
  }
  return acc;
}

function blockMeta(kind: string, node: AnyNode): Record<string, unknown> | null {
  const attrs = node.attrs ?? {};
  switch (kind) {
    case 'heading':
      return typeof attrs.level === 'number' ? { level: attrs.level } : null;
    case 'codeBlock':
      return typeof attrs.language === 'string' && attrs.language
        ? { language: attrs.language }
        : null;
    case 'callout':
      return typeof attrs.variant === 'string' ? { variant: attrs.variant } : null;
    case 'taskItem':
      return typeof attrs.checked === 'boolean' ? { checked: attrs.checked } : null;
    case 'image':
    case 'pageImage':
      return typeof attrs.alt === 'string' && attrs.alt ? { alt: attrs.alt } : null;
    default:
      return null;
  }
}
