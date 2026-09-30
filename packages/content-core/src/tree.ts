/**
 * Path math for the item tree (@mantle/client-types/tree). A folder's or an
 * item's place is an ltree path under its kind's root: `files` is the root,
 * `files.clients` a top-level folder, `files.clients.acme.contracts` the
 * deepest a folder may sit. Pure, so the brain and every client agree on
 * depth, parents and crumbs without a round trip.
 */
import {
  TREE_KIND_SPECS,
  TREE_KINDS,
  TREE_MAX_DEPTH,
  type TreeKind,
} from '@mantle/client-types/tree';

function labels(path: string): string[] {
  return path ? path.split('.') : [];
}

/** The kind whose root the path sits under, or null outside every root. */
export function treeKindOfPath(path: string): TreeKind | null {
  const root = labels(path)[0];
  return TREE_KINDS.find((k) => TREE_KIND_SPECS[k].root === root) ?? null;
}

/** How deep below its root a path is: 0 for the root itself, 1 for a
 *  top-level folder. */
export function treeDepth(path: string): number {
  return Math.max(0, labels(path).length - 1);
}

/** The parent path; the root is its own parent. */
export function treeParentPath(path: string): string {
  const parts = labels(path);
  return parts.length <= 1 ? path : parts.slice(0, -1).join('.');
}

/** The folder paths from the top level down to `path` itself, root excluded:
 *  `files.a.b` gives `['files.a', 'files.a.b']`. */
export function treeFolderChain(path: string): string[] {
  const parts = labels(path);
  const out: string[] = [];
  for (let i = 2; i <= parts.length; i++) out.push(parts.slice(0, i).join('.'));
  return out;
}

/** Whether a folder may live at `path` (its depth is within the limit). */
export function isTreeFolderPathAllowed(path: string): boolean {
  const depth = treeDepth(path);
  return depth >= 1 && depth <= TREE_MAX_DEPTH;
}

/**
 * Cut a folder path that would sit too deep back to the deepest allowed
 * level: the extra levels are lifted into the third. Inbound paths use it (an
 * agent's `mkdir -p`, the crawler, Accept), so a deep chain lands in the
 * deepest folder instead of failing.
 */
export function clampTreePath(path: string): string {
  const parts = labels(path);
  return parts.slice(0, TREE_MAX_DEPTH + 1).join('.');
}

/** A moved folder subtree's deepest depth: `subtreeDepth` levels (1 for a
 *  folder with no subfolders) placed under `targetPath`. */
export function treeMoveDepth(targetPath: string, subtreeDepth: number): number {
  return treeDepth(targetPath) + subtreeDepth;
}
