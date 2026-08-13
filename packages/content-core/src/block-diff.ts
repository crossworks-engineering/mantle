/**
 * Block-level diff between two PM docs — typically the published `doc`
 * vs the in-flight `draft_doc`. Powers the Phase 3a AI-assist panel
 * ("Pages changed 3 blocks") and (later) the per-block visual diff in
 * the editor.
 *
 * Algorithm: match blocks by stable id (the foundation that block-ids.ts
 * provides). The four states per block are:
 *
 *   - unchanged: same id in both, content equal → no entry
 *   - added:     id only in draft → DRAFT introduced a new block
 *   - removed:   id only in doc → DRAFT removed a block
 *   - changed:   same id in both, content differs → DRAFT modified the block
 *
 * "Content equal" uses JSON.stringify of the block node (cheap, exact —
 * captures attribute, mark, and structure changes, not just text).
 *
 * Returns flat lists, not a tree. The panel renders these grouped;
 * downstream tools (commit, discard) operate at the doc level (the diff
 * is just for displaying what's about to happen).
 *
 * Pure. Imports the same listBlocks helper as `page_blocks_list` so the
 * shape of each entry matches what the agent already saw.
 */

import { listBlocks, type BlockListEntry } from './block-list';

export type BlockChange =
  | { kind: 'added'; block: BlockListEntry }
  | { kind: 'removed'; block: BlockListEntry }
  | { kind: 'changed'; from: BlockListEntry; to: BlockListEntry };

export type BlockDiff = {
  /** Blocks present in draft, absent in doc — agent inserted these. */
  added: BlockListEntry[];
  /** Blocks present in doc, absent in draft — agent removed these. */
  removed: BlockListEntry[];
  /** Same id in both, content differs — agent rewrote these. */
  changed: Array<{ from: BlockListEntry; to: BlockListEntry }>;
  /** Total blocks in the draft that weren't touched. Useful for "23 of 25 blocks unchanged" UX. */
  unchangedCount: number;
  /** Flat list of every change in document order — for diff rendering. */
  ordered: BlockChange[];
};

/**
 * Compute the block-level diff. Pass the doc (published) and draft.
 * If either is null/empty, the diff is computed against an empty
 * counterpart — callers can pass an empty doc when one side is missing.
 */
export function diffBlocks(
  doc: Record<string, unknown>,
  draft: Record<string, unknown>,
): BlockDiff {
  const docBlocks = listBlocks(doc);
  const draftBlocks = listBlocks(draft);

  // We need the full nodes for content-equality, but listBlocks only
  // returns previews. Walk both docs again to capture id → full JSON.
  // Cheap (single pass each) — only done when something invokes us.
  const docJsonById = collectBlockJson(doc);
  const draftJsonById = collectBlockJson(draft);

  const docById = new Map(docBlocks.map((b) => [b.id, b]));
  const draftById = new Map(draftBlocks.map((b) => [b.id, b]));

  const added: BlockListEntry[] = [];
  const removed: BlockListEntry[] = [];
  const changed: Array<{ from: BlockListEntry; to: BlockListEntry }> = [];
  let unchangedCount = 0;
  const ordered: BlockChange[] = [];

  for (const draftBlock of draftBlocks) {
    const docBlock = docById.get(draftBlock.id);
    if (!docBlock) {
      added.push(draftBlock);
      ordered.push({ kind: 'added', block: draftBlock });
      continue;
    }
    const docJson = docJsonById.get(draftBlock.id);
    const draftJson = draftJsonById.get(draftBlock.id);
    if (blockJsonEqual(docJson, draftJson)) {
      unchangedCount++;
    } else {
      changed.push({ from: docBlock, to: draftBlock });
      ordered.push({ kind: 'changed', from: docBlock, to: draftBlock });
    }
  }
  // Blocks only in the doc (not in draft) are removals — preserve doc order
  // for these, then concat after the draft-ordered changes so the consumer
  // can render "everything in draft order, then what got removed".
  for (const docBlock of docBlocks) {
    if (!draftById.has(docBlock.id)) {
      removed.push(docBlock);
      ordered.push({ kind: 'removed', block: docBlock });
    }
  }

  return { added, removed, changed, unchangedCount, ordered };
}

// ─── Helpers ───────────────────────────────────────────────────────────

type AnyNode = {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: AnyNode[];
};

/**
 * Walk a doc and collect every addressable block's full JSON, keyed by
 * id. Used for content-equality in the diff. We compare full node JSON
 * rather than just text so style changes (callout variant flip, heading
 * level change, mark added/removed) register as 'changed' even if the
 * plaintext is identical.
 */
function collectBlockJson(doc: Record<string, unknown>): Map<string, AnyNode> {
  const out = new Map<string, AnyNode>();
  walkCollect(doc as AnyNode, out);
  return out;
}

function walkCollect(node: AnyNode, out: Map<string, AnyNode>): void {
  if (!node || typeof node !== 'object') return;
  const id = node.attrs && typeof node.attrs.id === 'string' ? node.attrs.id : null;
  if (id) out.set(id, node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) walkCollect(child, out);
  }
}

/**
 * Compare two PM block nodes for content equality. Uses stable
 * (sorted-key) JSON stringification so two nodes with the same fields
 * in different orders compare equal — necessary because ensureBlockIds
 * produces `{ type, content, attrs }` (spread + add) while hand-built
 * nodes (e.g. agent tool output, autosave round-trips through different
 * serializers) often have `{ type, attrs, content }`. JSON-string
 * compare is fast enough for the panel diff (typical block ~200 bytes;
 * even a 200-block page is ~40 KB of stringification — one-shot per
 * diff call).
 */
function blockJsonEqual(a: AnyNode | undefined, b: AnyNode | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return stableStringify(a) === stableStringify(b);
}

/** JSON.stringify with sorted object keys at every depth. Arrays keep
 *  their order (semantic in PM). Stable across the runtime — the same
 *  input always produces the same string. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
