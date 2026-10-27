/**
 * Host filesystem operations for the `files.*` subtree.
 *
 * All write paths funnel through these helpers so the DB ↔ disk pairing
 * stays consistent. None of them touch the DB themselves — callers
 * compose them with `@mantle/db` writes inside a single API handler.
 */

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { diskPathForFile, diskPathForLtree, filesRoot, isFilesPath } from './paths';
import { ConflictError, defineDomainError } from '@mantle/std';
import { extOf, MEDIA_EXTS } from './slug';

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

// ─── Staged creates: write beside, place after the row ──────────────────────
//
// A create writes its bytes under a temporary name in the file's own folder
// (same directory, so the placing rename is atomic) and renames them to the
// final name only once its node insert has won (W8b). The temporary name is
// dot-prefixed and ends in `.tmp`, so the disk-sync watcher and the untracked
// scan ignore it (`isDiskChaff`), and a create that loses the race to another
// one unlinks it: the loser's bytes never land under the winner's row.

/** Bytes staged for a create: where they are now and where they go. */
export type StagedFile = { tempPath: string; finalPath: string; sha256: string; size: number };

/** A unique temporary path beside `filename` in its folder (mkdir -p). */
async function stagingPathFor(
  parentLtreePath: string,
  filename: string,
): Promise<{ tempPath: string; finalPath: string }> {
  const finalPath = diskPathForFile(parentLtreePath, filename);
  if (!finalPath) {
    throw new Error(`stageFile: cannot resolve disk path for ${parentLtreePath}/${filename}`);
  }
  const dir = path.dirname(finalPath);
  await fs.mkdir(dir, { recursive: true });
  return { tempPath: path.join(dir, `.${randomUUID()}.staged.tmp`), finalPath };
}

/** Write `bytes` to a staging file beside `filename`. Never touches the
 *  final name: `placeStaged` does that, `discardStaged` drops it. */
export async function stageFile(
  parentLtreePath: string,
  filename: string,
  bytes: Buffer,
): Promise<StagedFile> {
  const { tempPath, finalPath } = await stagingPathFor(parentLtreePath, filename);
  try {
    await fs.writeFile(tempPath, bytes, { flag: 'wx' });
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { tempPath, finalPath, sha256, size: bytes.byteLength };
}

/** Move a spooled upload to a staging file beside `filename` (a rename, or a
 *  copy across mounts). On any failure the spool file is removed. */
export async function stageSpooled(
  parentLtreePath: string,
  filename: string,
  spooled: SpooledUpload,
): Promise<StagedFile> {
  let tempPath: string | null = null;
  try {
    const at = await stagingPathFor(parentLtreePath, filename);
    tempPath = at.tempPath;
    try {
      await fs.rename(spooled.tempPath, at.tempPath);
    } catch (err) {
      // Spool and folder on different mounts (EXDEV): copy, then drop the spool.
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.copyFile(spooled.tempPath, at.tempPath);
      await fs.unlink(spooled.tempPath);
    }
    return { ...at, sha256: spooled.sha256, size: spooled.size };
  } catch (err) {
    await discardSpooled(spooled);
    if (tempPath) await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

/** Put staged bytes under their final name (an atomic rename that replaces
 *  an orphan disk file of that name, the self-heal). */
export async function placeStaged(staged: StagedFile): Promise<void> {
  await fs.rename(staged.tempPath, staged.finalPath);
}

/**
 * Staged bytes put over a file a row owns: the place step of an overwrite's
 * flip (A3b part 2, store-broker.ts flipThenPlace). `place` keeps the old
 * bytes under a staging name (a hard link: no copy) and renames the stage
 * over the file, atomically; `unplace` puts the old bytes back (or removes
 * the new ones when there were none: a row whose bytes were lost);
 * `release` drops the old bytes once the flip has landed; `discard` drops a
 * stage never placed. A crash in between leaves the old bytes under a
 * staging name, which the staged-leftover sweep removes after an hour.
 */
export function overwritePlacement(staged: StagedFile): {
  place: () => Promise<void>;
  unplace: () => Promise<void>;
  release: () => Promise<void>;
  discard: () => Promise<void>;
} {
  // The old bytes keep their own times (a hard link); the name says when
  // they were kept, which the staged-leftover sweep goes by (fix round 1,
  // L3).
  const keep = path.join(
    path.dirname(staged.finalPath),
    `.${randomUUID()}.kept-${Date.now().toString(36)}.tmp`,
  );
  let kept = false;
  return {
    place: async () => {
      try {
        await fs.link(staged.finalPath, keep);
        kept = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          // A filesystem that refuses hard links: a copy of the old bytes.
          if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'EMLINK') {
            throw err;
          }
          await fs.copyFile(staged.finalPath, keep);
          kept = true;
        }
      }
      await fs.rename(staged.tempPath, staged.finalPath);
    },
    unplace: async () => {
      if (kept) await fs.rename(keep, staged.finalPath);
      else await fs.unlink(staged.finalPath).catch(() => {});
      kept = false;
    },
    release: async () => {
      if (kept) await fs.unlink(keep).catch(() => {});
      kept = false;
    },
    discard: () => discardStaged(staged),
  };
}

/** Drop a staging file. Safe after placement (ENOENT is fine). */
export async function discardStaged(staged: StagedFile): Promise<void> {
  await fs.unlink(staged.tempPath).catch(() => {});
}

/** Whether the final name still holds the bytes `staged` placed there. A
 *  create whose transaction is retried after its bytes were placed asks this
 *  before its insert wins again: in between, another create may have put
 *  its own bytes under the name (fix round 1). False when the file is gone. */
export async function placedBytesIntact(staged: StagedFile): Promise<boolean> {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(staged.finalPath)) hash.update(chunk as Buffer);
    return hash.digest('hex') === staged.sha256;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// ─── Staging files a crash left behind ──────────────────────────────────────
//
// A process that dies between staging a create's bytes and placing or
// discarding them leaves its staging file in the folder. The watcher ignores
// it, so nothing else ever removes it. The nightly `files-staged-reap`
// maintenance sweep (also run by hand) unlinks them after an hour.

/** The name `stagingPathFor` gives a staging file, or `overwritePlacement`
 *  the old bytes it keeps (`.<uuid>.kept-<time>.tmp`, the time it kept them
 *  in base 36), and nothing else. */
export const STAGED_LEFTOVER_NAME = /^\.[0-9a-f-]{36}\.(?:staged|kept-[0-9a-z]{1,12})\.tmp$/;

/** When a staging file was made: the time in a kept file's name (a hard link
 *  keeps the old bytes' write time: A3b part 2 fix round 1, L3), else its
 *  write time. */
function stagedAt(name: string, mtimeMs: number): number {
  const m = /\.kept-([0-9a-z]+)\.tmp$/.exec(name);
  const t = m ? parseInt(m[1]!, 36) : NaN;
  return Number.isFinite(t) ? Math.max(t, mtimeMs) : mtimeMs;
}

/** A staging file this old is residue: a live create places or drops its
 *  staging file within one request. */
export const STAGED_LEFTOVER_MIN_AGE_MS = 60 * 60 * 1000;

/** Folders below the files root the sweep walks into: the folder limit
 *  (FILES_MAX_FOLDER_DEPTH), with room for older, deeper trees. */
const STAGED_SWEEP_MAX_DEPTH = 8;

/**
 * Unlink the staging files a crash left under the files root: only names
 * matching STAGED_LEFTOVER_NAME, only regular files, only when made (the
 * time a kept file's name carries, else the write time) an hour ago or
 * more. Never follows a symlink (a linked folder is not
 * entered, a linked file is not touched), never enters a dot folder (the
 * upload spool, thumbnails) and never enters `exclude` (other stores, such
 * as the app and table databases, should one be mounted inside the files
 * root). When the files root itself is a symlink, or sits inside an
 * excluded store, nothing is walked and `skipped` says why. `dryRun` counts
 * without removing.
 */
export async function sweepStagedLeftovers(
  opts: { exclude?: readonly string[]; now?: number; dryRun?: boolean; root?: string } = {},
): Promise<{ removed: number; skipped: string | null }> {
  const root = path.resolve(opts.root ?? filesRoot());
  const within = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);
  const excluded: string[] = [];
  for (const x of opts.exclude ?? []) {
    if (!x || !x.trim()) continue;
    excluded.push(path.resolve(x));
    const real = await fs.realpath(x).catch(() => null);
    if (real) excluded.push(real);
  }
  try {
    const st = await fs.lstat(root);
    if (!st.isDirectory()) return { removed: 0, skipped: 'the files root is not a directory' };
  } catch {
    return { removed: 0, skipped: 'the files root does not exist' };
  }
  if (excluded.some((x) => within(root, x))) {
    return { removed: 0, skipped: 'the files root sits inside another store' };
  }
  const cutoff = (opts.now ?? Date.now()) - STAGED_LEFTOVER_MIN_AGE_MS;
  let removed = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      // A Dirent is lstat-like: a symlink is neither a directory nor a file.
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || depth >= STAGED_SWEEP_MAX_DEPTH) continue;
        if (excluded.some((x) => within(p, x))) continue;
        await walk(p, depth + 1);
        continue;
      }
      if (!e.isFile() || !STAGED_LEFTOVER_NAME.test(e.name)) continue;
      try {
        const st = await fs.lstat(p);
        if (!st.isFile() || stagedAt(e.name, st.mtimeMs) >= cutoff) continue;
        if (!opts.dryRun) await fs.unlink(p);
        removed++;
      } catch {
        // gone already (placed, discarded or swept by another run)
      }
    }
  };
  await walk(root, 0);
  return { removed, skipped: null };
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
    throw new ConflictError(`renameFile: '${toName}' already exists in this folder`);
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
    throw new ConflictError(`moveFile: '${filename}' already exists in the destination folder`);
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
  // A folder with no directory (a member's folder folded into the brain,
  // W6b: its files' bytes stay in their space's directory) has nothing to
  // move on disk: the destination is made, empty, as a new folder's is.
  if (
    !(await fs.stat(from).then(
      () => true,
      () => false,
    ))
  ) {
    await fs.mkdir(to, { recursive: true });
    return { path: to };
  }
  try {
    await fs.access(to);
    throw new ConflictError(`renameFolder: '${toLtree}' already exists`);
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

/** Editor + OS chaff the files tree never tracks: dotfiles (macOS `._x`
 *  AppleDouble twins, `.DS_Store`), `~` backups, vim/editor temps, emacs
 *  autosaves. The watcher ignores these; folder delete may sweep them. */
export function isDiskChaff(basename: string): boolean {
  return (
    basename.startsWith('.') ||
    basename.endsWith('~') ||
    basename.endsWith('.swp') ||
    basename.endsWith('.swx') ||
    basename.endsWith('.tmp') ||
    (basename.startsWith('#') && basename.endsWith('#'))
  );
}

/** Real (non-chaff) files on disk under a folder, as paths relative to it,
 *  up to `limit`. A folder that is empty in the DB can still hold these: a
 *  file dropped in that the watcher refused (e.g. a slug clash), or one of a
 *  type it does not watch. They are user data the brain has no row for. */
export async function untrackedFilesOnDisk(ltreePath: string, limit = 5): Promise<string[]> {
  const dir = isFilesPath(ltreePath) ? diskPathForLtree(ltreePath) : null;
  if (!dir) return [];
  const found: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      if (found.length >= limit) return;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (!isDiskChaff(e.name)) found.push(path.relative(dir, abs));
    }
  };
  await walk(dir);
  return found;
}

/** Files directly in a folder's directory (not its subfolders) that the
 *  brain does not track: names (lower-cased) outside `tracked`, OS chaff
 *  aside. Read only. A folder delete that lifts its contents asks this first,
 *  so it refuses before moving anything rather than after (the final delete
 *  refuses a folder still holding untracked files). */
export async function strayFilesIn(
  ltreePath: string,
  tracked: ReadonlySet<string>,
  limit = 5,
  /** With it, a subdirectory outside this set (lower-cased names) that holds
   *  a real file is stray too, reported as `name/`: a folder delete removes
   *  the directory it sits in. */
  trackedDirs?: ReadonlySet<string>,
): Promise<string[]> {
  const dir = isFilesPath(ltreePath) ? diskPathForLtree(ltreePath) : null;
  if (!dir) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const found: string[] = [];
  for (const e of entries) {
    if (found.length >= limit) break;
    if (e.isDirectory()) {
      if (!trackedDirs || trackedDirs.has(e.name.toLowerCase())) continue;
      if ((await realFilesUnder(path.join(dir, e.name), 1)).length) found.push(`${e.name}/`);
      continue;
    }
    if (isDiskChaff(e.name)) continue;
    if (!tracked.has(e.name.toLowerCase())) found.push(e.name);
  }
  return found;
}

/** Real (non-chaff) files anywhere under a directory, up to `limit`. */
async function realFilesUnder(dir: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      if (found.length >= limit) return;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (!isDiskChaff(e.name)) found.push(abs);
    }
  };
  await walk(dir);
  return found;
}

/** Every name in a folder's directory (files and directories, chaff aside),
 *  lower-cased; empty when it does not exist. Read only: what a file moving
 *  in must not be named. */
export async function diskNamesIn(ltreePath: string): Promise<Set<string>> {
  const dir = isFilesPath(ltreePath) ? diskPathForLtree(ltreePath) : null;
  if (!dir) return new Set();
  try {
    const names = await fs.readdir(dir);
    return new Set(names.filter((n) => !isDiskChaff(n)).map((n) => n.toLowerCase()));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
}

/** What a file's bytes ARE on disk now (its inode, its change time, its
 *  size), or null when there are none: a delete's commit hook unlinks only
 *  these bytes (A3b part 2 fix round 2, N2). */
export type FileIdentity = { dev: number; ino: number; ctimeMs: number; size: number };

export async function fileIdentity(
  parentLtreePath: string,
  filename: string,
): Promise<FileIdentity | null> {
  const p = diskPathForFile(parentLtreePath, filename);
  if (!p) return null;
  try {
    const st = await fs.stat(p);
    return { dev: st.dev, ino: st.ino, ctimeMs: st.ctimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** Unlink a file only while its name still holds the bytes `was` saw: a
 *  file made under the name since (a create in the same outer transaction
 *  as the delete) is a new inode and stays (fix round 2, N2). */
export async function deleteFileIfSame(
  parentLtreePath: string,
  filename: string,
  was: FileIdentity,
): Promise<void> {
  const now = await fileIdentity(parentLtreePath, filename);
  if (
    !now ||
    now.dev !== was.dev ||
    now.ino !== was.ino ||
    now.ctimeMs !== was.ctimeMs ||
    now.size !== was.size
  ) {
    return;
  }
  await deleteFile(parentLtreePath, filename);
}

/**
 * A deleted folder's directory moved aside now (`.<uuid>.kept-<time>.tmp`
 * beside it), so a folder made again under its name in the same outer
 * transaction gets a directory of its own (fix round 2, N2): `remove` once
 * the delete commits, `restore` if it rolls back (only while nothing has
 * taken the name). Null when there is no directory.
 */
export async function setFolderAside(
  ltreePath: string,
): Promise<{ remove: () => Promise<void>; restore: () => Promise<void> } | null> {
  if (!isFilesPath(ltreePath)) return null;
  const dir = diskPathForLtree(ltreePath);
  if (!dir) return null;
  if (dir === filesRoot()) throw new Error('setFolderAside: refusing to move the files root');
  const aside = path.join(
    path.dirname(dir),
    `.${randomUUID()}.kept-${Date.now().toString(36)}.tmp`,
  );
  try {
    await fs.rename(dir, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return {
    remove: () => fs.rm(aside, { recursive: true, force: true }),
    restore: async () => {
      const taken = await fs.stat(dir).then(
        () => true,
        () => false,
      );
      if (!taken) await fs.rename(aside, dir);
    },
  };
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

// The one error answer (A10 part 2, @mantle/std domain-errors.ts): what the
// upload route answered by hand. A rejected recording gets the path that
// works: a file under the cap (the audio track alone is far smaller), then
// video_ingest with its file id. video_ingest takes uploaded files only.
defineDomainError(UploadTooLargeError, {
  reason: 'the upload is over its cap; the message says the cap',
  status: 413,
  body: (e) => {
    const mediaHint =
      e.filename && MEDIA_EXTS.has(extOf(e.filename))
        ? ' For a recording, upload a file under the cap (the audio track alone is much smaller), then ask the assistant to transcribe it (video_ingest with its file id).'
        : '';
    return { error: `${e.message}.${mediaHint}`, maxUploadBytes: e.maxBytes };
  },
});

export type SpooledUpload = { tempPath: string; sha256: string; size: number };

/** Where in-flight uploads land before adoption. */
export function spoolDir(): string {
  return path.join(filesRoot(), '.upload-spool');
}

/**
 * Stream `source` into a spool file, hashing and counting as it goes. Rejects
 * with `UploadTooLargeError` (and removes the partial file) the moment the
 * byte count passes `maxBytes`. Resolves with what `stageSpooled` needs.
 */
export async function spoolUpload(
  source: Readable,
  opts: {
    maxBytes: number;
    /** Default `spoolDir()`; member uploads spool
     *  inside the spaces root (space-disk.ts) so adoption stays a rename. */ dir?: string;
  },
): Promise<SpooledUpload> {
  // Nothing listens on `source` until `pipeline` below, and the awaits before
  // it leave a window: a client drop there destroys the stream with an error
  // nobody hears, which Node raises as an uncaught exception. Hold a listener
  // across the window; `pipeline` still sees the error (the stream is
  // destroyed) and the cleanup below runs as usual.
  const holdError = () => {};
  source.on('error', holdError);
  const dir = opts.dir ?? spoolDir();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    source.off('error', holdError);
    throw err;
  }
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
  try {
    await once(out, 'open');
    const done = pipeline(source, meter, out);
    source.off('error', holdError);
    await done;
  } catch (err) {
    source.off('error', holdError);
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

/** Delete spool files older than `maxAgeMs` (default 2 h): residue from a
 *  process that died mid-upload. Cheap; the route fires it on each upload. */
export async function sweepSpool(maxAgeMs = 2 * 60 * 60 * 1000, dir = spoolDir()): Promise<number> {
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
