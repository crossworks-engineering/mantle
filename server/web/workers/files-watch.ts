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
import { promises as fs } from 'node:fs';
import chokidar from 'chokidar';
import {
  INGESTABLE_EXTS,
  MEDIA_EXTS,
  PREVIEWABLE_MARKDOWN_EXTS,
  TEXT_EXTS,
  deleteFileByPath,
  ensureRoot,
  extOf,
  filesRoot,
  ltreeForDiskPath,
  syncFileFromDisk,
} from '@mantle/files';
import { waitForOwner } from '@mantle/db';
import { runWorker } from './_runner';

// Resolved at startup via waitForOwner — ALLOWED_USER_ID when set, else the sole
// auth.users row. Left undefined until then so a fresh install boots and idles
// until the first signup instead of exiting.
let USER_ID: string | undefined = process.env.ALLOWED_USER_ID;

/** Extensions the watcher cares about. Keep in sync with the UI's
 *  uploader. Everything else is ignored to avoid noise from editor
 *  temp files, .DS_Store, lock files, etc. */
const WATCHED_EXTS = new Set<string>([
  ...TEXT_EXTS,
  ...PREVIEWABLE_MARKDOWN_EXTS,
  ...INGESTABLE_EXTS, // includes pdf
  // Media syncs as a stored, playable file node. The extractor records an
  // honest unsupported_media skip for it — indexing (transcription) only ever
  // happens through the explicit video_ingest tool, never from this watcher
  // (cost-safety: a synced folder of recordings must not trigger LLM spend).
  ...MEDIA_EXTS,
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'csv',
  'html',
]);

function shouldSync(absPath: string): boolean {
  const base = path.basename(absPath);
  // Editor + OS chaff.
  if (base.startsWith('.')) return false;
  if (base.endsWith('~')) return false;
  if (base.endsWith('.swp') || base.endsWith('.swx')) return false;
  if (base.endsWith('.tmp')) return false;
  if (base.startsWith('#') && base.endsWith('#')) return false; // emacs
  const ext = extOf(base);
  if (!ext) return false;
  return WATCHED_EXTS.has(ext);
}

/** Hard ceiling on what this worker will buffer for one file. The whole file
 *  is read into memory (readFile + sha256), the container runs under a 1 GB
 *  mem_limit, and chokidar fires upserts CONCURRENTLY — before media joined
 *  WATCHED_EXTS the practical max was a 64 MB document, but a synced `.mkv`
 *  can be many GB. Over the cap: log loudly and skip; the file stays on disk,
 *  it just doesn't become a node. (Deliberately larger than MAX_UPLOAD_BYTES:
 *  the operator placed this file on purpose.) */
const WATCH_MAX_BYTES = 512 * 1024 * 1024;

async function handleUpsert(absPath: string): Promise<void> {
  try {
    if (!shouldSync(absPath)) return;
    const loc = ltreeForDiskPath(absPath);
    if (!loc) return;
    const st = await fs.stat(absPath);
    if (st.size > WATCH_MAX_BYTES) {
      console.warn(
        `[files-watch] SKIPPED ${loc.parentPath}/${loc.filename}: ${st.size} bytes exceeds the ${WATCH_MAX_BYTES}-byte sync cap (file left on disk, no node created)`,
      );
      return;
    }
    const bytes = await fs.readFile(absPath);
    const res = await syncFileFromDisk({
      ownerId: USER_ID!,
      parentPath: loc.parentPath,
      filename: loc.filename,
      bytes,
    });
    if (res.status !== 'noop') {
      console.log(`[files-watch] ${res.status} ${loc.parentPath}/${loc.filename}`);
    }
  } catch (err) {
    console.error('[files-watch] upsert failed', absPath, err);
  }
}

async function handleUnlink(absPath: string): Promise<void> {
  try {
    if (!shouldSync(absPath)) return;
    const loc = ltreeForDiskPath(absPath);
    if (!loc) return;
    const res = await deleteFileByPath({
      ownerId: USER_ID!,
      parentPath: loc.parentPath,
      filename: loc.filename,
    });
    if (res.ok) {
      console.log(`[files-watch] deleted ${loc.parentPath}/${loc.filename}`);
    }
  } catch (err) {
    console.error('[files-watch] unlink failed', absPath, err);
  }
}

runWorker('files-watch', async () => {
  USER_ID = await waitForOwner({ label: 'files-watch' });
  const root = filesRoot();
  await ensureRoot(); // mkdir -p
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
    ignored: (p) => {
      const base = path.basename(p);
      return (
        base.startsWith('.') ||
        base.endsWith('~') ||
        base.endsWith('.swp') ||
        base.endsWith('.swx') ||
        base.endsWith('.tmp')
      );
    },
  });

  watcher.on('add', handleUpsert);
  watcher.on('change', handleUpsert);
  watcher.on('unlink', handleUnlink);
  watcher.on('error', (err) => console.error('[files-watch] chokidar error', err));
  watcher.on('ready', () => console.log('[files-watch] ready'));

  return () => watcher.close();
});
