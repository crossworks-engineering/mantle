/**
 * page-diff — the visual-diff overlay model for the page editor's review mode
 * (Phase 3a Pass 2). Turns a (committed `doc`, working `draft`) pair into the
 * exact sets the editor needs to paint:
 *
 *   - addedIds   — blocks the draft introduced, TOP-MOST only (an added callout
 *                  is bordered once, not again on each of its new children).
 *   - changedIds — blocks whose content differs, DEEPEST only (a changed inner
 *                  paragraph is bordered, not its unchanged-shell container) and
 *                  never inside an added subtree (already covered).
 *   - removed    — TOP-LEVEL blocks the draft dropped, with the text to show in
 *                  a "ghost" card and the draft block id to anchor it after
 *                  (`afterId`, null = top of doc). Removed blocks aren't in the
 *                  draft, so the editor can only show them as widget overlays —
 *                  this is what makes a deletion visible at all.
 *
 * `counts` reflect EVERY change (added/changed/removed at any depth, straight
 * from diffBlocks) so the legend is honest even though nested removals aren't
 * drawn as ghosts.
 *
 * Pure + DB-free (built on diffBlocks). Recomputed client-side on every draft
 * change, so the overlay always matches "what Commit will publish".
 */

import { diffBlocks } from './block-diff';

type AnyNode = {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: AnyNode[];
  text?: string;
};

export type RemovedGhost = {
  id: string;
  /** PM node type, e.g. 'paragraph' | 'heading' | 'callout'. */
  kind: string;
  /** Plain-text preview of the removed block (capped). */
  text: string;
  /** Draft block id to render the ghost after; null → top of document. */
  afterId: string | null;
};

export type DiffOverlay = {
  addedIds: string[];
  changedIds: string[];
  removed: RemovedGhost[];
  counts: { added: number; changed: number; removed: number };
};

const TEXT_CAP = 400;

/** Plain text of a node — descendant text nodes concatenated, trimmed + capped. */
function nodeText(node: AnyNode): string {
  let out = '';
  const walk = (n: AnyNode) => {
    if (out.length > TEXT_CAP) return;
    if (typeof n.text === 'string') out += n.text;
    for (const c of n.content ?? []) walk(c);
  };
  walk(node);
  out = out.trim();
  return out.length > TEXT_CAP ? `${out.slice(0, TEXT_CAP)}…` : out;
}

function collectIds(node: AnyNode, into: Set<string>): void {
  const id = node.attrs?.id;
  if (typeof id === 'string') into.add(id);
  for (const c of node.content ?? []) collectIds(c, into);
}

export function computeDiffOverlay(
  committed: Record<string, unknown>,
  draft: Record<string, unknown>,
): DiffOverlay {
  const d = diffBlocks(committed, draft);
  const addedSet = new Set(d.added.map((b) => b.id));
  const changedSet = new Set(d.changed.map((c) => c.to.id));

  // Walk the DRAFT tree once: collect top-most added + deepest changed, so the
  // borders land on the most specific block and never nest.
  const addBorder = new Set<string>();
  const changeBorder = new Set<string>();
  const walk = (node: AnyNode, insideAdded: boolean): boolean => {
    const id = typeof node.attrs?.id === 'string' ? (node.attrs.id as string) : null;
    const isAdded = id != null && addedSet.has(id);
    if (isAdded && !insideAdded && id) addBorder.add(id);
    const nowInsideAdded = insideAdded || isAdded;
    let descChanged = false;
    for (const c of node.content ?? []) descChanged = walk(c, nowInsideAdded) || descChanged;
    const isChanged = id != null && changedSet.has(id);
    if (isChanged && !descChanged && !nowInsideAdded && id) changeBorder.add(id);
    return isChanged || descChanged;
  };
  for (const top of (draft as AnyNode).content ?? []) walk(top, false);

  // Top-level removals → ghost cards, anchored after the nearest surviving
  // top-level block (by id) so they appear where they used to be.
  const draftIds = new Set<string>();
  collectIds(draft as AnyNode, draftIds);
  const removed: RemovedGhost[] = [];
  let lastSurviving: string | null = null;
  for (const top of (committed as AnyNode).content ?? []) {
    const id = typeof top.attrs?.id === 'string' ? (top.attrs.id as string) : null;
    if (id && draftIds.has(id)) {
      lastSurviving = id;
      continue;
    }
    if (id) {
      removed.push({ id, kind: top.type ?? 'block', text: nodeText(top), afterId: lastSurviving });
    }
  }

  return {
    addedIds: [...addBorder],
    changedIds: [...changeBorder],
    removed,
    counts: { added: d.added.length, changed: d.changed.length, removed: d.removed.length },
  };
}
