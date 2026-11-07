/**
 * Runs ONE app-supplied SQL statement against an app's SQLite file, off the
 * event loop. App SQL comes from app bundles, members and anonymous
 * public-share visitors alike, and `DatabaseSync` on the main thread has no
 * timeout: one endless recursive CTE would freeze the whole web process for
 * every user.
 *
 * It runs in a CHILD PROCESS, not a worker thread. A worker thread can be
 * terminated at the time limit, but terminating it does not close its
 * SQLite connection: a write stopped at the limit keeps the app's write
 * lock, and every later write to that app fails with "database is locked"
 * until the web process restarts. A killed process always lets go:
 * the OS closes its file descriptors, which drops its locks, and SQLite rolls
 * the unfinished write back from the WAL on the next open.
 *
 * Forking per statement would cost tens of milliseconds, so a small pool of
 * long-lived children serves one statement at a time each (at most
 * APP_SQL_MAX_CHILDREN; an idle one exits after APP_SQL_CHILD_IDLE_MS). A
 * statement that runs past its limit gets its child SIGKILLed, and the caller
 * hears about it only once the child is gone; the next statement forks a
 * fresh one. A child that dies any other way (the OOM killer, an operator)
 * leaves the pool the same way. Each statement opens and closes its own
 * connection inside the child, so a reused child carries nothing from one
 * statement to the next. A child also dies with this process: one inside a
 * statement cannot see this process go, so killWithParent gives each a guard.
 *
 * Inside the child, three engine-level locks hold whatever the text says
 * (a regex can be fooled; the engine cannot):
 *  - an AUTHORIZER refuses ATTACH (which also covers `VACUUM` and
 *    `VACUUM INTO`, both of which attach a database), DETACH, and every
 *    PRAGMA except `table_info` / `table_xinfo` and the `data_version` FTS5
 *    asks for;
 *  - a size limit on any one string or blob (`limits.length`);
 *  - a row cap and a byte cap on what a query returns;
 *  - on a writable open, a cap on the whole database file
 *    (`PRAGMA max_page_count`, from APP_SQL_MAX_DB_MB) and on the WAL left
 *    after a checkpoint (`PRAGMA journal_size_limit`): a write past the cap
 *    fails with SQLITE_FULL ("database or disk is full") and rolls back.
 *
 * One caller (a client login, a member login, a share link) runs at most one
 * statement at a time (`callerKey`): its next statement
 * waits its turn, so one caller cannot hold every child while other callers'
 * statements run on the rest.
 *
 * Mode 'script' runs an app's declared schema DDL (several statements) in
 * one transaction, under the same authorizer and limits: CREATE TABLE,
 * CREATE INDEX, ALTER TABLE and the rest pass; ATTACH, VACUUM and PRAGMAs
 * (bar table_info / table_xinfo, and the data_version FTS5 asks for) are
 * refused, and nothing of the script stays when any statement fails or is
 * killed.
 *
 * Mode 'dataBatch' runs an app's write call (host.db.batch) in one
 * transaction: rows only, whoever runs the app, an optional guard read under
 * the write lock first. Nothing stays when anything fails, or when its child
 * is killed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { envDynamic, envNum, envNumDefault } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { killWithParent } from '@mantle/std/kill-with-parent';
import {
  CHILD_READY,
  childEnd,
  livePlaces,
  refusalPace,
  runtimeFlags,
  withMemoryLimit,
} from '@mantle/std/self-spawn';

/** How long one app statement may run. */
export const APP_SQL_TIMEOUT_MS = 5_000;
/** The most rows one app query returns; beyond it the query fails with a
 *  "add a LIMIT" error rather than silently truncating an app's data. */
export const APP_SQL_MAX_ROWS = 50_000;
/** The largest string or blob one statement may produce (16 MiB). */
export const APP_SQL_MAX_LENGTH = 16 * 1024 * 1024;
/** How long a write batch waits for another writer at BEGIN, inside its own
 *  time limit: past it the batch answers busy, with time to spare to say so. */
export const APP_SQL_BATCH_BUSY_MS = 2_000;
/** How long an app's schema script may run. Longer than one statement: a new
 *  schema version may index a table that already holds the app's data. */
export const APP_SCHEMA_TIMEOUT_MS = 30_000;
/** The most SQL child processes alive at once. Each is a bare Node process
 *  (about 45 MB), inside the web container's memory limit (WEB_MEM_LIMIT, 3g
 *  by default). A statement beyond it waits for a free child, for at most its
 *  own time limit. A second try on a new child can pass it, for at most one
 *  time limit (see `release`). */
export const APP_SQL_MAX_CHILDREN = 4;
/** An idle child exits after this long, so a quiet server holds none. */
export const APP_SQL_CHILD_IDLE_MS = 60_000;
/** The default cap on one app's database file, in MB (APP_SQL_MAX_DB_MB). */
export const APP_SQL_DEFAULT_MAX_DB_MB = envNumDefault('APP_SQL_MAX_DB_MB');
/** The most bytes one query returns (roughly as serialized); beyond it the
 *  query fails with an "add a LIMIT" error. The rows cross into the web
 *  process and are JSON-encoded there, so this bounds its memory. */
export const APP_SQL_MAX_REPLY_BYTES = 8 * 1024 * 1024;
/** The kernel limit on a SQL process. A row is built whole before the reply
 *  cap can read it, so 64 columns of the longest value reach 2 GB without it,
 *  and an open-link visitor can ask for that. With it the process stops near
 *  500 MB of real memory. Node 26 needs about 575 MB of the limit to start,
 *  nearly all of it address space it does not touch (measured 2026-11-01). */
export const APP_SQL_CHILD_MEMORY_MB = 1024;
/** What a caller hears when a statement meets that limit: SQLite's own answer,
 *  then a process that ended and most likely met it. */
const OUT_OF_MEMORY =
  'the statement needs more memory than a SQL process may use: add a LIMIT, select fewer columns or aggregate in SQL';
const CRASHED =
  'the statement ended its SQL process, most likely at the memory limit: add a LIMIT, select fewer columns or aggregate in SQL';
/** The same, for the server's own steps on a file (a schema script, a write
 *  batch, a copy, an import): "add a LIMIT" means nothing to them. */
const STEP_OUT_OF_MEMORY =
  'this step needs more memory than a SQL process may use: the file or one of its values is too large for it';
const STEP_CRASHED =
  'this step ended its SQL process, most likely at the memory limit: the file or one of its values may be too large for it';
/** The jobs that are a step on the whole file, not one app statement. */
const FILE_STEPS: ReadonlySet<string> = new Set([
  'script',
  'batch',
  'dataBatch',
  'copy',
  'adopt',
  'timer',
]);
/** Refusals at the memory limit that pass at once, then the most per second
 *  (each one kills a child, and a new one is forked: see refusalPace). */
export const APP_SQL_REFUSAL_BURST = 4;
export const APP_SQL_REFUSALS_PER_SECOND = 2;
let paceRefusal = refusalPace(APP_SQL_REFUSAL_BURST, APP_SQL_REFUSALS_PER_SECOND);
/** Children killed at the memory limit and not yet replaced. A fork for a new
 *  statement or a waiter pays one first (a turn of paceRefusal), so refused
 *  statements cannot make this process fork faster than the pace. A second
 *  try forks at once: it is one fork per refused statement whose own child was
 *  paced, and waiting would let a waiter take its place past the cap. The
 *  count is close, not exact: a fork may pay and then find a free child. */
let refusalDebt = 0;
const busy = (waitMs: number) =>
  new AppSqlBusyError(
    `app SQL is busy: every SQL process was running a statement for ${waitMs} ms; try again`,
  );

/** The turn a fork owes for a refused child, if any, waiting at most `waitMs`. */
async function owedPace(waitMs: number): Promise<void> {
  if (refusalDebt === 0) return;
  refusalDebt--;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      paceRefusal(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(busy(waitMs)), waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** How long the server's copy of one app file may take (a 256 MB file
 *  copies in a few seconds; this leaves room for a slow disk). */
export const APP_DB_COPY_TIMEOUT_MS = 120_000;
/** A restore marker (`<file>.restoring`) older than this is a crash's
 *  leftover and is ignored. */
export const APP_DB_RESTORE_MARKER_TTL_MS = 5 * 60_000;
/** The WAL an app database keeps after a checkpoint (journal_size_limit). */
export const APP_SQL_JOURNAL_LIMIT_BYTES = 64 * 1024 * 1024;
/** Statements one caller may have waiting behind its running one; beyond it
 *  the next is refused as busy at once. */
export const APP_SQL_MAX_WAITING_PER_CALLER = 16;

/** The cap on one app's database file, in bytes: APP_SQL_MAX_DB_MB (default
 *  256), read at call time. */
export function appSqlMaxDbBytes(): number {
  return envNum('APP_SQL_MAX_DB_MB') * 1024 * 1024;
}

/** An error an app's own statement earned: its SQL, a refusal, a cap, the
 *  time limit or a busy pool. Its message is meant for the app author, and a
 *  broker shows it; any other error is the server's and is not shown. */
export class AppSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppSqlError';
  }
}

/** The pool, or this caller's turn, was not free in time: try again. */
export class AppSqlBusyError extends AppSqlError {
  constructor(message: string) {
    super(message);
    this.name = 'AppSqlBusyError';
  }
}

/** The app's database is being restored from a snapshot (a few seconds):
 *  try again. A busy error, so every broker answers 429 with retry-after. */
export class AppDbRestoringError extends AppSqlBusyError {
  constructor() {
    super("the app's data is being restored from a snapshot; try again in a few seconds");
    this.name = 'AppDbRestoringError';
  }
}

/** A write batch's guard read no row, or a first column of NULL or 0. Not a
 *  fault: an app's check said no, and nothing was written. */
export class AppDbGuardError extends AppSqlError {
  constructor() {
    super('the guard said no, so nothing was written');
    this.name = 'AppDbGuardError';
  }
}

/** Where a write batch stopped: a statement by its index, its guard, or its
 *  commit (a deferred foreign key, or a full-text index that met the file cap). */
export type AppSqlBatchPlace = number | 'guard' | 'commit';

/** A write batch failed at one place: nothing stayed, and the message says
 *  where. `at` names the statement for the app's error log. */
export class AppSqlBatchError extends AppSqlError {
  readonly at: AppSqlBatchPlace;
  constructor(at: AppSqlBatchPlace, total: number, message: string) {
    const where =
      at === 'guard' ? 'guard' : at === 'commit' ? 'at commit' : `statement ${at + 1} of ${total}`;
    super(`${where}: ${message}`);
    this.name = 'AppSqlBatchError';
    this.at = at;
  }
}

/** The app timers' run log in an app's own database (docs/app-timers.md):
 *  a reserved table. App SQL reads it; only the server's own timer batch
 *  (runAppTimerRunsBatch) creates or changes it. */
export const APP_TIMER_RUNS_TABLE = '_timer_runs';

/** The reserved table names, as the child matches them (SQLite's own
 *  unquoted name, case-insensitive as SQLite's lookup): the run log and
 *  every name it prefixes (a virtual table's shadow tables, its index). */
const RESERVED_TABLES_RE = /^_timer_runs($|_)/i;

/** The run log's DDL as the server writes it, which the timer batch holds
 *  the live table to (runAppTimerRunsBatch). */
export type AppTimerRunsDdl = { table: string; index: string; indexName: string };

/** The child: a plain CommonJS script passed with `-e`, so it needs no file
 *  on disk and runs the same in dev, in tests and in the image. */
const CHILD_SOURCE = `
const { DatabaseSync, constants: C } = require('node:sqlite');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
// A restore is swapping this file (its marker is fresh): open nothing.
function restoring(file) {
  try {
    return Date.now() - fs.statSync(file + '.restoring').mtimeMs < ${APP_DB_RESTORE_MARKER_TTL_MS};
  } catch {
    return false;
  }
}
process.title = 'mantle-app-sql';
// The parent is gone (exited or crashed): so is the reason to live. An idle
// child hears it here; in a statement it cannot, and its guard kills it.
process.on('disconnect', () => process.exit(0));
// About what a row costs once serialized: keys, values, a little framing.
function valueBytes(v) {
  if (v === null || v === undefined) return 4;
  if (typeof v === 'string') return Buffer.byteLength(v) + 2;
  if (v instanceof Uint8Array) return v.byteLength;
  return 8;
}
function rowBytes(row) {
  let n = 2;
  for (const k in row) n += k.length + 4 + valueBytes(row[k]);
  return n;
}
/** The text starts (after blanks and comments) with CREATE TABLE IF NOT
 *  EXISTS or CREATE [UNIQUE] INDEX IF NOT EXISTS: nothing else qualifies. */
function ifNotExistsCreate(sql) {
  let s = String(sql);
  for (;;) {
    const t = s.replace(/^\\s+/, '');
    if (t.startsWith('--')) {
      const nl = t.indexOf('\\n');
      s = nl < 0 ? '' : t.slice(nl + 1);
    } else if (t.startsWith('/*')) {
      const end = t.indexOf('*/');
      s = end < 0 ? '' : t.slice(end + 2);
    } else {
      s = t;
      break;
    }
  }
  return /^create\\s+(unique\\s+)?(table|index)\\s+if\\s+not\\s+exists\\b/i.test(s);
}
/** The reserved tables app text never changes (the app timers' run log):
 *  it reads them, the server alone writes them. */
function reservedName(name) {
  return ${RESERVED_TABLES_RE}.test(String(name || ''));
}
/** Whether an authorizer action changes a reserved table: a row write, its
 *  create (the name taken first, a virtual table too), drop, alter or
 *  rename, a view by its name, and a trigger or index on it (or dropped
 *  from it). A rename of another table ONTO the name is not seen here (the
 *  authorizer names the old one): the timer batch sets such a table aside. */
function touchesReserved(action, arg1, arg2) {
  switch (action) {
    case C.SQLITE_CREATE_VTABLE:
    case C.SQLITE_DROP_VTABLE:
    case C.SQLITE_INSERT:
    case C.SQLITE_UPDATE:
    case C.SQLITE_DELETE:
    case C.SQLITE_DROP_TABLE:
    case C.SQLITE_DROP_TEMP_TABLE:
    case C.SQLITE_CREATE_TABLE:
    case C.SQLITE_CREATE_TEMP_TABLE:
    case C.SQLITE_CREATE_VIEW:
    case C.SQLITE_CREATE_TEMP_VIEW:
    case C.SQLITE_DROP_VIEW:
    case C.SQLITE_DROP_TEMP_VIEW:
      return reservedName(arg1);
    case C.SQLITE_ALTER_TABLE:
    case C.SQLITE_CREATE_TRIGGER:
    case C.SQLITE_CREATE_TEMP_TRIGGER:
    case C.SQLITE_DROP_TRIGGER:
    case C.SQLITE_DROP_TEMP_TRIGGER:
    case C.SQLITE_CREATE_INDEX:
    case C.SQLITE_CREATE_TEMP_INDEX:
    case C.SQLITE_DROP_INDEX:
    case C.SQLITE_DROP_TEMP_INDEX:
      return reservedName(arg2);
    default:
      return false;
  }
}
/** A name as an SQL identifier. */
function ident(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}
/** The run log as the server makes it: the stored SQL of its table and its
 *  index (SQLite keeps the text, less IF NOT EXISTS). */
function timerRunsWant(ddl) {
  const m = new DatabaseSync(':memory:');
  try {
    m.exec(ddl.table);
    m.exec(ddl.index);
    const out = {};
    for (const r of m.prepare('SELECT name, sql FROM sqlite_master').all()) out[r.name] = r.sql;
    return out;
  } finally {
    m.close();
  }
}
/**
 * Before the server writes the run log, in the batch's own transaction and
 * with no app text running: the reserved objects are only the server's.
 * A trigger on the log (or named for it) and a view of its name are
 * dropped; a table of its name that is not the server's plain table (a
 * virtual table, another shape, one renamed onto the name, or one an
 * imported package brought) is moved aside to timer_runs_moved_<random>,
 * its rows kept for the app (a random name, so no object the app made
 * beforehand can stand in the way of the move); an index on the log that is
 * not the server's is dropped. A table in exactly the server's shape stays
 * as the log, whoever made it: the app can only fake rows of its own log.
 * Answers what it moved or dropped.
 */
function timerRunsSetRight(db, ddl) {
  const want = timerRunsWant(ddl);
  const T = '${APP_TIMER_RUNS_TABLE}';
  const isT = (n) => String(n || '').toLowerCase() === T;
  const all = () => db.prepare('SELECT type, name, tbl_name AS tbl, sql FROM main.sqlite_master').all();
  const done = [];
  for (const o of all()) {
    if (o.type === 'trigger' && (reservedName(o.tbl) || reservedName(o.name))) {
      db.exec('DROP TRIGGER ' + ident(o.name));
      done.push('trigger');
    } else if (o.type === 'view' && reservedName(o.name)) {
      db.exec('DROP VIEW ' + ident(o.name));
      done.push('view');
    }
  }
  const table = all().find((o) => o.type === 'table' && isT(o.name));
  if (table && table.sql !== want[T]) {
    const taken = new Set(all().map((o) => String(o.name).toLowerCase()));
    let moved;
    do moved = 'timer_runs_moved_' + randomBytes(6).toString('hex');
    while (taken.has(moved));
    db.exec('ALTER TABLE ' + ident(table.name) + ' RENAME TO ' + ident(moved));
    done.push('table');
  }
  for (const o of all()) {
    if (o.type !== 'index' || !isT(o.tbl) || o.sql === null) continue;
    if (o.name === ddl.indexName && o.sql === want[ddl.indexName]) continue;
    db.exec('DROP INDEX ' + ident(o.name));
    done.push('index');
  }
  return done;
}
/** The timer batch's authorizer: reads, and the run log's own create,
 *  index, insert and delete (with the schema rows a create writes).
 *  Nothing else, so a statement of the batch can reach no other table. */
function timerRunsAuthorizer(action, arg1, arg2) {
  const T = '${APP_TIMER_RUNS_TABLE}';
  const isT = (n) => String(n || '').toLowerCase() === T;
  const schema = /^sqlite_(master|schema)$/i.test(String(arg1 || ''));
  switch (action) {
    case C.SQLITE_READ:
    case C.SQLITE_SELECT:
    case C.SQLITE_FUNCTION:
    case C.SQLITE_RECURSIVE:
      return C.SQLITE_OK;
    case C.SQLITE_INSERT:
    case C.SQLITE_UPDATE:
      return isT(arg1) || schema ? C.SQLITE_OK : C.SQLITE_DENY;
    case C.SQLITE_DELETE:
      return isT(arg1) ? C.SQLITE_OK : C.SQLITE_DENY;
    case C.SQLITE_CREATE_TABLE:
      return isT(arg1) ? C.SQLITE_OK : C.SQLITE_DENY;
    case C.SQLITE_CREATE_INDEX:
      return isT(arg2) ? C.SQLITE_OK : C.SQLITE_DENY;
    case C.SQLITE_REINDEX:
      // A new index of the log is built as it is made.
      return reservedName(arg1) ? C.SQLITE_OK : C.SQLITE_DENY;
    default:
      return C.SQLITE_DENY;
  }
}
/** The one PRAGMA a statement may reach: FTS5 asks for data_version on its own (a
 *  small number on a connection this job opened), so a full-text table reads and
 *  writes under every rule. Nothing else about the engine or the file. */
function ftsPragma(action, arg1) {
  return action === C.SQLITE_PRAGMA && String(arg1 || '').toLowerCase() === 'data_version';
}
/** fts3_tokenizer, on any file: it hands a raw memory address to a bound name,
 *  and takes a tokenizer's address from a bound value. No app has a use for either. */
function tokenizerCall(action, arg2) {
  return action === C.SQLITE_FUNCTION && String(arg2 || '').toLowerCase() === 'fts3_tokenizer';
}
/** A write batch's guard: reads only. */
function readRule(action, arg1, arg2) {
  if (tokenizerCall(action, arg2)) return C.SQLITE_DENY;
  if (ftsPragma(action, arg1)) return C.SQLITE_OK;
  return action === C.SQLITE_READ ||
    action === C.SQLITE_SELECT ||
    action === C.SQLITE_FUNCTION ||
    action === C.SQLITE_RECURSIVE
    ? C.SQLITE_OK
    : C.SQLITE_DENY;
}
/** Whether what the engine left unread after a statement is only blanks,
 *  semicolons and comments. */
function nothingLeft(tail) {
  for (let i = 0; i < tail.length; ) {
    if (' \\t\\n\\f\\r;'.includes(tail[i])) {
      i++;
    } else if (tail.startsWith('--', i)) {
      const end = tail.indexOf('\\n', i);
      i = end < 0 ? tail.length : end + 1;
    } else if (tail.startsWith('/*', i)) {
      const end = tail.indexOf('*/', i + 2);
      i = end < 0 ? tail.length : end + 2;
    } else {
      return false;
    }
  }
  return true;
}
/** Prepare one entry of a batch. SQLite prepares the first statement of a text
 *  and ignores the rest with no error, so a second one would be lost in silence.
 *  sourceSQL is the text the engine read: what is left of the entry is exactly
 *  what it would drop, whatever a scan of the text may think. */
function prepareOne(db, sql) {
  const prepared = db.prepare(sql);
  const text = String(sql);
  const read = String(prepared.sourceSQL);
  if (!text.startsWith(read)) {
    throw new Error('the database did not read this text as written: check it for broken characters');
  }
  if (!nothingLeft(text.slice(read.length))) {
    throw new Error('one statement per entry: remove the text after the ";"');
  }
  return prepared;
}
/** SQLITE_BUSY, by SQLite's code or the words of its one message. Read only
 *  at BEGIN, where no app text has run: a trigger can RAISE any text. */
function writeLockTaken(err) {
  return (
    (err && typeof err.errcode === 'number' && (err.errcode & 0xff) === 5) ||
    /database is locked/i.test(String(err && err.message))
  );
}
/**
 * An app's write batch (runAppDataBatch): the guard, then the statements, in
 * one transaction. BEGIN, COMMIT and ROLLBACK are the server's, so the data-only
 * rule is off for them alone (it refuses all three, and any an author sends
 * stays refused). BEGIN IMMEDIATE comes first, so the guard reads under the
 * write lock with no gap. A statement that ends the transaction itself (a
 * trigger's RAISE(ROLLBACK), INSERT OR ROLLBACK) also throws, so the loop stops.
 */
function dataBatch(db, job, rule) {
  db.setAuthorizer(null);
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    if (writeLockTaken(err)) err.reason = 'busy';
    throw err;
  }
  let at = 'guard';
  try {
    if (job.guard) {
      db.setAuthorizer(readRule);
      const guard = prepareOne(db, job.guard.sql);
      // By position: in an object, two columns of one name are one, and a
      // name like "1" sorts first.
      guard.setReturnArrays(true);
      const row = guard.get(...job.guard.params);
      // == null: Bun answers null for no row.
      const first = row == null ? null : row[0];
      if (first == null || first === 0) {
        const refused = new Error('guard');
        refused.reason = 'guard';
        throw refused;
      }
    }
    db.setAuthorizer(rule);
    const changes = [];
    for (at = 0; at < job.statements.length; at++) {
      const st = job.statements[at];
      changes.push(Number(prepareOne(db, st.sql).run(...st.params).changes));
    }
    at = 'commit';
    // COMMIT is the server's, but a full-text index flushes here and that can
    // fire a trigger, so the rule stays on for everything else.
    db.setAuthorizer((action, arg1, arg2) =>
      action === C.SQLITE_TRANSACTION ? C.SQLITE_OK : rule(action, arg1, arg2),
    );
    db.exec('COMMIT');
    return { changes };
  } catch (err) {
    db.setAuthorizer(null);
    try {
      db.exec('ROLLBACK');
    } catch {
      // already rolled back by the failing statement
    }
    err.at = at;
    throw err;
  }
}
function run(job) {
  const { file, sql, params, mode, readOnly, dataOnly, maxRows, maxLength, maxReplyBytes, maxDbBytes, journalLimit, userVersion, dest } = job;
  if (mode !== 'copy' && mode !== 'adopt' && restoring(file)) {
    const refused = new Error('restoring');
    refused.reason = 'restoring';
    throw refused;
  }
  if (mode === 'copy') {
    // The server's own copy of an app's file (a schema trial run, a
    // snapshot): VACUUM INTO from a read-only open, a consistent copy under
    // WAL. Never reachable from app SQL: the parent alone picks the mode and
    // the destination, and no authorizer is set because no app text runs.
    const src = new DatabaseSync(file, { readOnly: true, defensive: true });
    try {
      src.exec('PRAGMA busy_timeout = 5000');
      src.exec("VACUUM INTO '" + String(dest).replace(/'/g, "''") + "'");
    } finally {
      src.close();
    }
    return null;
  }
  if (mode === 'adopt') {
    // A database file from outside (an app package import, app-package.ts):
    // checked whole, then copied clean to dest. No view or trigger of the file
    // runs: the checks read pages and call an index's own check, VACUUM INTO
    // copies the schema as text, and trusted_schema off keeps its views and
    // triggers from calling functions while it is read. Defensive refuses a
    // trigger on an index's own tables only when the index loads first, so the
    // query below refuses the other order. The parent picks the file (its own
    // temp copy).
    const src = new DatabaseSync(file, { defensive: true });
    try {
      src.exec('PRAGMA trusted_schema = OFF');
      const check = src.prepare('PRAGMA quick_check').all();
      const first = check[0] ? String(Object.values(check[0])[0]) : 'no answer';
      if (check.length !== 1 || first !== 'ok') {
        throw new Error('the database file is damaged (' + first.slice(0, 200) + ')');
      }
      const onIndex = src
        .prepare(
          "SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND tbl_name COLLATE NOCASE IN (SELECT name FROM pragma_table_list WHERE type = 'shadow')",
        )
        .all();
      if (onIndex.length > 0) {
        throw new Error('the database file has a trigger on a search index table');
      }
      const userVersion = Number(src.prepare('PRAGMA user_version').get().user_version);
      src.exec("VACUUM INTO '" + String(dest).replace(/'/g, "''") + "'");
      return { userVersion };
    } finally {
      src.close();
    }
  }
  // Defensive: no text writes a full-text table's own tables or the schema table
  // by hand. The default today, and not left to a default.
  const db = new DatabaseSync(file, { readOnly, defensive: true, limits: { length: maxLength } });
  try {
    // Connection settings first: the authorizer below refuses app PRAGMAs.
    db.exec('PRAGMA busy_timeout = ' + (mode === 'dataBatch' ? ${APP_SQL_BATCH_BUSY_MS} : 5000));
    if (!readOnly) {
      try {
        db.exec('PRAGMA journal_mode = WAL');
      } catch (err) {
        // A file not yet in WAL takes the lock here, before any app text.
        if (mode === 'dataBatch' && writeLockTaken(err)) err.reason = 'busy';
        throw err;
      }
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA journal_size_limit = ' + Number(journalLimit));
      // The file cap: a write that would grow the file past it fails with
      // SQLITE_FULL and rolls back. (A file already past it keeps its size.)
      const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
      db.exec('PRAGMA max_page_count = ' + Math.max(1, Math.floor(maxDbBytes / pageSize)));
    }
    // A schema script stamps its version into the file (user_version, which
    // the authorizer keeps apps from touching). A file already at or past it
    // got this script before, and only the registry update was lost (a crash
    // between the two): running it again would fail on "already exists".
    if (mode === 'script' && userVersion > 0) {
      const have = Number(db.prepare('PRAGMA user_version').get().user_version);
      if (have >= userVersion) return { skipped: true, userVersion: have };
    }
    if (mode === 'timer') {
      // The app timers' run log (runAppTimerRunsBatch): the server's own
      // statements, all or nothing, after the reserved objects are set
      // right, under an authorizer that admits only the log's own writes.
      //
      // Two connection settings first, outside the transaction (SQLite
      // ignores foreign_keys inside one): the app's schema must not be able
      // to stop the server's writes. foreign_keys OFF, so an app table with
      // a foreign key to the log (cascading or not) neither refuses the
      // prune nor turns it into a delete in the app's own tables (which the
      // authorizer would refuse); legacy_alter_table ON, so moving a table
      // aside renames that table alone, without re-reading every view and
      // trigger of the file (a broken view of the app's would fail it).
      // This connection is the job's own and closed after it; the settings
      // are put back all the same.
      const changes = [];
      let setRight;
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('PRAGMA legacy_alter_table = ON');
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          setRight = timerRunsSetRight(db, job.timerDdl);
          db.setAuthorizer(timerRunsAuthorizer);
          for (const st of job.statements) changes.push(Number(db.prepare(st.sql).run(...st.params).changes));
          db.setAuthorizer(null);
          db.exec('COMMIT');
        } catch (err) {
          db.setAuthorizer(null);
          try {
            db.exec('ROLLBACK');
          } catch {
            // already rolled back by the failing statement
          }
          throw err;
        }
      } finally {
        db.exec('PRAGMA legacy_alter_table = OFF');
        db.exec('PRAGMA foreign_keys = ON');
      }
      return { changes, setRight };
    }
    // Rows only, with one exception (team apps M3 re-audit, live apps on the
    // fleet): CREATE TABLE / CREATE INDEX IF NOT EXISTS on an object that
    // already EXISTS in main is answered as a no-op success and never run.
    // SQLite asks the authorizer for a table before it looks for it, so the
    // statement is prepared once with an authorizer that only records, and
    // never stepped; the name it records is SQLite's own (unquoted), and the
    // lookup is case-insensitive as SQLite's own. A missing object, a TEMP
    // or other-schema create, a create without IF NOT EXISTS, or any other
    // action falls through to the deny authorizer below.
    if (dataOnly && mode === 'run' && ifNotExistsCreate(sql)) {
      const seen = [];
      db.setAuthorizer((action, arg1, arg2, dbName) => {
        seen.push([action, arg1, arg2, dbName]);
        return C.SQLITE_OK;
      });
      let prepared = false;
      try {
        db.prepare(sql);
        prepared = true;
      } catch {
        prepared = false;
      } finally {
        db.setAuthorizer(null);
      }
      const creates = seen.filter(
        (a) => a[0] === C.SQLITE_CREATE_TABLE || a[0] === C.SQLITE_CREATE_INDEX,
      );
      const others = seen.filter(
        (a) =>
          !(
            a[0] === C.SQLITE_CREATE_TABLE ||
            a[0] === C.SQLITE_CREATE_INDEX ||
            a[0] === C.SQLITE_READ ||
            a[0] === C.SQLITE_SELECT ||
            a[0] === C.SQLITE_FUNCTION ||
            (a[0] === C.SQLITE_INSERT && /^sqlite_(master|schema)$/i.test(String(a[1] || '')))
          ),
      );
      if (prepared && creates.length === 1 && others.length === 0 && creates[0][3] === 'main') {
        const isTable = creates[0][0] === C.SQLITE_CREATE_TABLE;
        const found = db
          .prepare(
            isTable
              ? "SELECT 1 AS one FROM main.sqlite_master WHERE type IN ('table', 'view') AND name = ? COLLATE NOCASE"
              : "SELECT 1 AS one FROM main.sqlite_master WHERE type = 'index' AND name = ? COLLATE NOCASE",
          )
          .get(String(creates[0][1] || ''));
        if (found) return { changes: 0, lastInsertRowid: 0 };
      }
    }
    let transactionAsked = false;
    const rule = (action, arg1, arg2) => {
      // The reserved tables (the app timers' _timer_runs and its prefix):
      // app text and the server's other jobs read them and never change
      // them, whatever else the job allows (the timer batch has its own
      // authorizer, above). Before the data-only rule, so that rule's row
      // writes do not reach them either.
      if (touchesReserved(action, arg1, arg2)) return C.SQLITE_DENY;
      if (tokenizerCall(action, arg2)) return C.SQLITE_DENY;
      if (ftsPragma(action, arg1)) return C.SQLITE_OK;
      // A statement of its own (host.db.exec), for every caller: this job's
      // connection closes after it, so a BEGIN holds nothing. It would answer
      // yes, the next call would commit by itself, and a ROLLBACK would then
      // fail with those rows kept. host.db.batch is the transaction.
      if (mode === 'run' && (action === C.SQLITE_TRANSACTION || action === C.SQLITE_SAVEPOINT)) {
        transactionAsked = true;
        return C.SQLITE_DENY;
      }
      // Data only (an MCP write to an app's data): rows, never the
      // schema. An allowlist: reading, selecting, functions, a recursive
      // CTE, the three row writes and FTS5's one pragma above. Every CREATE, DROP, ALTER, trigger,
      // view, index, transaction, savepoint, ANALYZE and REINDEX is refused,
      // and so is a row write into the schema table itself (SQLite refuses
      // that too, without writable_schema; this does not lean on it).
      if (dataOnly) {
        if (action === C.SQLITE_INSERT || action === C.SQLITE_UPDATE || action === C.SQLITE_DELETE) {
          return /^sqlite_(temp_)?(master|schema)$/i.test(String(arg1 || ''))
            ? C.SQLITE_DENY
            : C.SQLITE_OK;
        }
        return action === C.SQLITE_READ ||
          action === C.SQLITE_SELECT ||
          action === C.SQLITE_FUNCTION ||
          action === C.SQLITE_RECURSIVE
          ? C.SQLITE_OK
          : C.SQLITE_DENY;
      }
      if (action === C.SQLITE_ATTACH || action === C.SQLITE_DETACH) return C.SQLITE_DENY;
      if (action === C.SQLITE_PRAGMA) {
        const name = String(arg1 || '').toLowerCase();
        return name === 'table_info' || name === 'table_xinfo' ? C.SQLITE_OK : C.SQLITE_DENY;
      }
      return C.SQLITE_OK;
    };
    db.setAuthorizer(rule);
    if (mode === 'dataBatch') return dataBatch(db, job, rule);
    if (mode === 'script') {
      // All or nothing: SQLite DDL is transactional, so a script that fails on
      // statement 3 leaves nothing of 1 and 2 behind.
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(sql);
        if (userVersion > 0) {
          // The app's statements have run; the stamp is the server's own.
          db.setAuthorizer(null);
          db.exec('PRAGMA user_version = ' + Math.floor(Number(userVersion)));
          // A full-text index flushes at COMMIT, under the rule.
          db.setAuthorizer(rule);
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // already rolled back by the failing statement
        }
        throw err;
      }
      return { skipped: false, userVersion: userVersion > 0 ? userVersion : 0 };
    }
    if (mode === 'batch') {
      // The server's own write batch (an authoring-time seed): its statements
      // run all or nothing, under the same authorizer and caps.
      const stmts = new Map();
      const changes = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const st of job.statements) {
          let prepared = stmts.get(st.sql);
          if (!prepared) {
            prepared = db.prepare(st.sql);
            stmts.set(st.sql, prepared);
          }
          changes.push(Number(prepared.run(...st.params).changes));
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // already rolled back by the failing statement
        }
        throw err;
      }
      return { changes };
    }
    if (mode === 'run') {
      let prepared;
      try {
        prepared = db.prepare(sql);
      } catch (err) {
        throw transactionAsked
          ? new Error('not authorized: each call has its own connection, so a transaction cannot span calls; use host.db.batch')
          : err;
      }
      const r = prepared.run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    }
    const rows = [];
    let bytes = 0;
    for (const row of db.prepare(sql).iterate(...params)) {
      if (rows.length >= maxRows) {
        throw new Error('the query returned more than ' + maxRows + ' rows: add a LIMIT or aggregate in SQL');
      }
      bytes += rowBytes(row);
      if (bytes > maxReplyBytes) {
        throw new Error('the query returned more than ' + Math.round(maxReplyBytes / 1048576) + ' MB: add a LIMIT, select fewer columns or aggregate in SQL');
      }
      rows.push(row);
    }
    return rows;
  } finally {
    // This child lives on for the next statement: close, error or not.
    db.close();
  }
}
process.on('message', (job) => {
  let reply;
  try {
    reply = { id: job.id, ok: true, result: run(job) };
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    // SQLite's own code (SQLITE_NOMEM), then the engine's own error on Bun.
    // Never the text alone: a trigger can RAISE any text it likes.
    const nomem = (err && typeof err.errcode === 'number' && (err.errcode & 0xff) === 7) ||
      (err instanceof RangeError && /^out of memory$/i.test(error));
    reply = nomem
      ? { id: job.id, ok: false, error: ${JSON.stringify(OUT_OF_MEMORY)}, spent: true }
      : { id: job.id, ok: false, error, reason: err && err.reason, at: err && err.at };
  }
  process.send(reply);
});
// It runs: an exit from here on is not a start-up failure.
process.send(${JSON.stringify(CHILD_READY)});
`;

/** What the child sees of the environment: enough for SQLite (temp files,
 *  and TZ for the 'localtime' date modifier), none of the server's secrets. */
function childEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'TMPDIR', 'SQLITE_TMPDIR', 'TZ', 'LANG', 'LC_ALL']) {
    const v = envDynamic(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** `spent`: the child met the memory limit, so it does not serve again. */
type Reply =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: string;
      spent?: boolean;
      /** A refusal set only by the child's own code: never read from the
       *  error's words, which a trigger can RAISE. */
      reason?: 'restoring' | 'guard' | 'busy';
      /** Where a write batch failed. */
      at?: AppSqlBatchPlace;
    };
type Child = {
  proc: ChildProcess;
  /** False once the process has exited. */
  alive: boolean;
  /** Said it runs (CHILD_READY): an exit before it is a start-up failure. */
  started: boolean;
  /** Being killed: never handed out again. */
  doomed: boolean;
  /** Has answered a statement, so what it freed still counts on its limit. */
  used: boolean;
  /** Answers the statement it is running, if any. */
  onReply?: (r: Reply & { id?: number }) => void;
  idleTimer?: ReturnType<typeof setTimeout>;
};

const children = new Set<Child>();
const idle: Child[] = [];
const waiting: ((c: Child) => void)[] = [];

function forkChild(): Child {
  const { command, args } = withMemoryLimit(APP_SQL_CHILD_MEMORY_MB, {
    command: process.execPath,
    args: [...runtimeFlags(), '--input-type=commonjs', '-e', CHILD_SOURCE],
  });
  const proc = spawn(command, args, {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    // Structured clone, so a BLOB comes back as bytes, as it did from a worker.
    serialization: 'advanced',
    env: childEnv(),
  });
  killWithParent(proc);
  const child: Child = { proc, alive: true, started: false, doomed: false, used: false };
  children.add(child);
  // An idle pool must not keep the server (or a test run) from exiting; a
  // running statement's own timer holds the event loop while it waits. Bun's
  // channel has no unref.
  proc.unref();
  proc.channel?.unref?.();
  proc.on('message', (m: (Reply & { id?: number }) | typeof CHILD_READY) => {
    if (m === CHILD_READY) {
      child.started = true;
      return;
    }
    const onReply = child.onReply;
    child.onReply = undefined;
    onReply?.(m);
  });
  const gone = (why: string, crashed = false) => {
    if (!child.alive) return;
    child.alive = false;
    children.delete(child);
    const at = idle.indexOf(child);
    if (at >= 0) idle.splice(at, 1);
    if (child.idleTimer) clearTimeout(child.idleTimer);
    const onReply = child.onReply;
    child.onReply = undefined;
    onReply?.({ ok: false, error: why, spent: crashed });
    // A statement waiting for a free child gets the slot this one held, while
    // the pool is under its cap: at once, or after the turn a fork owes for a
    // refused child. A fork that throws here reaches no caller, so that waiter
    // goes back to the front of the line.
    const serveWaiter = () => {
      const next = livePlaces(children) < APP_SQL_MAX_CHILDREN ? waiting.shift() : undefined;
      if (!next) return;
      try {
        next(forkChild());
      } catch (err) {
        waiting.unshift(next);
        console.warn(`[app-sql] no new SQL process: ${errorMessage(err)}`);
      }
    };
    if (waiting.length === 0) return;
    if (refusalDebt > 0) {
      refusalDebt--;
      void paceRefusal().then(serveWaiter);
    } else {
      serveWaiter();
    }
  };
  proc.once('exit', (code, signal) => {
    const how = signal ?? `code ${code}`;
    switch (childEnd(code, signal, child.started, child.doomed)) {
      case 'no-start':
        return gone(
          `the SQL process did not start (${how}); its memory limit may be too small for this runtime`,
        );
      case 'crashed':
        return gone(CRASHED, true);
      case 'killed':
        return gone(
          `the SQL process was killed (${how}) before it answered; the server may be short of memory`,
        );
      default:
        return gone(`the SQL process exited (${how}) before it answered`);
    }
  });
  // on, not once: a failed spawn and a failed send can each raise one, and an
  // 'error' with no listener would take the whole server down.
  proc.on('error', (err) => {
    gone(`the SQL process failed: ${errorMessage(err)}`);
    proc.kill('SIGKILL');
  });
  return child;
}

/** An idle child that still runs, if any. */
function idleChild(): Child | undefined {
  for (let c = idle.pop(); c; c = idle.pop()) {
    clearTimeout(c.idleTimer);
    c.idleTimer = undefined;
    // Died while idle and its exit not yet seen: skip it.
    if (c.proc.connected) return c;
    void kill(c);
  }
  return undefined;
}

/** A free child: an idle one, a new one while under the cap, else the next
 *  one to come free, waiting at most `waitMs` in all. */
async function acquire(waitMs: number): Promise<Child> {
  const deadline = performance.now() + waitMs;
  const free = idleChild();
  if (free) return free;
  await owedPace(waitMs);
  // A child may have come free while this one waited its turn.
  const freed = idleChild();
  if (freed) return freed;
  // children.size, not livePlaces: a child being killed still holds memory,
  // so a new one waits until it is gone (at most kill's 2 s). Counting only
  // live ones here would raise the most processes there can be.
  if (children.size < APP_SQL_MAX_CHILDREN) return forkChild();
  const left = Math.max(0, deadline - performance.now());
  return new Promise((resolve, reject) => {
    const take = (child: Child) => {
      clearTimeout(timer);
      resolve(child);
    };
    const timer = setTimeout(() => {
      const at = waiting.indexOf(take);
      if (at >= 0) waiting.splice(at, 1);
      reject(busy(waitMs));
    }, left);
    waiting.push(take);
  });
}

function release(c: Child): void {
  if (!c.alive || c.doomed) return;
  // Second tries took places past the cap: give them back. A child being
  // killed holds no place, so a refusal never costs a healthy child its own.
  if (livePlaces(children) > APP_SQL_MAX_CHILDREN) return void kill(c);
  const next = waiting.shift();
  if (next) return next(c);
  c.idleTimer = setTimeout(() => {
    idle.splice(idle.indexOf(c), 1);
    c.doomed = true;
    c.proc.kill();
  }, APP_SQL_CHILD_IDLE_MS);
  c.idleTimer.unref();
  idle.push(c);
}

/** SIGKILL a child and wait until it is gone, so its locks are released
 *  before the caller hears of the timeout and tries the next write. */
function kill(c: Child): Promise<void> {
  c.doomed = true;
  if (!c.alive) return Promise.resolve();
  return new Promise((resolve) => {
    const cap = setTimeout(resolve, 2_000);
    c.proc.once('exit', () => {
      clearTimeout(cap);
      resolve();
    });
    c.proc.kill('SIGKILL');
  });
}

let nextId = 0;

/** Each caller's turn: whether one of its statements runs, and who waits. */
const callers = new Map<string, { waiting: (() => void)[] }>();

/** Take `key`'s turn: at once when none of its statements runs, else after
 *  the ones ahead of it, waiting at most `waitMs`. Returns the release. */
function takeTurn(key: string, waitMs: number): Promise<() => void> {
  const release = () => {
    const turn = callers.get(key);
    const next = turn?.waiting.shift();
    if (next) next();
    else callers.delete(key);
  };
  const turn = callers.get(key);
  if (!turn) {
    callers.set(key, { waiting: [] });
    return Promise.resolve(release);
  }
  if (turn.waiting.length >= APP_SQL_MAX_WAITING_PER_CALLER) {
    return Promise.reject(
      new AppSqlBusyError(
        `too many statements at once: this app sent ${APP_SQL_MAX_WAITING_PER_CALLER + 1} statements before the first finished; run them one after another`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const go = () => {
      clearTimeout(timer);
      resolve(release);
    };
    const timer = setTimeout(() => {
      const at = turn.waiting.indexOf(go);
      if (at >= 0) turn.waiting.splice(at, 1);
      reject(
        new AppSqlBusyError(
          `app SQL is busy: this app's earlier statements ran for ${waitMs} ms; try again`,
        ),
      );
    }, waitMs);
    turn.waiting.push(go);
  });
}

/** Run `sql` with `params`: mode 'all' returns rows, 'run' returns
 *  `{ changes, lastInsertRowid }`, 'script' runs several statements (no
 *  params) in one transaction and returns `{ skipped, userVersion }`: with
 *  `userVersion`, the script stamps it into the file, and a file already at
 *  or past it skips the script. Rejects with an AppSqlError
 *  on SQL error, a refused statement, a row, size or file cap, the time
 *  limit, or a busy pool or caller (AppSqlBusyError). With `callerKey`, the
 *  statement waits for that caller's earlier ones (at most twice its time
 *  limit). */
export async function runAppSql(
  file: string,
  opts: {
    sql: string;
    params?: unknown[];
    mode: 'all' | 'run' | 'script';
    readOnly: boolean;
    timeoutMs?: number;
    /** Who asks ('client:<login>', 'member:<login>', 'share:<id>'). */
    callerKey?: string;
    /** The file cap in bytes; default appSqlMaxDbBytes(). */
    maxDbBytes?: number;
    /** 'script' only: the schema version the script brings the file to. */
    userVersion?: number;
    /** Rows only, never the schema (an MCP write): the engine authorizer
     *  allows reads, INSERT, UPDATE, DELETE and the data_version FTS5 asks
     *  for, and refuses the rest. */
    dataOnly?: boolean;
  },
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? APP_SQL_TIMEOUT_MS;
  if (opts.mode === 'script' && opts.readOnly)
    throw new Error('a schema script needs a writable open');
  if (opts.mode === 'script' && opts.dataOnly)
    throw new Error('a schema script cannot be data only');
  if (!opts.callerKey) return runOnChild(file, opts, timeoutMs);
  const endTurn = await takeTurn(opts.callerKey, timeoutMs * 2);
  try {
    return await runOnChild(file, opts, timeoutMs);
  } finally {
    endTurn();
  }
}

/** One statement of a server write batch. */
export type AppSqlBatchStatement = { sql: string; params: unknown[] };

/** A job for a child: an app statement, or the server's own file copy or
 *  write batch. */
type ChildJob = Omit<Parameters<typeof runAppSql>[1], 'mode'> & {
  mode: 'all' | 'run' | 'script' | 'copy' | 'batch' | 'dataBatch' | 'adopt' | 'timer';
  /** 'copy' and 'adopt' only: the file to write (must not exist). */
  dest?: string;
  /** 'batch', 'dataBatch' and 'timer' only: the statements, run in one
   *  transaction. */
  statements?: AppSqlBatchStatement[];
  /** 'dataBatch' only: one read under the write lock; no truth, no write. */
  guard?: AppSqlBatchStatement;
  /** 'timer' only: the run log's DDL the live table is held to. */
  timerDdl?: AppTimerRunsDdl;
};

/**
 * Run the server's own statements against an app's file in ONE transaction,
 * in a SQL child, under the same authorizer, caps and time limit as app SQL
 * (never on the main thread).
 * Returns each statement's change count. Nothing stays when one fails.
 */
export async function runAppSqlBatch(
  file: string,
  statements: AppSqlBatchStatement[],
  timeoutMs = APP_SCHEMA_TIMEOUT_MS,
): Promise<number[]> {
  const res = (await runOnChild(
    file,
    { sql: '', mode: 'batch', readOnly: false, statements },
    timeoutMs,
  )) as { changes: number[] };
  return res.changes;
}

/**
 * An app's own write call (host.db.batch) in ONE transaction, in a SQL child:
 * rows only for every caller (the data-only rule), the caller's turn taken as
 * for one statement, and the one time limit for the whole batch, the wait at
 * BEGIN included. `guard`, when given, is one read under the write lock: it
 * passes only when its first row's first column is not NULL and not 0, else
 * AppDbGuardError. A failed statement throws AppSqlBatchError, another writer
 * holding the lock AppSqlBusyError. Nothing stays in any of them. Answers each
 * statement's change count.
 */
export async function runAppDataBatch(
  file: string,
  statements: AppSqlBatchStatement[],
  opts: {
    guard?: AppSqlBatchStatement;
    callerKey?: string;
    timeoutMs?: number;
    maxDbBytes?: number;
  } = {},
): Promise<number[]> {
  const timeoutMs = opts.timeoutMs ?? APP_SQL_TIMEOUT_MS;
  const job: ChildJob = {
    sql: '',
    mode: 'dataBatch',
    readOnly: false,
    dataOnly: true,
    statements,
    ...(opts.guard ? { guard: opts.guard } : {}),
    ...(opts.maxDbBytes !== undefined ? { maxDbBytes: opts.maxDbBytes } : {}),
  };
  const endTurn = opts.callerKey ? await takeTurn(opts.callerKey, timeoutMs * 2) : null;
  try {
    const res = (await runOnChild(file, job, timeoutMs)) as { changes: number[] };
    return res.changes;
  } finally {
    endTurn?.();
  }
}

/**
 * The app timers' own write batch (packages/content app-broker.ts
 * appTimerRecordRun), the only job that may change the reserved run log
 * (APP_TIMER_RUNS_TABLE). In one transaction: first the reserved objects
 * are set right (timerRunsSetRight in the child: a planted trigger or view
 * dropped, a table of the name that is not the server's `ddl` moved aside
 * with its rows, a foreign index dropped), then the statements run under
 * an authorizer that admits only the log's own create, index, insert and
 * delete. Its statements are the server's, never app text. Answers the
 * change counts and what was set right.
 */
export async function runAppTimerRunsBatch(
  file: string,
  statements: AppSqlBatchStatement[],
  ddl: AppTimerRunsDdl,
  timeoutMs = APP_SCHEMA_TIMEOUT_MS,
): Promise<{ changes: number[]; setRight: string[] }> {
  return (await runOnChild(
    file,
    { sql: '', mode: 'timer', readOnly: false, statements, timerDdl: ddl },
    timeoutMs,
  )) as { changes: number[]; setRight: string[] };
}

/**
 * Copy an app's database file to `dest` (which must not exist) in a SQL child,
 * off the event loop: `VACUUM INTO` from a read-only open, a consistent and
 * compacted copy even while the app writes. The server's own step (schema
 * trial runs, snapshots); app SQL can never reach it.
 */
export async function copyAppDbFile(
  file: string,
  dest: string,
  timeoutMs = APP_DB_COPY_TIMEOUT_MS,
): Promise<void> {
  await runOnChild(file, { sql: '', mode: 'copy', readOnly: true, dest }, timeoutMs);
}

/**
 * Check a database file that came from outside (an app package import) and
 * copy it clean to `dest` (which must not exist), in a SQL child: the file
 * must pass SQLite's quick_check, and `VACUUM INTO` writes a fresh,
 * compacted copy. Throws AppSqlError when the file is not a sound SQLite
 * database. Returns the file's user_version (the schema stamp).
 */
export async function adoptAppDbFile(
  file: string,
  dest: string,
  timeoutMs = APP_DB_COPY_TIMEOUT_MS,
): Promise<{ userVersion: number }> {
  return (await runOnChild(file, { sql: '', mode: 'adopt', readOnly: false, dest }, timeoutMs)) as {
    userVersion: number;
  };
}

async function runOnChild(file: string, opts: ChildJob, timeoutMs: number): Promise<unknown> {
  const child = await acquire(timeoutMs);
  const used = child.used;
  let reply = await answer(child, file, opts, timeoutMs);
  // A child that served before can fail at the memory limit where a new one
  // passes: what it freed still counts. A read runs once more, always on a new
  // child, whose answer is the last. So a read can take two time limits, and
  // its wait for a child. A write does not run again: it may have landed.
  if (!reply.ok && reply.spent && used && opts.mode === 'all' && opts.readOnly) {
    try {
      reply = await answer(forkChild(), file, opts, timeoutMs);
    } catch {
      // No new process: the first answer stands.
    }
  }
  if (!reply.ok) {
    if (reply.reason === 'restoring') throw new AppDbRestoringError();
    if (reply.reason === 'guard') throw new AppDbGuardError();
    if (reply.reason === 'busy') {
      throw new AppSqlBusyError("another write holds the app's database; nothing was written");
    }
    if (reply.at !== undefined) {
      throw new AppSqlBatchError(reply.at, opts.statements?.length ?? 0, reply.error);
    }
    throw new AppSqlError(reply.error);
  }
  return reply.result;
}

/** One job on one child, and the child back in the pool, or out of it when it
 *  met the memory limit. */
async function answer(
  child: Child,
  file: string,
  opts: ChildJob,
  timeoutMs: number,
): Promise<Reply> {
  // A spawn that failed, or a child that died before it was handed out.
  if (!child.alive) return { ok: false, error: 'the SQL process did not start' };
  const id = ++nextId;
  const reply = await new Promise<Reply>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.onReply = undefined;
      // The whole process goes, and its connection and locks with it.
      void kill(child).then(() =>
        resolve({
          ok: false,
          error:
            opts.mode === 'dataBatch'
              ? `the batch ran longer than ${timeoutMs} ms and was stopped. It may have landed just before that, so read before you try again, and split the work into smaller batches`
              : `the statement ran longer than ${timeoutMs} ms and was stopped: narrow it (add WHERE or LIMIT, avoid unbounded recursion)`,
        }),
      );
    }, timeoutMs);
    child.onReply = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (r.id !== undefined && r.id !== id) {
        // Never expected (one statement per child at a time): replace the
        // child rather than answer with another statement's result.
        void kill(child);
        return resolve({ ok: false, error: 'the SQL process answered out of turn' });
      }
      resolve(r);
    };
    try {
      child.proc.send({
        id,
        file,
        sql: opts.sql,
        params: opts.params ?? [],
        mode: opts.mode,
        readOnly: opts.readOnly,
        dataOnly: opts.dataOnly === true,
        maxRows: APP_SQL_MAX_ROWS,
        maxLength: APP_SQL_MAX_LENGTH,
        maxReplyBytes: APP_SQL_MAX_REPLY_BYTES,
        maxDbBytes: opts.maxDbBytes ?? appSqlMaxDbBytes(),
        journalLimit: APP_SQL_JOURNAL_LIMIT_BYTES,
        userVersion: opts.mode === 'script' ? Math.max(0, Math.floor(opts.userVersion ?? 0)) : 0,
        dest: opts.mode === 'copy' || opts.mode === 'adopt' ? opts.dest : undefined,
        statements:
          opts.mode === 'batch' || opts.mode === 'dataBatch' || opts.mode === 'timer'
            ? opts.statements
            : undefined,
        guard: opts.mode === 'dataBatch' ? opts.guard : undefined,
        timerDdl: opts.mode === 'timer' ? opts.timerDdl : undefined,
      });
    } catch {
      // A child that failed to spawn has no send.
      child.onReply?.({ ok: false, error: 'the SQL process did not start' });
    }
  });
  child.used = true;
  if (!reply.ok && reply.spent) {
    void kill(child);
    // Its replacement waits its turn (owedPace).
    refusalDebt = Math.min(refusalDebt + 1, 2 * APP_SQL_MAX_CHILDREN);
  }
  release(child);
  if (!reply.ok && reply.spent && FILE_STEPS.has(opts.mode)) {
    // A crash is the likely cause, not a proved one: the words say so.
    const error = reply.error === CRASHED ? STEP_CRASHED : STEP_OUT_OF_MEMORY;
    return { ok: false, error, spent: true };
  }
  return reply;
}

/** Tests only: count or change the pace of refusals. */
export function __setRefusalPaceForTests(pace: () => Promise<void>): void {
  paceRefusal = pace;
}

/** The pids of the live SQL children (tests and diagnostics). */
export function appSqlChildPids(): number[] {
  return [...children].flatMap((c) => (c.alive && c.proc.pid ? [c.proc.pid] : []));
}
