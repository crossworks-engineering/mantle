/**
 * Host filesystem operations for the `files.*` subtree.
 *
 * All write paths funnel through these helpers so the DB ↔ disk pairing
 * stays consistent. None of them touch the DB themselves — callers
 * compose them with `@mantle/db` writes inside a single API handler.
 */

import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { diskPathForFile, diskPathForLtree, filesRoot, isFilesPath } from './paths';

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

export async function readFile(parentLtreePath: string, filename: string): Promise<Buffer> {
  const filePath = diskPathForFile(parentLtreePath, filename);
  if (!filePath) {
    throw new Error(`readFile: cannot resolve disk path for ${parentLtreePath}/${filename}`);
  }
  return fs.readFile(filePath);
}

export async function deleteFile(parentLtreePath: string, filename: string): Promise<void> {
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

/** Move a file BETWEEN folders. Both parents must resolve inside the files
 *  root; the destination file must not already exist. fs.rename is atomic on
 *  the same filesystem, which the files tree always is. */
export async function moveFile(
  fromParentLtree: string,
  filename: string,
  toParentLtree: string,
): Promise<{ path: string }> {
  const from = diskPathForFile(fromParentLtree, filename);
  const to = diskPathForFile(toParentLtree, filename);
  if (!from || !to) throw new Error('moveFile: path resolution failed');
  if (from === to) return { path: from };
  try {
    await fs.access(to);
    throw new Error(`moveFile: '${filename}' already exists in the destination folder`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
  return { path: to };
}

/** Copy a file's bytes to another folder (used by copyFileById — the DB row
 *  is created by upsertFile, which writes the bytes itself, so this helper is
 *  deliberately NOT exported; kept as a comment-anchor for why there is no
 *  disk-level copy: upsertFile owns byte writes, one path only). */

/** Rename a folder's directory in place (the whole subtree moves with it).
 *  `fromLtree`/`toLtree` are the OLD and NEW full ltree paths of the folder.
 *  Throws on collision; refuses to rename the root. The caller pairs this with
 *  the DB ltree cascade. */
export async function renameFolder(fromLtree: string, toLtree: string): Promise<{ path: string }> {
  const from = diskPathForLtree(fromLtree);
  const to = diskPathForLtree(toLtree);
  if (!from || !to) throw new Error('renameFolder: path resolution failed');
  if (from === filesRoot() || to === filesRoot()) {
    throw new Error('renameFolder: refusing to rename the files root');
  }
  if (from === to) return { path: from };
  try {
    await fs.access(to);
    throw new Error(`renameFolder: '${toLtree}' already exists`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof Error && err.message.includes('already exists')) throw err;
    }
  }
  // Make sure the destination parent exists (same parent for a rename, but cheap
  // insurance and keeps this correct if ever reused for a move).
  await fs.mkdir(path.dirname(to), { recursive: true });
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

// ─── Streamed uploads: spool, then adopt ────────────────────────────────────
//
// `writeFile` above takes a Buffer, which is fine for a 25 MB document and
// fatal for a 250 MB database backup: the web route would hold the whole body
// (plus a copy) in a 1.5 GB container. The streamed path never does. Bytes go
// straight from the request into a `.part` file under the spool dir, hashed
// and counted on the way; the cap is enforced per chunk, so an oversized
// upload is refused at the cap, not after the last byte. Adoption is a
// rename into the folder (same filesystem, so it is atomic and free).
//
// The spool dir is a dotdir under the files root: the disk-sync watcher
// ignores dot-prefixed paths, so a half-written `.part` never becomes a node.

/** Thrown by `spoolUpload` when the stream passes `maxBytes`. The caller maps
 *  it to HTTP 413. `filename` is filled in by the multipart layer when known. */
export class UploadTooLargeError extends Error {
  filename?: string;
  constructor(readonly maxBytes: number) {
    super(`file too large (>${Math.round(maxBytes / 1024 / 1024)} MB)`);
    this.name = 'UploadTooLargeError';
  }
}

export type SpooledUpload = { tempPath: string; sha256: string; size: number };

/** Where in-flight uploads land before adoption. */
export function spoolDir(): string {
  return path.join(filesRoot(), '.upload-spool');
}

/**
 * Stream `source` into a spool file, hashing and counting as it goes. Rejects
 * with `UploadTooLargeError` (and removes the partial file) the moment the
 * byte count passes `maxBytes`. Resolves with what `adoptSpooled` needs.
 */
export async function spoolUpload(
  source: Readable,
  opts: { maxBytes: number },
): Promise<SpooledUpload> {
  const dir = spoolDir();
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `${randomUUID()}.part`);
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > opts.maxBytes) {
        cb(new UploadTooLargeError(opts.maxBytes));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  // Open before piping: a WriteStream creates its file lazily, and destroying
  // it mid-open would let the file appear AFTER the unlink below, leaving a
  // stray .part behind. With the fd open first, the error path is honest.
  const out = createWriteStream(tempPath);
  await once(out, 'open');
  try {
    await pipeline(source, meter, out);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
  return { tempPath, sha256: hash.digest('hex'), size };
}

/** Remove a spool file. Safe to call after adoption (ENOENT is fine) and on
 *  every error path: the spool must never keep a stray `.part` around. */
export async function discardSpooled(spooled: SpooledUpload): Promise<void> {
  await fs.unlink(spooled.tempPath).catch(() => {});
}

/**
 * Move a spooled upload into its folder. Same contract as `writeFile`
 * (collision check unless `overwrite`, returns path + sha256 + size) but the
 * bytes never pass through memory. On any failure the spool file is removed.
 */
export async function adoptSpooled(
  parentLtreePath: string,
  filename: string,
  spooled: SpooledUpload,
  opts: { overwrite?: boolean } = {},
): Promise<{ path: string; sha256: string; size: number }> {
  try {
    const filePath = diskPathForFile(parentLtreePath, filename);
    if (!filePath) {
      throw new Error(`adoptSpooled: cannot resolve disk path for ${parentLtreePath}/${filename}`);
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (!opts.overwrite) {
      const exists = await fs
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      if (exists) throw new Error(`adoptSpooled: '${filename}' already exists in this folder`);
    }
    try {
      await fs.rename(spooled.tempPath, filePath);
    } catch (err) {
      // Spool and folder on different mounts (EXDEV): copy, then drop the spool.
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.copyFile(spooled.tempPath, filePath);
      await fs.unlink(spooled.tempPath);
    }
    return { path: filePath, sha256: spooled.sha256, size: spooled.size };
  } catch (err) {
    await discardSpooled(spooled);
    throw err;
  }
}

/** Delete spool files older than `maxAgeMs` (default 2 h): residue from a
 *  process that died mid-upload. Cheap; the route fires it on each upload. */
export async function sweepSpool(maxAgeMs = 2 * 60 * 60 * 1000): Promise<number> {
  const dir = spoolDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.part')) continue;
    const p = path.join(dir, name);
    try {
      const st = await fs.stat(p);
      if (st.mtimeMs < cutoff) {
        await fs.unlink(p);
        removed++;
      }
    } catch {
      /* raced with another sweep or an adoption: fine */
    }
  }
  return removed;
}
