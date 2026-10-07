/**
 * File helpers for the history trees (APP_DB_DIR/_snapshots and
 * TABLE_DB_DIR/_snapshots; app-snapshots.ts, table-snapshots.ts). Async all
 * through: none of them holds the event loop of the process that serves the
 * app (apps audit 2026-10-02, items 5 and 14).
 *
 * Server-only (node:fs).
 */
import { copyFile, link, mkdir, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { copyAppDbFile } from './app-sql-runner';

/** A file a writer is still making (a snapshot copy before its rename, a
 *  restore's temp file): never part of the history. */
function isPartial(name: string): boolean {
  return name.includes('.tmp-') || name.includes('.restore-');
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Hard-link `src` to `dest`, or copy it when the two are on different
 *  filesystems (or links are refused). */
export async function linkOrCopy(src: string, dest: string): Promise<'linked' | 'copied'> {
  try {
    await link(src, dest);
    return 'linked';
  } catch (err) {
    const code = errCode(err);
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EMLINK' && code !== 'ENOTSUP') {
      throw err;
    }
    await copyFile(src, dest);
    return 'copied';
  }
}

/**
 * Mirror a history tree into a backup by HARD LINKS. Every file in it is
 * written once and never again (a snapshot, a replaced workbook), so a link
 * is as good as a copy and costs no disk and no time; a full copy of both
 * trees on every backup run doubled their disk and blocked the web process
 * (cpSync). Across filesystems it falls back to an async copy. A file
 * pruned while the walk runs is skipped. Returns the counts.
 */
export async function linkHistoryTree(
  src: string,
  dest: string,
): Promise<{ files: number; copied: number }> {
  const counts = { files: 0, copied: 0 };
  const walk = async (from: string, to: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(from, { withFileTypes: true });
    } catch (err) {
      if (errCode(err) === 'ENOENT') return; // pruned meanwhile
      throw err;
    }
    await mkdir(to, { recursive: true });
    for (const e of entries) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) {
        await walk(a, b);
      } else if (e.isFile() && !isPartial(e.name)) {
        await rm(b, { force: true });
        try {
          if ((await linkOrCopy(a, b)) === 'copied') counts.copied++;
          counts.files++;
        } catch (err) {
          if (errCode(err) !== 'ENOENT') throw err; // pruned meanwhile
        }
      }
    }
  };
  await walk(src, dest);
  return counts;
}

/**
 * A consistent copy of a SQLite file (a table workbook) at `dest`: VACUUM
 * INTO in a SQL child (copyAppDbFile), off the event loop. Replaces `dest`.
 */
export async function copySqliteFile(src: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  await rm(dest, { force: true }); // VACUUM INTO refuses an existing target
  await copyAppDbFile(src, dest);
}

/** A work file a crash can leave behind: a schema trial copy, a restore's
 *  or a snapshot's temp file, a package work file, a restore marker. The
 *  live files (<id>.sqlite, its -wal/-shm/-journal, a draft) never match. */
function isLeftover(name: string): boolean {
  return (
    name.startsWith('.schema-check-') ||
    name.includes('.restore-') ||
    name.includes('.tmp-') ||
    name.endsWith('.restoring')
  );
}

/** Leftovers younger than this may still be in use. */
const LEFTOVER_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Remove the work files crashes left under these roots (APP_DB_DIR,
 * TABLE_DB_DIR) more than an hour ago, and anything in APP_DB_DIR/_tmp
 * that old (apps audit 2026-10-02, low: nothing swept them). Part of the
 * nightly `app-trash-purge`; plain file removal. Returns the count (a dry
 * run removes nothing).
 */
export async function sweepCrashLeftovers(
  roots: string[],
  opts: { now?: number; dryRun?: boolean } = {},
): Promise<number> {
  const cutoff = (opts.now ?? Date.now()) - LEFTOVER_MIN_AGE_MS;
  let n = 0;
  const walk = async (dir: string, depth: number, all: boolean): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) await walk(p, depth + 1, all || (depth === 0 && e.name === '_tmp'));
        continue;
      }
      if (!e.isFile() || !(all || isLeftover(e.name))) continue;
      try {
        if ((await stat(p)).mtimeMs >= cutoff) continue;
        n++;
        if (!opts.dryRun) await rm(p, { force: true });
      } catch {
        // gone already
      }
    }
  };
  for (const root of roots) await walk(root, 0, false);
  return n;
}
