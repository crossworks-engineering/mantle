/**
 * Map ltree paths under the `files` root branch to filesystem paths under
 * MANTLE_FILES_ROOT. The `files` segment is the marker — anything not
 * descending from it is DB-only and shouldn't be touched on disk.
 *
 * `files.work.lister`           → `${ROOT}/work/lister`
 * `files`                       → `${ROOT}`
 * `inbox.email_jason.…`         → null (not a host-mirrored branch)
 */

import path from 'node:path';
import { ltreeToDash } from './slug';

/** The single ltree label that marks the host-filesystem root branch. */
export const FILES_ROOT_LABEL = 'files';

/** Default location when MANTLE_FILES_ROOT isn't set. */
const DEFAULT_ROOT = './data/files';

/** Read MANTLE_FILES_ROOT, normalised to an absolute path. */
export function filesRoot(): string {
  const raw = process.env.MANTLE_FILES_ROOT?.trim() || DEFAULT_ROOT;
  return path.resolve(raw);
}

/**
 * Is this ltree path inside the host-mirrored `files` subtree?
 * Accepts the root itself ('files') and any descendant ('files.x.y').
 */
export function isFilesPath(ltreePath: string): boolean {
  return ltreePath === FILES_ROOT_LABEL || ltreePath.startsWith(`${FILES_ROOT_LABEL}.`);
}

/**
 * Resolve an ltree path under `files.*` to an absolute on-disk directory.
 * Returns null when the path isn't host-mirrored.
 *
 * Security: re-resolves through `path.resolve` so a malformed path can't
 * escape the root via traversal (`..`). Callers must still pass an ltree
 * label set, not user-input strings.
 */
export function diskPathForLtree(ltreePath: string): string | null {
  if (!isFilesPath(ltreePath)) return null;
  const root = filesRoot();
  if (ltreePath === FILES_ROOT_LABEL) return root;
  const rest = ltreePath.slice(FILES_ROOT_LABEL.length + 1); // drop "files."
  const segments = rest.split('.').map(ltreeToDash);
  const joined = path.join(root, ...segments);
  // Guard against any sneaky `..` after segmentation.
  const resolved = path.resolve(joined);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/**
 * Resolve a file's absolute path: its parent folder's disk path joined
 * with the (already-sanitised) filename. Returns null if the parent
 * folder isn't host-mirrored.
 */
export function diskPathForFile(parentLtreePath: string, filename: string): string | null {
  const parentDir = diskPathForLtree(parentLtreePath);
  if (!parentDir) return null;
  if (filename.includes('/') || filename.includes('\\')) return null;
  return path.join(parentDir, filename);
}
