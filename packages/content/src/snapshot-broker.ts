/**
 * The snapshot store's broker (docs/store-brokers.md): the copies under APP_DB_DIR/_snapshots and
 * TABLE_DB_DIR/_snapshots (node_snapshots.db_path) and the accepted
 * tables' workbook copies under TABLE_DB_DIR/accepted-snapshots
 * (accepted_snapshots.table_path).
 *
 *  1. stage: the copy is written under a NEW name (a snapshot's own id, an
 *     accepted copy's revision token), outside any transaction, a file no
 *     row names;
 *  2. flip: one short transaction inserts (or re-points) the row naming it,
 *     with its size: the check (the edit check on node_snapshots, the
 *     admin pool on accepted_snapshots). A flip known not to have landed
 *     removes the stage at once; any other error keeps it (it may have
 *     committed: a row names it, or the sweep reports it);
 *  3. never removed by the writer: a delete, a prune or a purge removes
 *     rows only, and the row's trigger records its file (store_tombstones,
 *     0284); the one store sweep removes it a grace period later, while no
 *     row names it (store-sweep.ts).
 *
 * Server-only (node:fs).
 */
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { afterOuterRollback, removeSqliteFile, stageThenFlip } from '@mantle/db';
import { copyAppDbFile } from './app-sql-runner';

/**
 * A consistent copy of a SQLite file at `dest` (VACUUM INTO in a SQL child,
 * off the event loop), written under a temporary name and renamed into
 * place, so `dest` is either whole or absent. Returns its size. Also the
 * backups' copy of a table workbook.
 */
export async function copySqliteFile(src: string, dest: string): Promise<number> {
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    await copyAppDbFile(src, tmp);
    await rm(dest, { force: true }); // a backup replaces an earlier copy
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return (await stat(dest)).size;
}

/** A staged snapshot file: where it is (absolute), or null (a snapshot of
 *  code only). */
export type StagedSnapshot = { abs: string | null };

/**
 * Stage, then flip, for the snapshot store (the store's one way to call
 * the helper): `stage` writes the copy, `flip` is the one short transaction
 * that writes the row naming it (run its body in inFlipTransaction). A flip
 * known not to have landed removes the copy; one that landed inside an
 * outer transaction (a member's app change, a login's open write
 * transaction) removes it if that one rolls back.
 */
export async function stageThenFlipSnapshot<S extends StagedSnapshot, T>(
  stage: () => S | Promise<S>,
  flip: (staged: S) => Promise<T>,
): Promise<T> {
  let staged: S | null = null;
  const out = await stageThenFlip(
    async () => (staged = await stage()),
    flip,
    (s) => {
      if (s.abs) removeSqliteFile(s.abs);
    },
  );
  const abs = (staged as S | null)?.abs ?? null;
  if (abs) afterOuterRollback(() => removeSqliteFile(abs));
  return out;
}

/** The flip found nothing to record (another caller's snapshot since, a
 *  copy of a file a restore has replaced): its stage goes, nothing landed. */
export class SnapshotNotRecorded extends Error {
  constructor(readonly why: 'not_needed' | 'moved') {
    super(`snapshot not recorded (${why})`);
    this.name = 'SnapshotNotRecorded';
  }
}
