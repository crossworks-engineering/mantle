/**
 * The store brokers' one helper (docs/store-brokers.md). Six stores keep
 * data on disk, where no trigger sees it. Each has ONE broker module, the
 * only writer of its disk, and every whole-file write goes the same way:
 *
 *  1. stage: the bytes go to a NEW revision name (`revisionToken`), a file
 *     no row points at, so no reader sees it;
 *  2. flip: ONE short transaction runs the Postgres statement the database
 *     checks, as the caller's actor (on the write role for a login's write:
 *     the row rules and the edit check see it), and points the row at the
 *     new revision. It must match exactly one row (`oneRow`); none is a
 *     refusal, `StoreRefusedError`, the edit check's own 42501 `no_read`
 *     (a 404 through every existing mapper);
 *  3. a stage the flip is known not to have taken is removed at once
 *     (`stageThenFlip`: a refusal, a conflict, a throw in the transaction);
 *     after any other error (it may have committed) it is kept. One that
 *     outlives a crash or such an error, and every revision a row no longer
 *     points at, is the one sweep's (`sweepOrphans`, run by the maintenance
 *     worker), which removes only an old revision of an item whose row
 *     names another file.
 *
 * The stores' file names, which columns name them, and the one remover of a
 * SQLite file with its sidecars live here too (`revisionNode`,
 * `STORE_FILE_COLUMNS`, `removeSqliteFile`): the brokers, the backups and
 * the sweep read them from one place.
 *
 * No transaction is held across a disk write. Readers resolve a store's
 * file through its row, in one place per store. The exceptions (an app's
 * SQL statement, a table's op batch: a write in place, where a copy per
 * write would cost a whole file) are the brokers', documented there.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** The six stores. */
export const STORE_NAMES = ['tables', 'appdb', 'files', 'snapshots', 'appbuild', 'docs'] as const;
export type StoreName = (typeof STORE_NAMES)[number];

/** The message every database mapper reads as a write refusal
 *  (isScopeWriteRefusal, `not allowed to change this item`). */
export const STORE_REFUSED_MESSAGE = 'not allowed to change this item';

/**
 * A broker's checked statement matched no row (or more than one): the caller
 * does not read the row, or it is gone. Shaped as the edit check's own
 * refusal (SQLSTATE 42501, detail `no_read`), so the one HTTP mapper
 * (scope-refusal.ts) answers 404 and the tools say "not found"
 * (databaseErrorPublic), with no new branch anywhere.
 */
export class StoreRefusedError extends Error {
  readonly code = '42501';
  readonly detail = 'no_read';
  constructor(
    readonly store: StoreName,
    readonly what: string,
    readonly rows: number,
  ) {
    super(`${STORE_REFUSED_MESSAGE} (${store}: ${rows} ${what} rows, one expected)`);
    this.name = 'StoreRefusedError';
  }
}

/** The checked statement's rows: exactly one, else a refusal. */
export function oneRow<T>(store: StoreName, rows: readonly T[], what: string): T {
  if (rows.length !== 1) throw new StoreRefusedError(store, what, rows.length);
  return rows[0] as T;
}

/** A new revision's name part: sortable by time, unique. */
export function revisionToken(): string {
  return `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

/** Errors a flip threw before its transaction committed. */
const neverLanded = new WeakSet<object>();

/** Mark `err` as thrown before the flip's transaction committed (inside its
 *  body: the transaction rolled back), so its stage may go at once. */
export function flipRolledBack<E>(err: E): E {
  if (typeof err === 'object' && err !== null) neverLanded.add(err);
  return err;
}

/** Whether `err` is known to have stopped a flip before its commit: a
 *  refusal, or anything its transaction's body threw (`inFlipTransaction`).
 *  Anything else (a lost COMMIT acknowledgement, a dropped connection after
 *  the commit, a throw after the transaction) may have landed. */
export function flipNeverLanded(err: unknown): boolean {
  if (err instanceof StoreRefusedError) return true;
  return typeof err === 'object' && err !== null && neverLanded.has(err);
}

/** A flip transaction's body: whatever it throws rolled the transaction
 *  back (flipRolledBack). Wrap the callback of the flip's transaction. */
export async function inFlipTransaction<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw flipRolledBack(err);
  }
}

/**
 * Stage, then flip: `stage` writes the new revision (no row points at it),
 * `flip` is the one short transaction that checks the row and points it at
 * the stage. Its body runs in `inFlipTransaction`, and nothing runs after
 * its commit (the caller does that after this returns).
 *
 * A flip that throws removes its stage at once ONLY when the error is known
 * to be before the commit (`flipNeverLanded`: a refusal, a conflict, a
 * throw in the transaction's body). Any other error may have committed (a
 * lost COMMIT acknowledgement): the stage is kept, whether a row names it
 * or not. A row never points at a removed stage; one no row names is an
 * unreferenced revision for the sweep. Returns the
 * flip's result.
 */
export async function stageThenFlip<S, T>(
  stage: () => S | Promise<S>,
  flip: (staged: S) => Promise<T>,
  discard: (staged: S) => void,
): Promise<T> {
  const staged = await stage();
  try {
    return await flip(staged);
  } catch (err) {
    if (flipNeverLanded(err)) {
      try {
        discard(staged);
      } catch {
        /* the sweep removes it */
      }
    } else {
      console.error(
        '[store-broker] a flip failed after it may have committed; its stage is kept (a row names it, or the sweep removes it):',
        err instanceof Error ? err.message : err,
      );
    }
    throw err;
  }
}

// ── A store whose disk path IS its row ──────────────────────────────────

/**
 * Flip, then place: the store write for the files tree, where there is no
 * pointer to flip. A file lives at its folder's path and its name,
 * which the host sees and the files watcher mirrors, so new bytes cannot
 * wait under another name for a row to point at them: the disk follows the
 * row INSIDE the flip. `flip` runs the one short transaction: the checked
 * statement first (exactly one row, `oneRow`; none is a refusal), then
 * `place` as its LAST step, a rename (atomic, no bytes copied: staged bytes
 * onto their name, a file or a folder to its new path), then the commit.
 * No transaction is held across a write of bytes: those were staged before
 * the flip (`discard` removes the stage).
 *
 *  - A refusal, or anything thrown in the transaction (`flipNeverLanded`):
 *    the disk is put back (`unplace`, if `place` ran) and the stage goes.
 *  - Any other error (a failed or lost COMMIT): `settle` asks the database
 *    whether the row landed. No: put back as above. Yes: the disk is right
 *    (`release`). Unknown (the row cannot be read): left as it is, logged.
 *  - Landed: `release` (what `unplace` would have needed goes), and, inside
 *    an outer transaction (a login's open write transaction, a personal
 *    space), `unplace` again should that one roll back (afterOuterRollback).
 *
 * `place` runs at most once, even when the transaction is retried (a
 * deadlock): a retry finds the disk already placed.
 */
export async function flipThenPlace<T>(steps: {
  /** The flip's transaction; calls the `place` it is given as its last step. */
  flip: (place: () => Promise<void>) => Promise<T>;
  place: () => Promise<void>;
  /** Put the disk back as it was before `place`. */
  unplace?: () => Promise<void>;
  /** Remove a stage `place` did not take (ENOENT is fine). */
  discard?: () => Promise<void>;
  /** After a flip that landed: drop what `unplace` would have needed. */
  release?: () => Promise<void>;
  /** After an error that may have committed: did the row land? */
  settle: () => Promise<boolean>;
}): Promise<T> {
  let placed = false;
  const placeOnce = async () => {
    if (placed) return;
    await steps.place();
    placed = true;
  };
  const quietly = async (fn: (() => Promise<void>) | undefined, what: string) => {
    if (!fn) return;
    try {
      await fn();
    } catch (err) {
      console.error(
        `[store-broker] files: could not ${what}:`,
        err instanceof Error ? err.message : err,
      );
    }
  };
  let out: T;
  try {
    out = await steps.flip(placeOnce);
  } catch (err) {
    let landed: boolean | null = false;
    if (!flipNeverLanded(err)) {
      try {
        landed = await steps.settle();
      } catch {
        landed = null;
      }
    }
    if (landed === false) {
      if (placed) await quietly(steps.unplace, 'put the disk back after a flip that never landed');
      await quietly(steps.discard, 'remove a stage');
    } else if (landed === true) {
      await quietly(steps.release, 'release after a flip that landed');
      await quietly(steps.discard, 'remove a stage');
    } else {
      console.error(
        '[store-broker] files: a flip failed after it may have committed and its row cannot be read; the disk is left as it is:',
        err instanceof Error ? err.message : err,
      );
    }
    throw err;
  }
  await quietly(steps.discard, 'remove a stage');
  // Inside an outer transaction the flip was a savepoint: the disk goes back
  // if that one rolls back, and what `unplace` needs stays until it commits.
  const { afterOuterCommit, afterOuterRollback } = await import('./client');
  if (placed && steps.unplace) {
    const back = steps.unplace;
    afterOuterRollback(() => quietly(back, 'put the disk back after an outer rollback'));
  }
  await afterOuterCommit(() => quietly(steps.release, 'release after a flip that landed'));
  return out;
}

// ── The stores' files ───────────────────────────────────────────────────

/** The stores whose files the brokers write under revision names. */
export type RevisionStore = 'tables' | 'appdb';

/** The SQLite files that belong to a database file. */
export const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'] as const;

/** Remove a SQLite file and every sidecar it may have (best effort: a file
 *  that is gone is fine). THE remover for a store's database files. */
export function removeSqliteFile(abs: string): void {
  rmSync(abs, { force: true });
  for (const s of SQLITE_SIDECARS) rmSync(`${abs}${s}`, { force: true });
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A revision's file name: `<node>[.r-<token>][.draft].sqlite` (a draft for
 *  a table only). */
const REVISION_NAME = new RegExp(`^(${UUID})(\\.r-[0-9a-z]+)?(\\.draft)?\\.sqlite$`);

/** The node a store file NAME is a revision of, or null: not one of the
 *  store's revisions (a sidecar, a marker, a trial copy, anything else). */
export function revisionNode(name: string, store: RevisionStore): string | null {
  const m = REVISION_NAME.exec(name);
  if (!m) return null;
  if (m[3] !== undefined && store !== 'tables') return null;
  return m[1] ?? null;
}

/** A legacy table draft (`<node>.draft.sqlite`, no revision token): the
 *  sweep never removes one, it reports it. */
export function isLegacyDraftName(name: string): boolean {
  const m = REVISION_NAME.exec(name);
  return m !== null && m[2] === undefined && m[3] !== undefined;
}

/** Every revision of `node` in the folder `dirAbs` (absolute paths, no
 *  sidecars): what a backup keeps and a table delete removes. */
export function revisionFiles(dirAbs: string, node: string, store: RevisionStore): string[] {
  let names: string[];
  try {
    names = readdirSync(dirAbs);
  } catch {
    return [];
  }
  return names.filter((n) => revisionNode(n, store) === node).map((n) => join(dirAbs, n));
}

/** Which columns of which registry name a store's files: the one spec the
 *  sweep and the backups read, through `storeRows`. The first is the item's current file (a table's published workbook,
 *  an app's database). A table's are relative to TABLE_DB_DIR, an app
 *  database's absolute. The snapshot store: a snapshot's
 *  database copy (an app's relative to APP_DB_DIR, a table's to
 *  TABLE_DB_DIR; the item is the snapshot row) and an accepted table's
 *  workbook copy (relative to TABLE_DB_DIR; the item is the table). */
export const STORE_FILE_COLUMNS = {
  tables: { table: 'tables', node: 'node_id', files: ['storage_path', 'draft_path'] },
  appdb: { table: 'app_databases', node: 'app_node_id', files: ['storage_path'] },
  appsnap: {
    table: 'node_snapshots',
    node: 'id',
    files: ['db_path'],
    where: "node_kind <> 'table'",
  },
  tablesnap: {
    table: 'node_snapshots',
    node: 'id',
    files: ['db_path'],
    where: "node_kind = 'table'",
  },
  accepted: { table: 'accepted_snapshots', node: 'node_id', files: ['table_path'] },
} as const satisfies Record<
  string,
  { table: string; node: string; files: readonly string[]; where?: string }
>;

/** A store the sweep and the backups read rows of (STORE_FILE_COLUMNS). */
export type SweptStore = keyof typeof STORE_FILE_COLUMNS;

/** Every row of a store with the files it names now (STORE_FILE_COLUMNS),
 *  read on the caller's handle: `columns` in the spec's order (null where
 *  none), `files` the ones that are set. */
export async function storeRows(store: SweptStore): Promise<SweepRow[]> {
  const [{ db }, { sql }] = await Promise.all([import('./client'), import('drizzle-orm')]);
  const spec: { table: string; node: string; files: readonly string[]; where?: string } =
    STORE_FILE_COLUMNS[store];
  // One column per file (never a SQL array: a null element would come back
  // as the text NULL).
  const cols = spec.files.map((c, i) => `"${c}" as f${i}`).join(', ');
  const rows = (await db.execute(
    sql.raw(
      `select "${spec.node}"::text as node, ${cols} from "${spec.table}"${spec.where ? ` where ${spec.where}` : ''}`,
    ),
  )) as unknown as Record<string, string | null>[];
  return rows.map((r) => {
    const columns = spec.files.map((_, i) => {
      const f = r[`f${i}`];
      return typeof f === 'string' && f.length > 0 ? f : null;
    });
    return {
      node: String(r.node),
      columns,
      files: columns.filter((f): f is string => f !== null),
    };
  });
}

/** The tombstones of a snapshot store (migration 0284: a file a deleted or
 *  re-pointed row named), as stored (relative to the store's base), with
 *  how long ago its row went (ms), on the database's clock (no skew with
 *  this process's). Read on the caller's handle (the
 *  system pool). */
export async function storeTombstones(
  store: 'appsnap' | 'tablesnap' | 'accepted',
): Promise<{ path: string; ageMs: number }[]> {
  const [{ db }, { sql }] = await Promise.all([import('./client'), import('drizzle-orm')]);
  const rows = (await db.execute(
    sql`select path, (extract(epoch from (now() - created_at)) * 1000)::float8 as age
          from store_tombstones where store = ${store}`,
  )) as unknown as { path: string; age: number }[];
  return rows.map((r) => ({ path: String(r.path), ageMs: Number(r.age) }));
}

/** Clear the tombstones of files the sweep removed (or found gone). */
export async function forgetTombstones(
  store: 'appsnap' | 'tablesnap' | 'accepted',
  paths: readonly string[],
): Promise<void> {
  if (!paths.length) return;
  const [{ db }, { sql }, { storeTombstones: tombstones }] = await Promise.all([
    import('./client'),
    import('drizzle-orm'),
    import('./schema/store-tombstones'),
  ]);
  await db.delete(tombstones).where(
    sql`${tombstones.store} = ${store}
          and ${tombstones.path} in (${sql.join(
            paths.map((p) => sql`${p}`),
            sql`, `,
          )})`,
  );
}

/** When a revision was made, from its name's token (`revisionToken`: the
 *  time in base 36, then 8 hex characters); 0 for a name with no token (a
 *  legacy file, the oldest). */
export function revisionTime(name: string): number {
  const m = /\.r-([0-9a-z]+)(?:\.draft)?\.sqlite$/.exec(name);
  if (!m || m[1]!.length <= 8) return 0;
  const t = parseInt(m[1]!.slice(0, -8), 36);
  return Number.isFinite(t) ? t : 0;
}

// ── The sweep ───────────────────────────────────────────────────────────

/** How long a file no row points at stays before the sweep removes it: a
 *  stage in flight is younger, and a revision just un-referenced has had
 *  its readers finish (a reader that resolved it before the flip). */
export const STORE_SWEEP_GRACE_MS = 60 * 60 * 1000;

/** How long a tombstoned file stays after its row went: longer than any backup runs, so a backup whose Postgres
 *  dump still names the row finds the file when it links the history. */
export const STORE_TOMBSTONE_GRACE_MS = 24 * 60 * 60 * 1000;

/** A row of a store, as the sweep reads it: its node and the files it
 *  names (relative to the store's root, or absolute); `columns`, when
 *  given, the files by STORE_FILE_COLUMNS column, the first the item's
 *  current file. */
export type SweepRow = {
  node: string;
  files: readonly string[];
  columns?: readonly (string | null)[];
};

export type SweepSpec = {
  store: StoreName;
  /** The part of the store, when it has several (the snapshot store: app
   *  snapshots, table snapshots, accepted copies): the report's name. */
  label?: string;
  /** The store's root folder. */
  root: string;
  /** Where a restore puts its hold for this root, when it is a folder
   *  inside another store's root (a snapshot folder): that root. */
  holdRoot?: string;
  /** Files a deleted or re-pointed row named (migration 0284), absolute,
   *  with how long ago the row went (ms, the database's clock): such a file
   *  goes STORE_TOMBSTONE_GRACE_MS later, while no row names it, though its
   *  item has no row. */
  tombstones?: () => Promise<readonly { abs: string; ageMs: number }[]>;
  /** False: a store holding files that no row and no tombstone names is
   *  reported, never a hard stop (the snapshot folders: files from before
   *  0284 with every row gone; nothing there can go without a row or a
   *  tombstone anyway). Default true. */
  stopWhenNoRows?: boolean;
  /** Clear the tombstones of files removed or found gone (absolute). */
  forget?: (abs: readonly string[]) => Promise<void>;
  /** Remove a folder the sweep emptied (up to the root): the snapshot
   *  folders, one per item. */
  pruneEmptyDirs?: boolean;
  /** The node a file under the root (its path relative to it) is a revision
   *  of, or null: not one of the store's files at all, never touched. */
  nodeOf: (rel: string) => string | null;
  /** A legacy name kept whatever the rows say (reported, never removed). */
  spare?: (rel: string) => boolean;
  /** Every row of the store: its node and the files it names now (read
   *  after the walk, so a flip during the walk keeps its file). */
  rows: () => Promise<readonly SweepRow[]>;
};

export type SweepReport = {
  store: StoreName;
  /** The spec's label, else the store. */
  label: string;
  /** How many files the store's rows name (0 before the rows are read, or
   *  for a held store): none at all is a wrong or empty database to the
   *  leftovers command. */
  named: number;
  /** Files no row points at, seen for the first time this run. */
  marked: number;
  /** Removed (or, in a dry run, due): an old revision of a node whose row
   *  names another file, unreferenced for a whole grace period. */
  removed: string[];
  /** Due, but past this run's budget: carried to the next run (the oldest
   *  marked go first). Not a failure. */
  deferred: number;
  failed: number;
  /** Files whose node has NO row (a deleted item's, a create that never
   *  landed, an app deleted long ago): reported, never removed. */
  noRow: string[];
  /** Files of a node whose row names a file that is not on disk (they may
   *  be the only copy): reported, never removed. */
  rowFileMissing: string[];
  /** Legacy names (`spare`): reported, never removed. */
  legacy: string[];
  /** Until when a restore's hold keeps this store from being swept (an ISO
   *  time), or null. A held run removes and marks nothing; not a failure. */
  held: string | null;
  /** Why a hard stop kept this run from removing anything, or null: a row
   *  outside the root, no row naming any file, a row naming an older
   *  current revision than on the last run. A failure. */
  aborted: string | null;
};

export type SweepOptions = {
  now?: number;
  graceMs?: number;
  dryRun?: boolean;
  /** Most files one run removes: the larger of this (500) and half the
   *  files the store holds. The rest are carried, oldest marked first. */
  budget?: number;
  /** Sweep although a restore's hold is in place or a row went back to an
   *  older revision (the CLI's --allow-many: its dry run, `pnpm store:sweep
   *  --allow-many` without --apply, shows what a run would do). */
  allowMany?: boolean;
};

/** The least a run may remove (or half the store, if more). */
export const STORE_SWEEP_BUDGET = 500;

/** The file a restore writes at a store's root (scripts/db-restore.sh,
 *  scripts/app-dbs-restore.sh, before they restore anything; any other
 *  restore must too, and remove `.store-sweep.json`): restored rows may
 *  name OLDER revisions than the files on disk, which would look like old
 *  revisions to remove. While it is younger than STORE_SWEEP_HOLD_MS the
 *  sweep holds the store, and a backup keeps every revision. */
export const STORE_SWEEP_HOLD_FILE = '.store-sweep-hold';
export const STORE_SWEEP_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
/** The sweep's memory at a store's root. */
export const STORE_SWEEP_STATE_FILE = '.store-sweep.json';

/** When the hold at `root` was put down, while it holds; else null. */
function holdSince(root: string, now: number): number | null {
  try {
    const held = statSync(join(root, STORE_SWEEP_HOLD_FILE)).mtimeMs;
    return now - held < STORE_SWEEP_HOLD_MS ? held : null;
  } catch {
    return null;
  }
}

/** `p`'s real path; for a file that is gone, its folder's real path joined
 *  with its name. */
function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return resolve(p);
    }
  }
}

/** The sweep's memory beside the store: when it first saw each file
 *  unreferenced, once it was a grace period old (`marks`), and the time of each item's current revision on
 *  its last run (`current`). */
type SweepState = { marks: Record<string, number>; current: Record<string, number> };

function readState(root: string): SweepState {
  try {
    const raw = JSON.parse(readFileSync(join(root, STORE_SWEEP_STATE_FILE), 'utf8')) as unknown;
    if (raw && typeof raw === 'object') {
      const r = raw as { marks?: unknown; current?: unknown };
      if (r.marks && typeof r.marks === 'object') {
        return {
          marks: r.marks as Record<string, number>,
          current: (r.current && typeof r.current === 'object' ? r.current : {}) as Record<
            string,
            number
          >,
        };
      }
      // The first shape: the marks alone.
      return { marks: raw as Record<string, number>, current: {} };
    }
  } catch {
    /* none yet */
  }
  return { marks: {}, current: {} };
}

/**
 * Whether a file of the store under `root` was already marked unreferenced
 * by the sweep before `before` (ms): a flip never points a row back at an
 * old revision, so such a file was unreferenced when a Postgres dump taken
 * at `before` ran, and a backup made with that dump may leave it out
 * (bounded backups). Never while a restore's hold is in place: a restore
 * points rows back at older revisions, which an old mark may name. `abs` is any spelling of its path.
 */
export function markedBefore(
  root: string,
  before: number,
  now: number = Date.now(),
): (abs: string) => boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return () => false;
  }
  if (holdSince(realRoot, now) !== null) return () => false;
  const { marks } = readState(realRoot);
  return (abs) => {
    const seen = marks[relativeTo(realRoot, realOrResolved(abs))];
    return seen !== undefined && seen < before;
  };
}

function walkFiles(root: string, rel = '', out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(root, r, out, depth + 1);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/**
 * THE sweep, one for every
 * store. It removes ONLY an old revision a flip replaced: a file of the
 * store (`nodeOf`) that no row names, whose node HAS a row naming other
 * files, all of them on disk; and only once it has been unreferenced on two
 * runs a grace period apart and is older than it (a stage in flight, a
 * reader that resolved the old revision just before a flip). A SQLite
 * file's sidecars go with it. Each run removes at most its budget (the
 * larger of 500 and half the store's files), the oldest marked first; the
 * rest are carried to the next run and reported (`deferred`), never a
 * failure.
 *
 * Never removed, only reported: a file whose node has no row (a deleted
 * item's, a create that never landed, a legacy file of an item long gone;
 * it may be the only copy), the files of a node whose row names
 * a file that is missing, and the legacy names (`spare`).
 *
 * Held (nothing removed or marked, `held`, not a failure): a restore's hold
 * at the root younger than a week, unless `allowMany`.
 *
 * Hard stops (nothing removed or marked, logged, `aborted`): a row naming a
 * file outside the root (both sides compared as real paths: the root is
 * not the one the rows were written under); a store holding files while no
 * row names any (a wrong or empty database); a row whose current file is
 * an OLDER revision than the one it named on the last run (a restore no
 * hold announced), unless `allowMany`. Idempotent, plain files and one
 * read of the rows: no model, no extraction, no notify.
 */
export async function sweepOrphans(spec: SweepSpec, opts: SweepOptions = {}): Promise<SweepReport> {
  const grace = opts.graceMs ?? STORE_SWEEP_GRACE_MS;
  const report: SweepReport = {
    store: spec.store,
    label: spec.label ?? spec.store,
    named: 0,
    marked: 0,
    removed: [],
    deferred: 0,
    failed: 0,
    noRow: [],
    rowFileMissing: [],
    legacy: [],
    held: null,
    aborted: null,
  };
  let root: string;
  try {
    root = realpathSync(spec.root);
  } catch {
    return report; // no store yet: nothing to sweep
  }
  const stop = (why: string): SweepReport => {
    report.aborted = why;
    report.removed = [];
    console.error(`[store-sweep] ${report.label}: STOPPED, nothing removed: ${why}`);
    return report;
  };
  if (!opts.allowMany) {
    const at = opts.now ?? Date.now();
    const held = holdSince(root, at) ?? (spec.holdRoot ? holdSince(spec.holdRoot, at) : null);
    if (held !== null) {
      report.held = new Date(held + STORE_SWEEP_HOLD_MS).toISOString();
      console.warn(
        `[store-sweep] ${report.label}: HELD until ${report.held} by a restore (${STORE_SWEEP_HOLD_FILE}): read the dry run (pnpm -C server/web store:sweep --allow-many, without --apply), then run it with --apply --allow-many, or remove the hold`,
      );
      return report;
    }
  }
  const owned = walkFiles(root).filter((f) => spec.nodeOf(f) !== null);
  const rows = await spec.rows();
  // The time marks are taken at: after the rows were read.
  const now = opts.now ?? Date.now();
  const state = readState(root);
  // Every file a row names, as a path relative to the real root.
  const referenced = new Set<string>();
  const byNode = new Map<string, string[]>();
  const current: Record<string, number> = {};
  for (const row of rows) {
    const named: string[] = [];
    for (const f of row.files) {
      const abs = isAbsolute(f) ? realOrResolved(f) : realOrResolved(join(root, f));
      const rel = relativeTo(root, abs);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        return stop(
          `a row names ${f}, outside the store's root ${spec.root}: is this the root the rows were written under?`,
        );
      }
      referenced.add(rel);
      named.push(rel);
    }
    byNode.set(row.node, [...(byNode.get(row.node) ?? []), ...named]);
    const first = row.columns?.[0];
    if (first) {
      const t = revisionTime(basename(first));
      const before = state.current[row.node];
      if (before !== undefined && t < before && !opts.allowMany) {
        return stop(
          `the row of ${row.node} names ${first}, an older revision than on the last run: a restore? Put a hold (${STORE_SWEEP_HOLD_FILE}), or read the dry run (pnpm -C server/web store:sweep --allow-many, without --apply), then run it with --apply --allow-many`,
        );
      }
      // A name with no revision token (a snapshot's, a legacy file) is
      // never remembered: it can never be newer than another.
      if (t > 0) current[row.node] = t;
    }
  }
  // The tombstones (0284), as paths relative to the real root; one outside
  // it never lets anything go.
  report.named = referenced.size;
  // Each tombstone's age at `now` (a run told another time shifts it).
  const shift = now - Date.now();
  const tombs = new Map<string, { abs: string; age: number }>();
  for (const t of spec.tombstones ? await spec.tombstones() : []) {
    const rel = relativeTo(root, realOrResolved(t.abs));
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      tombs.set(rel, { abs: t.abs, age: t.ageMs + shift });
    }
  }
  if (
    spec.stopWhenNoRows !== false &&
    owned.length > 0 &&
    referenced.size === 0 &&
    !owned.some((f) => tombs.has(f))
  ) {
    return stop(
      `${owned.length} store files and no row names any: is this the right database and root?`,
    );
  }
  const marks = state.marks;
  const next: Record<string, number> = {};
  const due: { rel: string; seen: number }[] = [];
  for (const rel of owned) {
    if (referenced.has(rel)) continue;
    if (spec.spare?.(rel)) {
      report.legacy.push(rel);
      continue;
    }
    const node = spec.nodeOf(rel)!;
    const named = byNode.get(node);
    const tomb = tombs.get(rel);
    if (!named || named.length === 0) {
      // No row: reported, never removed, unless a tombstone says the row
      // that named it went (a deleted snapshot).
      if (!tomb) {
        report.noRow.push(rel);
        continue;
      }
    } else if (named.some((n) => !existsSync(join(root, n)))) {
      report.rowFileMissing.push(rel);
      continue;
    }
    let mtime: number;
    try {
      mtime = statSync(join(root, rel)).mtimeMs;
    } catch {
      continue;
    }
    // Younger than the grace period: a stage that may be in flight (its flip
    // may land in a moment). Never marked, so a mark always means "a grace
    // period old and unreferenced" wherever it is read (a backup's
    // markedBefore among them).
    if (now - mtime < grace) continue;
    // A tombstoned file waits a day after its row went, whatever rule lets
    // it go (a backup's dump may name the row), then counts
    // as unreferenced since then.
    if (tomb && tomb.age < STORE_TOMBSTONE_GRACE_MS) continue;
    const seen = Math.min(marks[rel] ?? now, tomb ? now - tomb.age : now);
    if (marks[rel] === undefined) report.marked += 1;
    next[rel] = seen;
    if (now - seen >= grace) due.push({ rel, seen });
  }
  // The run's budget: the oldest marked first; the rest wait for the next
  // run (a busy day never stops the sweep).
  const budget = Math.max(opts.budget ?? STORE_SWEEP_BUDGET, Math.floor(owned.length / 2));
  due.sort((a, b) => a.seen - b.seen || (a.rel < b.rel ? -1 : 1));
  const thisRun = due.slice(0, budget);
  report.deferred = due.length - thisRun.length;
  for (const { rel } of thisRun) {
    if (!opts.dryRun) {
      try {
        removeSqliteFile(join(root, rel));
      } catch {
        report.failed += 1;
        continue;
      }
      delete next[rel];
      if (spec.pruneEmptyDirs) removeEmptyDirs(root, rel);
    }
    report.removed.push(rel);
  }
  if (!opts.dryRun) {
    writeState(root, { marks: next, current });
    // Tombstones whose file is gone (removed now, or before), past their
    // day: cleared.
    const done = [...tombs]
      .filter(([rel, t]) => t.age >= STORE_TOMBSTONE_GRACE_MS && !existsSync(join(root, rel)))
      .map(([, t]) => t.abs);
    if (done.length && spec.forget) {
      try {
        await spec.forget(done);
      } catch (err) {
        console.error(
          `[store-sweep] ${report.label}: could not clear tombstones:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  return report;
}

/** Remove the folders above `rel` the sweep emptied, up to the root. */
function removeEmptyDirs(root: string, rel: string): void {
  let dir = dirname(rel);
  while (dir && dir !== '.' && dir !== '/') {
    try {
      if (readdirSync(join(root, dir)).length > 0) return;
      rmdirSync(join(root, dir));
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/** Remember the unreferenced files and each item's current revision. */
function writeState(root: string, state: SweepState): void {
  try {
    const file = join(root, STORE_SWEEP_STATE_FILE);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  } catch {
    /* an unwritable root: the next run starts the grace period again */
  }
}

/** `abs` relative to `root`, with forward slashes. */
export function relativeTo(root: string, abs: string): string {
  return relative(root, abs).split('\\').join('/');
}
