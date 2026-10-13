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
 *  3. a stage the flip did not take is removed at once (`stageThenFlip`);
 *     one that outlives a crash, and every revision a row no longer points
 *     at, is an orphan for the one sweep (`sweepOrphans`, run by the
 *     maintenance worker).
 *
 * No transaction is held across a disk write. Readers resolve a store's
 * file through its row, in one place per store. The exceptions (an app's
 * SQL statement, a table's op batch: a write in place, where a copy per
 * write would cost a whole file) are the brokers', documented there.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';

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

/**
 * Stage, then flip: `stage` writes the new revision (no row points at it),
 * `flip` is the one short transaction that checks the row and points it at
 * the stage. A flip that throws (a refusal, a conflict, a failed commit)
 * removes the stage at once (`discard`, best effort: the sweep is the
 * backstop). Returns the flip's result.
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
    try {
      discard(staged);
    } catch {
      /* the sweep removes it */
    }
    throw err;
  }
}

/** How long a file no row points at stays before the sweep removes it: a
 *  stage in flight is younger, and a revision just un-referenced has had
 *  its readers finish (a reader that resolved it before the flip). */
export const STORE_SWEEP_GRACE_MS = 60 * 60 * 1000;

/** The SQLite files that belong to a database file. */
export const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'] as const;

export type SweepSpec = {
  store: StoreName;
  /** The store's root folder. */
  root: string;
  /** Whether a file under the root (its path relative to it) is one of the
   *  store's revisions at all: anything else is never touched. */
  owns: (rel: string) => boolean;
  /** The files rows point at NOW, relative to the root (read after the
   *  walk, so a flip during the walk keeps its file). */
  live: () => Promise<ReadonlySet<string>>;
};

export type SweepReport = {
  store: StoreName;
  /** Files no row points at, seen for the first time this run. */
  marked: number;
  /** Removed: not pointed at for a whole grace period. */
  removed: string[];
  failed: number;
};

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
 * store. A file the store owns that no row points at is removed only once
 * it has been unreferenced for a whole grace period on two runs, and is
 * older than it: never a revision a row points at, never a stage in flight.
 * A SQLite file's sidecars go with it. Bounded (`max` removals per run),
 * idempotent, plain files only: no model, no extraction, no notify.
 */
export async function sweepOrphans(
  spec: SweepSpec,
  opts: { now?: number; graceMs?: number; max?: number; dryRun?: boolean } = {},
): Promise<SweepReport> {
  const now = opts.now ?? Date.now();
  const grace = opts.graceMs ?? STORE_SWEEP_GRACE_MS;
  const max = opts.max ?? 500;
  const report: SweepReport = { store: spec.store, marked: 0, removed: [], failed: 0 };
  const files = walkFiles(spec.root).filter((f) => spec.owns(f));
  const live = await spec.live();
  const marks = readMarks(spec.root);
  const next: Record<string, number> = {};
  for (const rel of files) {
    if (live.has(rel)) continue;
    const abs = join(spec.root, rel);
    let mtime: number;
    try {
      mtime = statSync(abs).mtimeMs;
    } catch {
      continue;
    }
    const seen = marks[rel] ?? now;
    if (marks[rel] === undefined) report.marked += 1;
    if (now - seen >= grace && now - mtime >= grace && report.removed.length < max) {
      if (!opts.dryRun) {
        try {
          rmSync(abs, { force: true });
          for (const s of SQLITE_SIDECARS) rmSync(`${abs}${s}`, { force: true });
        } catch {
          report.failed += 1;
          next[rel] = seen;
          continue;
        }
      }
      report.removed.push(rel);
      continue;
    }
    next[rel] = seen;
  }
  if (!opts.dryRun) {
    try {
      const tmp = `${markFile(spec.root)}.tmp`;
      writeFileSync(tmp, JSON.stringify(next));
      renameSync(tmp, markFile(spec.root));
    } catch {
      /* no root yet: nothing to remember */
    }
  }
  return report;
}

/** `abs` relative to `root`, with forward slashes. */
export function relativeTo(root: string, abs: string): string {
  return relative(root, abs).split('\\').join('/');
}
