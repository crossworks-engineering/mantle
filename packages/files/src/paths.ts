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
import { env } from '@mantle/config';

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
  const configured = env('MANTLE_FILES_ROOT')?.trim();
  if (!configured && !warnedUnset) {
    warnedUnset = true;
    console.warn(
      '[files] MANTLE_FILES_ROOT is not set — falling back to the cwd-relative ' +
        `'${DEFAULT_ROOT}'. Each process then uses its own root and files written ` +
        'by one are invisible to the others. Set an absolute path in .env.local.',
    );
  }
  return path.resolve(configured || DEFAULT_ROOT);
}

/** Folders nest at most this deep below `files`: folder › subfolder ›
 *  sub-subfolder. The item tree's limit (TREE_MAX_DEPTH in
 *  @mantle/client-types/tree; a content test pins the two together), and the
 *  database refuses a deeper folder (migration 0201). */
export const FILES_MAX_FOLDER_DEPTH = 3;

/** How deep below `files` a path is: 0 for the root, 1 for a top folder. */
export function filesFolderDepth(ltreePath: string): number {
  return ltreePath.split('.').length - 1;
}

/** Cut a folder path back to its first FILES_MAX_FOLDER_DEPTH folders: a
 *  deeper chain lands in its third folder instead of failing. */
export function clampFilesFolderPath(ltreePath: string): string {
  return ltreePath
    .split('.')
    .slice(0, FILES_MAX_FOLDER_DEPTH + 1)
    .join('.');
}

/** Throw a readable error when a folder at `ltreePath` would sit too deep. */
export function assertFilesFolderDepth(ltreePath: string, op: string): void {
  if (filesFolderDepth(ltreePath) > FILES_MAX_FOLDER_DEPTH) {
    throw new Error(
      `${op}: '${ltreePath}' is deeper than ${FILES_MAX_FOLDER_DEPTH} folder levels; folders nest folder, subfolder, sub-subfolder`,
    );
  }
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
 * Is this a basename we can safely join onto a folder path?
 *
 * The counterpart to {@link diskPathForFile}: anything this accepts must round
 * trip back to the same file. It VALIDATES and never transforms, which is the
 * distinction that matters — `sanitizeFilename` invents a safe name for bytes
 * we are about to write, and lowercases in the process. Applying it to a file
 * that already exists records a name the filesystem does not have, and on a
 * case-sensitive filesystem the path then resolves to nothing.
 */
export function isSafeDiskBasename(name: string): boolean {
  const n = name.trim();
  if (!n || n === '.' || n === '..') return false;
  return !/[\\/]/.test(n);
}

/**
 * Resolve a file's absolute path: its parent folder's disk path joined
 * with the filename EXACTLY as stored. Returns null if the parent folder isn't
 * host-mirrored, or the name isn't a safe basename.
 */
export function diskPathForFile(parentLtreePath: string, filename: string): string | null {
  const parentDir = diskPathForLtree(parentLtreePath);
  if (!parentDir) return null;
  if (!isSafeDiskBasename(filename)) return null;
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

/**
 * The refusal for a Files folder operation handed a folder (or a
 * destination) of another kind. Every kind's folders are branch rows, but
 * only Files folders are directories: the others hold their items by path
 * alone, so a Files delete would leave them behind (and any share they
 * inherited through it), and a move would carry them across kinds.
 */
export function notAFilesFolder(op: string, path: string): Error {
  return new Error(
    `${op}: '${path}' is not a Files folder; organise another kind's folders with ` +
      'tree_folder_update and tree_folder_delete (or its own screen)',
  );
}
