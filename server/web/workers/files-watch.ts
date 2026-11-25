/**
 * Files watcher. Mirrors disk changes under MANTLE_FILES_ROOT back into
 * the DB so external editors (vim, VS Code outside Mantle, Syncthing,
 * `cp` on the host) stay in lockstep with the `nodes` rows.
 *
 * Why a separate process:
 *   - Next dev server reloads on file edits; chokidar inside it would
 *     get torn down constantly.
 *   - Single-flight per-path debounce is easier to reason about with
 *     a long-lived process.
 *
 * Loop prevention:
 *   - The watcher calls `syncFileFromDisk` (NOT `upsertFile`). That op
 *     skips the disk write entirely. So when the UI uploads a file, the
 *     UI updates the DB row first (with the new sha256), then chokidar
 *     reports the change, we recompute the same sha256, see it matches
 *     the DB row, and no-op. No echo.
 *
 * What we DON'T do:
 *   - Folder add/remove: branches are created lazily by syncFileFromDisk
 *     when a file lands in them, and stale empty branches are harmless.
 *   - Symlinks: chokidar follows them by default; we leave the default
 *     since editor temp files (.swp) and dotfiles are already ignored.
 *   - Watch outside the files root: chokidar is scoped to MANTLE_FILES_ROOT.
 */
import path from 'node:path';
import { createReadStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import chokidar from 'chokidar';
import {
  deleteFileByPath,
  ensureRoot,
  filesRoot,
  maxStreamedUploadBytes,
  isDiskChaff,
  ltreeForDiskPath,
  reconcileAutoFiled,
  syncFileFromDisk,
} from '@mantle/files';
import { waitForOwner } from '@mantle/db';
import { runWorker } from './_runner';
import { describeError } from './describe-error';
import { env } from '@mantle/config';
import { sleep } from '@mantle/std';

// Resolved at startup via waitForOwner — ALLOWED_USER_ID when set, else the sole
// auth.users row. Left undefined until then so a fresh install boots and idles
// until the first signup instead of exiting.
let USER_ID: string | undefined = env('ALLOWED_USER_ID');

/** Every file the operator put here becomes a node, whatever its type (a
 *  TIFF, an SMF, a `.000` plot, a zip, a HEIC, a file with no extension):
 *  the brain holds what was placed, and the extractor says per file what it
 *  could read (an honest skip for a type no reader takes, `unsupported_media`
 *  for audio and video, which only the explicit video_ingest transcribes).
 *  Only editor and OS chaff (isDiskChaff: dotfiles, `~` backups, swap and
 *  temp files) is ignored. */
function shouldSync(absPath: string): boolean {
  return !isDiskChaff(path.basename(absPath));
}

/** The most this worker reads into memory for one file (chokidar fires
 *  upserts CONCURRENTLY, under a 1 GB mem_limit). A larger file is hashed as
 *  a stream and becomes a node all the same, at any size; past the box's
 *  read cap (MANTLE_MAX_UPLOAD_MB) its extract records the terminal
 *  `file_too_large`, so its status says its content is not in search. */
const WATCH_BUFFER_BYTES = 64 * 1024 * 1024;

/** A file's sha256 and size, read as a stream (flat memory at any size). */
async function digestOf(absPath: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(absPath)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}

async function handleUpsert(absPath: string): Promise<void> {
  try {
    if (!shouldSync(absPath)) return;
    const loc = ltreeForDiskPath(absPath);
    if (!loc) return;
    const st = await fs.stat(absPath);
    const bytes =
      st.size > WATCH_BUFFER_BYTES ? await digestOf(absPath) : await fs.readFile(absPath);
    if (st.size > maxStreamedUploadBytes()) {
      console.warn(
        `[files-watch] ${loc.parentPath}/${loc.filename}: ${st.size} bytes, past the ${maxStreamedUploadBytes()}-byte read cap: a node by name, its content not read (file_too_large)`,
      );
    }
    const res = await syncFileFromDisk({
      ownerId: USER_ID!,
      parentPath: loc.parentPath,
      filename: loc.filename,
      bytes,
      // Moved or renamed away while this read (a folder move, then a
      // rename): no row at the old path.
      diskPath: absPath,
    });
    // 'skipped' was logged by syncFileFromDisk itself.
    if (res.status === 'inserted' || res.status === 'updated') {
      console.log(`[files-watch] ${res.status} ${loc.parentPath}/${loc.filename}`);
    }
  } catch (err) {
    // One line, not the error object: a wrapped query error carries the whole
    // INSERT and the file's text. The file stays on disk with no node (folder
    // delete refuses while it is there: untrackedFilesOnDisk).
    console.error(`[files-watch] upsert failed ${absPath}: ${describeError(err)}`);
  }
}

/** How long an unlink waits before it is believed: a rename, move or overwrite whose commit failed puts the file back
 *  within milliseconds (store-broker.ts flipThenPlace); deleting its row in
 *  between and making it again on the add would lose its id, grants, tags
 *  and passages (a folder move: the whole subtree's). */
const UNLINK_SETTLE_MS = 2_000;

async function handleUnlink(absPath: string): Promise<void> {
  try {
    if (!shouldSync(absPath)) return;
    const loc = ltreeForDiskPath(absPath);
    if (!loc) return;
    await sleep(UNLINK_SETTLE_MS);
    // Back already (a move undone, a quick replace): nothing was deleted.
    if (
      await fs.stat(absPath).then(
        () => true,
        () => false,
      )
    )
      return;
    const res = await deleteFileByPath({
      ownerId: USER_ID!,
      parentPath: loc.parentPath,
      filename: loc.filename,
    });
    if (res.ok) {
      console.log(`[files-watch] deleted ${loc.parentPath}/${loc.filename}`);
    }
  } catch (err) {
    console.error(`[files-watch] unlink failed ${absPath}: ${describeError(err)}`);
  }
}

runWorker('files-watch', async () => {
  USER_ID = await waitForOwner({ label: 'files-watch' });
  const root = filesRoot();
  await ensureRoot(); // mkdir -p
  // Bring an older brain's machine folders into Auto-filed before watching,
  // so the watcher never sees these moves as deletes and adds. Idempotent;
  // a failure is logged and the watcher starts anyway.
  try {
    const moved = await reconcileAutoFiled(USER_ID);
    if (moved.moved.length || moved.mergedDays) {
      console.log(
        `[files-watch] auto-filed: moved ${moved.moved.join(', ') || 'nothing'}; merged ${moved.mergedDays} day folder(s) into months`,
      );
    }
  } catch (err) {
    console.error(`[files-watch] auto-filed reconcile failed: ${describeError(err)}`);
  }
  console.log(`[files-watch] watching ${root}`);

  const watcher = chokidar.watch(root, {
    ignoreInitial: true, // skip the "found 200 files on boot" storm
    persistent: true,
    awaitWriteFinish: {
      // Wait until the file is quiet for 400ms before firing. Editors
      // (vim, Code) write in multiple chunks; without this we'd fire
      // mid-save and read half a file.
      stabilityThreshold: 400,
      pollInterval: 100,
    },
    ignored: (p) => isDiskChaff(path.basename(p)),
  });

  watcher.on('add', handleUpsert);
  watcher.on('change', handleUpsert);
  watcher.on('unlink', handleUnlink);
  watcher.on('error', (err) => console.error('[files-watch] chokidar error', err));
  watcher.on('ready', () => console.log('[files-watch] ready'));

  return () => watcher.close();
});
