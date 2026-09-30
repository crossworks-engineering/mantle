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
  type TreeShareLevel,
} from '@mantle/client-types/tree';
import type { AccessLevel } from '@mantle/client-types';

const LEVEL_RANK: Record<AccessLevel, number> = { public: 0, client: 1, team: 2, admin: 3 };

/**
 * The level an item is read at: the more open of its own level and the share
 * it inherits from a folder (public < client < team < admin). This is the
 * level its pill shows, its embeds follow and its indexed page text is
 * folded for. Folding for the more open reader is safe for every reader of
 * the row: what a public or client reader may see, every reader above may
 * too. (Which ROLES read the row is the database's union of the two:
 * nodes_viewer_read, migration 0204.)
 */
export function effectiveLevel(
  own: AccessLevel,
  inherited: TreeShareLevel | null | undefined,
): AccessLevel {
  if (!inherited) return own;
  return LEVEL_RANK[inherited] < LEVEL_RANK[own] ? inherited : own;
}

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
