/**
 * Host filesystem operations for the `files.*` subtree.
 *
 * All write paths funnel through these helpers so the DB ↔ disk pairing
 * stays consistent. None of them touch the DB themselves — callers
 * compose them with `@mantle/db` writes inside a single API handler.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  diskPathForFile,
  diskPathForLtree,
  filesRoot,
  isFilesPath,
} from './paths.js';

/** Ensure the root + an arbitrary descendant directory exist. mkdir -p. */
export async function ensureDir(ltreePath: string): Promise<string> {
  const dir = diskPathForLtree(ltreePath);
  if (!dir) {
    throw new Error(`ensureDir: '${ltreePath}' is outside the files root`);
  }
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Same but for the root (so server startup can pre-create it). */
export async function ensureRoot(): Promise<string> {
  const root = filesRoot();
  await fs.mkdir(root, { recursive: true });
  return root;
}

/**
 * Write a file under a folder. Returns sha256 + size + absolute path so
 * the caller can persist metadata. Throws on collision unless overwrite=true.
 */
export async function writeFile(
  parentLtreePath: string,
  filename: string,
  bytes: Buffer,
  opts: { overwrite?: boolean } = {},
): Promise<{ path: string; sha256: string; size: number }> {
  const filePath = diskPathForFile(parentLtreePath, filename);
  if (!filePath) {
    throw new Error(`writeFile: cannot resolve disk path for ${parentLtreePath}/${filename}`);
  }
  // Make sure the parent exists.
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (!opts.overwrite) {
    try {
      await fs.access(filePath);
      throw new Error(`writeFile: '${filename}' already exists in this folder`);
    } catch (err) {
      // ENOENT = good, file doesn't exist yet. Re-throw anything else.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // The 'already exists' Error we just threw will land here too.
        if (err instanceof Error && err.message.includes('already exists')) throw err;
      }
    }
  }
  await fs.writeFile(filePath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { path: filePath, sha256, size: bytes.byteLength };
}

export async function readFile(
  parentLtreePath: string,
  filename: string,
): Promise<Buffer> {
  const filePath = diskPathForFile(parentLtreePath, filename);
  if (!filePath) {
    throw new Error(`readFile: cannot resolve disk path for ${parentLtreePath}/${filename}`);
  }
  return fs.readFile(filePath);
}

export async function deleteFile(
  parentLtreePath: string,
  filename: string,
): Promise<void> {
  const filePath = diskPathForFile(parentLtreePath, filename);
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Move/rename a file within the same folder. New name is sanitised
 *  by the caller. Throws on collision. */
export async function renameFile(
  parentLtreePath: string,
  fromName: string,
  toName: string,
): Promise<{ path: string }> {
  const from = diskPathForFile(parentLtreePath, fromName);
  const to = diskPathForFile(parentLtreePath, toName);
  if (!from || !to) throw new Error('renameFile: path resolution failed');
  if (from === to) return { path: from };
  try {
    await fs.access(to);
    throw new Error(`renameFile: '${toName}' already exists in this folder`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof Error && err.message.includes('already exists')) throw err;
    }
  }
  await fs.rename(from, to);
  return { path: to };
}

/** Recursively remove a folder. Caller must check it's empty in the DB
 *  beforehand — this is the unconditional "delete from disk" half. */
export async function removeFolder(ltreePath: string): Promise<void> {
  if (!isFilesPath(ltreePath)) return;
  const dir = diskPathForLtree(ltreePath);
  if (!dir) return;
  // Refuse to nuke the entire root by accident.
  if (dir === filesRoot()) {
    throw new Error('removeFolder: refusing to delete the files root');
  }
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
