/**
 * Map ltree paths under the `files` root branch to filesystem paths under
 * MANTLE_FILES_ROOT. The `files` segment is the marker — anything not
 * descending from it is DB-only and shouldn't be touched on disk.
 *
 * `files.work.acme`             → `${ROOT}/work/acme`
 * `files`                       → `${ROOT}`
 * `inbox.email_alex.…`          → null (not a host-mirrored branch)
 */

import path from 'node:path';
import { ltreeToDash } from './slug';

/** The single ltree label that marks the host-filesystem root branch. */
export const FILES_ROOT_LABEL = 'files';

/** Default location when MANTLE_FILES_ROOT isn't set. */
const DEFAULT_ROOT = './data/files';

let warnedUnset = false;

/** Read MANTLE_FILES_ROOT, normalised to an absolute path.
 *
 *  The default (`./data/files`) is CWD-relative, so if it's left unset the
 *  web app, agent, and workers each resolve a DIFFERENT root (their own
 *  cwd) — a "split brain" where a file written by one process is invisible
 *  to the others (e.g. a web upload the agent's extractor can never read).
 *  Warn loudly once so this never happens silently again; production should
 *  always set an absolute MANTLE_FILES_ROOT shared by every process. */
export function filesRoot(): string {
  const env = process.env.MANTLE_FILES_ROOT?.trim();
  if (!env && !warnedUnset) {
    warnedUnset = true;
    console.warn(
      '[files] MANTLE_FILES_ROOT is not set — falling back to the cwd-relative ' +
        `'${DEFAULT_ROOT}'. Each process then uses its own root and files written ` +
        'by one are invisible to the others. Set an absolute path in .env.local.',
    );
  }
  return path.resolve(env || DEFAULT_ROOT);
}

/**
 * The forum-upload QUARANTINE root — a SIBLING of the files root, deliberately
 * outside the `files` ltree so nothing under it is ever picked up by ingestion
 * (the migration-0018 trigger fires on file NODES; quarantined bytes have no
 * node until the owner files them). Layout: `<root>/<ownerId>/<uploadId>`,
 * see quarantine.ts. With the default files root `./data/files` this resolves
 * to `./data/forum-uploads`, staying inside the same MANTLE_DATA_DIR
 * bind-mount in production.
 */
export function quarantineRoot(): string {
  return path.resolve(filesRoot(), '..', 'forum-uploads');
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

/**
 * Reverse-map an absolute file path on disk to (parentLtreePath, filename).
 * Returns null when the path is outside the host-mirrored root.
 *
 * Used by the external-edit watcher to figure out where a file landed
 * so we can sync the DB row.
 */
export function ltreeForDiskPath(absPath: string): { parentPath: string; filename: string } | null {
  const root = filesRoot();
  const resolved = path.resolve(absPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..')) return null;
  const parts = rel.split(path.sep);
  const filename = parts.pop();
  if (!filename) return null;
  const segments = parts.map((s) => s.replace(/-/g, '_'));
  const parentPath =
    segments.length === 0 ? FILES_ROOT_LABEL : `${FILES_ROOT_LABEL}.${segments.join('.')}`;
  return { parentPath, filename };
}
