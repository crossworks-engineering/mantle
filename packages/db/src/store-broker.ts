/**
 * The store brokers' one helper (workspaces arch plan v2, sections 6 and
 * 20.3; A3b; docs/store-brokers.md). Six stores keep data on disk, where no
 * trigger sees it. Each has ONE broker module, the only writer of its disk,
 * and every broker writes through this file in the same order:
 *
 *  1. one transaction (`brokerTransaction`, on the store's own row lock);
 *  2. the Postgres statement the database checks, as the caller's actor
 *     (bump the revision, write the row): it must match exactly one row
 *     (`StoreWrite.one`); none is a refusal, `StoreRefusedError`, the edit
 *     check's own 42501 `no_read` (a 404 through every existing mapper); a
 *     trigger's refusal is thrown by the statement itself;
 *  3. the disk, only after that (`replace`, `create`, `remove`, `inPlace`
 *     throw before it); each step first records how to undo it in a journal
 *     beside the store's file (`<file>.broker`), with the revision the
 *     database now holds: the revision is then in both places;
 *  4. a step or a later statement that fails undoes the disk at once,
 *     inside the transaction (the row lock still held), and rolls back; a
 *     commit drops the journal and the pre-images;
 *  5. a commit that fails after the disk write (or a process that dies)
 *     leaves the journal: the broker's next access, under the same row
 *     lock, trusts the database (`repairStore`): the journal's revision
 *     committed, it only tidies; it did not, the disk goes back (the
 *     pre-image restored, a new file removed). An in-place write (a SQLite
 *     file changed where it lies) has no pre-image: its store says what the
 *     database holds of it (`StoreWriteOptions.inPlace`), else the write
 *     stays (it passed its check) and one warning says so.
 *
 * Bounded by construction: a repair reads one journal, acts on its own
 * files and removes it; it never loops, notifies, or starts extraction.
 * Writers run this; readers keep their imports (the store-brokers lint).
 */
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { afterCommit, afterRollback } from './viewer';

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

/** A revision as the journal keeps it: the database's value, as text. */
export type StoreRev = string | number | bigint;

type Step =
  /** Undo: move the pre-image back over the target. */
  | { op: 'restore'; pre: string; target: string; sqlite: boolean }
  /** Undo: remove what this write made. */
  | { op: 'remove'; target: string; sqlite: boolean }
  /** No undo: the file changed where it lies. */
  | { op: 'in-place'; target: string };

/** What a broker writes beside its file before it touches the disk. */
export type StoreJournal = {
  v: 1;
  store: StoreName;
  /** The database's revision once this write commits; null: the row is
   *  gone (a delete). */
  rev: string | null;
  /** The revision before it; null when the row is new. */
  prev: string | null;
  /** This write's own id: a late finalize never removes another's journal. */
  token: string;
  steps: Step[];
};

/** What a repair found: no journal, a committed write tidied, a write the
 *  database never took undone, or one kept (in place, or a revision that is
 *  neither: the disk is never rolled back over a newer commit). */
export type RepairOutcome = 'clean' | 'committed' | 'undone' | 'kept';

/** A store's say over a write that changed a file in place and did not
 *  commit: rebuild it from what the database holds (true), or keep it. */
export type InPlaceRepair = (journal: StoreJournal, target: string) => boolean;

export type StoreWriteOptions = {
  /** An in-place write that did not commit (see InPlaceRepair). */
  inPlace?: InPlaceRepair;
};

const text = (v: StoreRev | null): string | null => (v === null ? null : String(v));

/** The files a SQLite database keeps beside it. */
function sqliteSidecars(file: string): string[] {
  return [`${file}-wal`, `${file}-shm`, `${file}-journal`];
}

function removeFile(file: string, sqlite: boolean): void {
  rmSync(file, { force: true });
  if (sqlite) for (const f of sqliteSidecars(file)) rmSync(f, { force: true });
}

/** Undo one step. Idempotent: a step already undone is a no-op. */
function undoStep(step: Step): void {
  if (step.op === 'remove') removeFile(step.target, step.sqlite);
  else if (step.op === 'restore') {
    if (!existsSync(step.pre)) return;
    // A stale WAL beside the target would be replayed into the restored
    // file on its next open (SQLite does not match a WAL to its file).
    if (step.sqlite) for (const f of sqliteSidecars(step.target)) rmSync(f, { force: true });
    renameSync(step.pre, step.target);
  }
}

/** Drop a committed write's pre-images. */
function finalizeSteps(steps: readonly Step[]): void {
  for (const s of steps) if (s.op === 'restore') rmSync(s.pre, { force: true });
}

function writeJournal(path: string, journal: StoreJournal): void {
  // The store's folder may be new (a table's first file): made after the
  // check, like everything this write puts on disk.
  mkdirSync(dirname(path), { recursive: true });
  // Whole or not at all: a crash mid-write leaves a .tmp, never half a
  // journal.
  const tmp = `${path}.${journal.token}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal));
  renameSync(tmp, path);
}

/** The journal at `path`, or null (none, or not one of ours). */
export function readStoreJournal(path: string): StoreJournal | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(raw) as StoreJournal;
    return j && j.v === 1 && Array.isArray(j.steps) ? j : null;
  } catch {
    return null;
  }
}

/** Remove the journal only while it is still `token`'s. */
function dropJournal(path: string, token: string): void {
  if (readStoreJournal(path)?.token === token) rmSync(path, { force: true });
}

/**
 * Repair on read: trust the database. The caller holds the store's row lock
 * and passes the revision the database holds now (null: no row). The fast
 * path is one existsSync.
 */
export function repairStore(
  journalPath: string,
  dbRev: StoreRev | null,
  opts: StoreWriteOptions = {},
): RepairOutcome {
  if (!existsSync(journalPath)) return 'clean';
  const j = readStoreJournal(journalPath);
  if (!j) {
    // Not a journal we can read: written before any disk step ran (the
    // journal goes whole by rename), so there is nothing to undo.
    rmSync(journalPath, { force: true });
    return 'clean';
  }
  const db = text(dbRev);
  if (db === j.rev) {
    finalizeSteps(j.steps);
    rmSync(journalPath, { force: true });
    return 'committed';
  }
  if (db !== j.prev) {
    // Neither this write's revision nor the one before it: something
    // newer committed. Rolling the disk back now could clobber it.
    console.warn(
      `[store-broker] ${j.store}: journal ${journalPath} names revision ${j.rev} (from ${String(j.prev)}), the database holds ${String(db)}: kept, journal dropped`,
    );
    finalizeSteps(j.steps);
    rmSync(journalPath, { force: true });
    return 'kept';
  }
  let kept = false;
  for (const step of [...j.steps].reverse()) {
    if (step.op !== 'in-place') {
      undoStep(step);
      continue;
    }
    if (opts.inPlace?.(j, step.target)) continue;
    kept = true;
    console.warn(
      `[store-broker] ${j.store}: ${step.target} was changed in place at revision ${j.rev}, which did not commit (the database holds ${String(db)}); the write passed its check and is kept`,
    );
  }
  rmSync(journalPath, { force: true });
  return kept ? 'kept' : 'undone';
}

/**
 * One broker write, inside its transaction (brokerTransaction): the checked
 * statement first (`one`), then the journal (`journalAt`), then the disk.
 */
export class StoreWrite {
  private checked = false;
  private path: string | null = null;
  private journal: StoreJournal | null = null;
  private settled = false;

  constructor(
    readonly store: StoreName,
    private readonly opts: StoreWriteOptions = {},
  ) {}

  /** The checked statement's rows: exactly one, else a refusal. */
  one<T>(rows: readonly T[], what: string): T {
    if (rows.length !== 1) throw new StoreRefusedError(this.store, what, rows.length);
    this.checked = true;
    return rows[0] as T;
  }

  /** Mark a check that is not a row count: a row the caller's own INSERT
   *  made in this transaction (one row by construction). */
  inserted<T>(row: T | undefined, what: string): T {
    return this.one(row === undefined ? [] : [row], what);
  }

  /**
   * Where this write's journal lives and the revisions it moves between.
   * After the check; before any disk step. A journal a failed earlier write
   * left there is repaired first, under the lock this transaction holds.
   */
  journalAt(path: string, rev: StoreRev | null, prev: StoreRev | null): void {
    if (!this.checked) throw new Error(`store broker ${this.store}: a journal before the check`);
    if (this.journal) {
      if (this.path !== path) throw new Error(`store broker ${this.store}: one journal per write`);
      return;
    }
    repairStore(path, prev, this.opts);
    this.path = path;
    this.journal = {
      v: 1,
      store: this.store,
      rev: text(rev),
      prev: text(prev),
      token: randomUUID(),
      steps: [],
    };
  }

  private assertChecked(): void {
    if (!this.checked || !this.journal || !this.path) {
      throw new Error(`store broker ${this.store}: the disk before the database check`);
    }
  }

  private record(step: Step): void {
    this.assertChecked();
    if (!this.journal || !this.path) return;
    this.journal.steps.push(step);
    writeJournal(this.path, this.journal);
  }

  /** Replace `target` whole: `write` puts a NEW file there (a rename over
   *  it, never an edit in place). The old file is kept aside (a hard link)
   *  until the commit. `checkpoint` folds a SQLite file's WAL into it
   *  first, so the pre-image is complete. */
  async replace<R>(
    target: string,
    write: () => R | Promise<R>,
    o: { sqlite?: boolean; checkpoint?: () => void } = {},
  ): Promise<R> {
    const sqlite = o.sqlite ?? false;
    if (this.covers(target)) {
      this.assertChecked();
      return await write();
    }
    if (!existsSync(target)) return this.create(target, write, { sqlite });
    const pre = `${target}.pre-${this.journal?.token ?? 'x'}`;
    this.record({ op: 'restore', pre, target, sqlite });
    o.checkpoint?.();
    try {
      linkSync(target, pre);
    } catch {
      copyFileSync(target, pre);
    }
    return await write();
  }

  /** Make `target`, which does not exist: the undo removes it. */
  async create<R>(
    target: string,
    write: () => R | Promise<R>,
    o: { sqlite?: boolean } = {},
  ): Promise<R> {
    if (this.covers(target)) this.assertChecked();
    else this.record({ op: 'remove', target, sqlite: o.sqlite ?? false });
    return await write();
  }

  /** Remove `target`: moved aside until the commit, back on an undo. */
  remove(target: string, o: { sqlite?: boolean } = {}): void {
    const sqlite = o.sqlite ?? false;
    if (this.covers(target)) {
      // Made or replaced by this write: its undo already brings back what
      // was there before.
      this.assertChecked();
      removeFile(target, sqlite);
      return;
    }
    if (!existsSync(target)) return;
    const pre = `${target}.pre-${this.journal?.token ?? 'x'}`;
    this.record({ op: 'restore', pre, target, sqlite });
    if (sqlite) {
      // The sidecars belong to the file: a WAL left behind would be read
      // into whatever is made at this path next.
      for (const f of sqliteSidecars(target)) rmSync(f, { force: true });
    }
    renameSync(target, pre);
  }

  /** Change `target` where it lies (no pre-image; see InPlaceRepair). A
   *  file this write already replaced or made needs no step of its own: its
   *  undo puts back what was there before either. */
  async inPlace<R>(target: string, write: () => R | Promise<R>): Promise<R> {
    if (!this.covers(target)) this.record({ op: 'in-place', target });
    else this.assertChecked();
    return await write();
  }

  /**
   * A write to a store with no file of ours beside it: the object store,
   * content-addressed, where a commit that fails leaves an object nothing
   * points at (the same bytes a later identical write reuses), so there is
   * nothing to undo or repair. After the check, like every disk step.
   */
  async external<R>(write: () => R | Promise<R>): Promise<R> {
    if (!this.checked) throw new Error(`store broker ${this.store}: the store before the check`);
    return await write();
  }

  /** Whether this write already has an undo for `target`. */
  covers(target: string): boolean {
    return (this.journal?.steps ?? []).some((s) => s.op !== 'in-place' && s.target === target);
  }

  /** The work failed inside the transaction: put the disk back now, while
   *  the row lock is still held. */
  undoNow(): void {
    if (!this.journal || !this.path || this.settled) return;
    this.settled = true;
    const { steps, token } = this.journal;
    try {
      for (const step of [...steps].reverse()) if (step.op !== 'in-place') undoStep(step);
      dropJournal(this.path, token);
    } catch (err) {
      // Left for the next access's repair, which retries the same steps.
      console.error(
        `[store-broker] ${this.store}: undo failed, left for repair:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** The transaction committed: drop the pre-images and the journal. */
  finalize(): void {
    if (!this.journal || !this.path || this.settled) return;
    this.settled = true;
    finalizeSteps(this.journal.steps);
    dropJournal(this.path, this.journal.token);
  }

  /** An outer transaction rolled back after this one's savepoint was
   *  released: undo, as long as the journal is still this write's. */
  undoLate(): void {
    if (!this.journal || !this.path) return;
    if (readStoreJournal(this.path)?.token !== this.journal.token) return;
    this.settled = false;
    this.undoNow();
  }

  /** Whether a disk step ran (the journal exists). */
  get wrote(): boolean {
    return (this.journal?.steps.length ?? 0) > 0;
  }
}

/**
 * Run one broker write: `open` is the store's transaction (its row lock),
 * `fn` the work, given the transaction and the StoreWrite. A retry by
 * `open` gets a fresh StoreWrite (the failed attempt was undone).
 */
export async function brokerTransaction<Tx, T>(
  store: StoreName,
  open: (run: (tx: Tx) => Promise<T>) => Promise<T>,
  fn: (tx: Tx, w: StoreWrite) => Promise<T>,
  opts: StoreWriteOptions = {},
): Promise<T> {
  let last: StoreWrite | null = null;
  let worked = false;
  let result: T;
  try {
    result = await open(async (tx) => {
      const w = new StoreWrite(store, opts);
      last = w;
      worked = false;
      try {
        const out = await fn(tx, w);
        worked = true;
        return out;
      } catch (err) {
        w.undoNow();
        throw err;
      }
    });
  } catch (err) {
    // Worked, then failed: the commit itself. The disk is ahead of the
    // database; the journal stays, and the next access repairs it under
    // the row lock (an undo here would run without it).
    if (worked && (last as StoreWrite | null)?.wrote) {
      console.warn(
        `[store-broker] ${store}: the commit failed after the disk write; repaired on the next access`,
      );
    }
    throw err;
  }
  const w = last as StoreWrite | null;
  if (w) {
    // Inside an outer scope transaction (a personal space, a system
    // transaction this one is a savepoint of), its end decides.
    await afterCommit(() => w.finalize());
    afterRollback(() => w.undoLate());
  }
  return result;
}
