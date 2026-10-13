/**
 * The store brokers' one helper (workspaces arch plan v2, sections 6 and
 * 20.3; A3b; docs/store-brokers.md). Six stores keep data on disk, where no
 * trigger sees it. Each has ONE broker module, the only writer of its disk,
 * and every whole-file write goes the same way (plan 20.3):
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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** The six stores of plan section 6. */
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
 * unreferenced revision for the sweep (A3b fix round 2, N3). Returns the
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

/** A table draft written before A3b (`<node>.draft.sqlite`, no revision
 *  token): the sweep never removes one, it reports it. */
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
 *  sweep (`storeRows`) and the backups read (A3b fix round 2, N5). A
 *  table's are relative to TABLE_DB_DIR, an app database's absolute. */
export const STORE_FILE_COLUMNS = {
  tables: { table: 'tables', node: 'node_id', files: ['storage_path', 'draft_path'] },
  appdb: { table: 'app_databases', node: 'app_node_id', files: ['storage_path'] },
} as const satisfies Record<
  RevisionStore,
  { table: string; node: string; files: readonly string[] }
>;

/** Every row of a store with the files it names now (STORE_FILE_COLUMNS),
 *  read on the caller's handle. */
export async function storeRows(store: RevisionStore): Promise<SweepRow[]> {
  const [{ db }, { sql }] = await Promise.all([import('./client'), import('drizzle-orm')]);
  const spec = STORE_FILE_COLUMNS[store];
  const cols = spec.files.map((c) => `"${c}"`).join(', ');
  const rows = (await db.execute(
    sql.raw(`select "${spec.node}"::text as node, array[${cols}] as files from "${spec.table}"`),
  )) as unknown as { node: string; files: (string | null)[] }[];
  return rows.map((r) => ({
    node: r.node,
    files: (r.files ?? []).filter((f): f is string => typeof f === 'string' && f.length > 0),
  }));
}

// ── The sweep ───────────────────────────────────────────────────────────

/** How long a file no row points at stays before the sweep removes it: a
 *  stage in flight is younger, and a revision just un-referenced has had
 *  its readers finish (a reader that resolved it before the flip). */
export const STORE_SWEEP_GRACE_MS = 60 * 60 * 1000;

/** A row of a store, as the sweep reads it: its node and the files it
 *  names (relative to the store's root, or absolute). */
export type SweepRow = { node: string; files: readonly string[] };

export type SweepSpec = {
  store: StoreName;
  /** The store's root folder. */
  root: string;
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
  /** Why this run removed nothing (a hard stop or a restore's hold), or
   *  null. */
  aborted: string | null;
};

export type SweepOptions = {
  now?: number;
  graceMs?: number;
  dryRun?: boolean;
  /** Most files one run removes: the larger of this (500) and half the
   *  files the store holds. The rest are carried, oldest marked first. */
  budget?: number;
  /** Sweep although a restore's hold is in place (the CLI's --allow-many,
   *  after a dry run was read). */
  allowMany?: boolean;
};

/** The least a run may remove (or half the store, if more). */
export const STORE_SWEEP_BUDGET = 500;

/** The file a restore writes at a store's root (scripts/db-restore.sh,
 *  scripts/app-dbs-restore.sh): restored rows may name OLDER revisions than
 *  the files on disk, which would look like old revisions to remove. While
 *  it is younger than STORE_SWEEP_HOLD_MS the sweep stops unless told
 *  otherwise. */
export const STORE_SWEEP_HOLD_FILE = '.store-sweep-hold';
export const STORE_SWEEP_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

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

/** The sweep's memory of what it saw unreferenced, beside the store. */
function markFile(root: string): string {
  return join(root, '.store-sweep.json');
}

function readMarks(root: string): Record<string, number> {
  try {
    const m = JSON.parse(readFileSync(markFile(root), 'utf8')) as Record<string, number>;
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

/**
 * Whether a file of the store under `root` was already marked unreferenced
 * by the sweep before `before` (ms): a flip never points a row back at an
 * old revision, so such a file was unreferenced when a Postgres dump taken
 * at `before` ran, and a backup made with that dump may leave it out
 * (bounded backups, A3b fix round 2). `abs` is any spelling of its path.
 */
export function markedBefore(root: string, before: number): (abs: string) => boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return () => false;
  }
  const marks = readMarks(realRoot);
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
 * THE sweep (plan 20.3: "leaves a sweep to remove orphans"), one for every
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
 * item's, a create that never landed, a file from before A3b of an item
 * long gone; it may be the only copy), the files of a node whose row names
 * a file that is missing, and the legacy names (`spare`).
 *
 * Stops (nothing removed, nothing marked, logged, `aborted`): a restore's
 * hold at the root younger than a week (unless `allowMany`); a row naming a
 * file outside the root (both sides compared as real paths: the root is
 * not the one the rows were written under); a store holding files while no
 * row names any (a wrong or empty database). Idempotent, plain files and
 * one read of the rows: no model, no extraction, no notify.
 */
export async function sweepOrphans(spec: SweepSpec, opts: SweepOptions = {}): Promise<SweepReport> {
  const now = opts.now ?? Date.now();
  const grace = opts.graceMs ?? STORE_SWEEP_GRACE_MS;
  const report: SweepReport = {
    store: spec.store,
    marked: 0,
    removed: [],
    deferred: 0,
    failed: 0,
    noRow: [],
    rowFileMissing: [],
    legacy: [],
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
    console.error(`[store-sweep] ${spec.store}: STOPPED, nothing removed: ${why}`);
    return report;
  };
  if (!opts.allowMany) {
    try {
      const held = statSync(join(root, STORE_SWEEP_HOLD_FILE)).mtimeMs;
      if (now - held < STORE_SWEEP_HOLD_MS) {
        return stop(
          `a restore put a hold on this store ${new Date(held).toISOString()} (${STORE_SWEEP_HOLD_FILE}): the restored rows may name older revisions than the files here. Read a dry run, then run it with --allow-many, or remove the hold`,
        );
      }
    } catch {
      /* no hold */
    }
  }
  const owned = walkFiles(root).filter((f) => spec.nodeOf(f) !== null);
  const rows = await spec.rows();
  // Every file a row names, as a path relative to the real root.
  const referenced = new Set<string>();
  const byNode = new Map<string, string[]>();
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
  }
  if (owned.length > 0 && referenced.size === 0) {
    return stop(
      `${owned.length} store files and no row names any: is this the right database and root?`,
    );
  }
  const marks = readMarks(root);
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
    if (!named || named.length === 0) {
      report.noRow.push(rel);
      continue;
    }
    if (named.some((n) => !existsSync(join(root, n)))) {
      report.rowFileMissing.push(rel);
      continue;
    }
    let mtime: number;
    try {
      mtime = statSync(join(root, rel)).mtimeMs;
    } catch {
      continue;
    }
    const seen = marks[rel] ?? now;
    if (marks[rel] === undefined) report.marked += 1;
    next[rel] = seen;
    if (now - seen >= grace && now - mtime >= grace) due.push({ rel, seen });
  }
  // The run's budget: the oldest marked first; the rest wait for the next
  // run (A3b fix round 2, N1: a busy day never stops the sweep).
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
    }
    report.removed.push(rel);
  }
  if (!opts.dryRun) writeMarks(root, next);
  return report;
}

/** Remember the unreferenced files and when they were first seen. */
function writeMarks(root: string, marks: Record<string, number>): void {
  try {
    const tmp = `${markFile(root)}.tmp`;
    writeFileSync(tmp, JSON.stringify(marks));
    renameSync(tmp, markFile(root));
  } catch {
    /* an unwritable root: the next run starts the grace period again */
  }
}

/** `abs` relative to `root`, with forward slashes. */
export function relativeTo(root: string, abs: string): string {
  return relative(root, abs).split('\\').join('/');
}
