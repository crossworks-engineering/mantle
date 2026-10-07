/**
 * Runs ONE app-supplied SQL statement against an app's SQLite file, off the
 * event loop (audit 2026-09-27, Phase 4b). App SQL comes from app bundles,
 * members and anonymous public-share visitors alike, and it used to run on
 * the main thread through `DatabaseSync`, which has no timeout: one endless
 * recursive CTE froze the whole web process for every user.
 *
 * It runs in a CHILD PROCESS, not a worker thread (2026-09-28). A worker
 * thread could be terminated at the time limit, but terminating it did not
 * close its SQLite connection: a write stopped at the limit kept the app's
 * write lock, and every later write to that app failed with "database is
 * locked" until the web process restarted. A killed process always lets go:
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
 * statement to the next.
 *
 * Inside the child, three engine-level locks hold whatever the text says
 * (a regex can be fooled; the engine cannot):
 *  - an AUTHORIZER refuses ATTACH (which also covers `VACUUM` and
 *    `VACUUM INTO`, both of which attach a database), DETACH, and every
 *    PRAGMA except `table_info` / `table_xinfo`;
 *  - a size limit on any one string or blob (`limits.length`);
 *  - a row cap and a byte cap on what a query returns;
 *  - on a writable open, a cap on the whole database file
 *    (`PRAGMA max_page_count`, from APP_SQL_MAX_DB_MB) and on the WAL left
 *    after a checkpoint (`PRAGMA journal_size_limit`): a write past the cap
 *    fails with SQLITE_FULL ("database or disk is full") and rolls back.
 *
 * One caller (a client login, a member login, a share link) runs at most one
 * statement at a time (`callerKey`, client tier audit I1): its next statement
 * waits its turn, so one caller cannot hold every child while other callers'
 * statements run on the rest.
 *
 * Mode 'script' runs an app's declared schema DDL (several statements) in
 * one transaction, under the same authorizer and limits: CREATE TABLE,
 * CREATE INDEX, ALTER TABLE and the rest pass; ATTACH, VACUUM and PRAGMAs
 * (bar table_info / table_xinfo) are refused, and nothing of the script
 * stays when any statement fails or is killed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { env, envDynamic, envInt } from '@mantle/config';
import { errorMessage } from '@mantle/std';

/** How long one app statement may run. */
export const APP_SQL_TIMEOUT_MS = 5_000;
/** The most rows one app query returns; beyond it the query fails with a
 *  "add a LIMIT" error rather than silently truncating an app's data. */
export const APP_SQL_MAX_ROWS = 50_000;
/** The largest string or blob one statement may produce (16 MiB). */
export const APP_SQL_MAX_LENGTH = 16 * 1024 * 1024;
/** How long an app's schema script may run. Longer than one statement: a new
 *  schema version may index a table that already holds the app's data. */
export const APP_SCHEMA_TIMEOUT_MS = 30_000;
/** The most SQL child processes alive at once. Each is a bare Node process
 *  (about 40 MB), inside the web container's memory limit (WEB_MEM_LIMIT, 3g
 *  by default). A statement beyond it waits for a free child, for at most its
 *  own time limit. */
export const APP_SQL_MAX_CHILDREN = 4;
/** An idle child exits after this long, so a quiet server holds none. */
export const APP_SQL_CHILD_IDLE_MS = 60_000;
/** The default cap on one app's database file, in MB (APP_SQL_MAX_DB_MB). */
export const APP_SQL_DEFAULT_MAX_DB_MB = 256;
/** The most bytes one query returns (roughly as serialized); beyond it the
 *  query fails with an "add a LIMIT" error. The rows cross into the web
 *  process and are JSON-encoded there, so this bounds its memory. */
export const APP_SQL_MAX_REPLY_BYTES = 8 * 1024 * 1024;
/** How long the server's copy of one app file may take (a 256 MB file
 *  copies in a few seconds; this leaves room for a slow disk). */
export const APP_DB_COPY_TIMEOUT_MS = 120_000;
/** A restore marker (`<file>.restoring`) older than this is a crash's
 *  leftover and is ignored (apps snapshots, Phase 2). */
export const APP_DB_RESTORE_MARKER_TTL_MS = 5 * 60_000;
/** The reply a child gives for a file under restore; the parent turns it
 *  into AppDbRestoringError. */
const RESTORING_REPLY = 'mantle:app-db-restoring';
/** The WAL an app database keeps after a checkpoint (journal_size_limit). */
export const APP_SQL_JOURNAL_LIMIT_BYTES = 64 * 1024 * 1024;
/** Statements one caller may have waiting behind its running one; beyond it
 *  the next is refused as busy at once. */
export const APP_SQL_MAX_WAITING_PER_CALLER = 16;

/** The cap on one app's database file, in bytes: APP_SQL_MAX_DB_MB (default
 *  256), read at call time. */
export function appSqlMaxDbBytes(): number {
  // Compose passes an unset variable as '', which Number() reads as 0.
  const mb = env('APP_SQL_MAX_DB_MB')?.trim()
    ? envInt('APP_SQL_MAX_DB_MB', APP_SQL_DEFAULT_MAX_DB_MB, 1)
    : APP_SQL_DEFAULT_MAX_DB_MB;
  return mb * 1024 * 1024;
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

/** The child: a plain CommonJS script passed with `-e`, so it needs no file
 *  on disk and runs the same under tsx in dev, in tests and in the image. */
const CHILD_SOURCE = `
const { DatabaseSync, constants: C } = require('node:sqlite');
const fs = require('node:fs');
// A restore is swapping this file (its marker is fresh): open nothing.
function restoring(file) {
  try {
    return Date.now() - fs.statSync(file + '.restoring').mtimeMs < ${APP_DB_RESTORE_MARKER_TTL_MS};
  } catch {
    return false;
  }
}
process.title = 'mantle-app-sql';
// The parent is gone (exited or crashed): so is the reason to live.
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
function run(job) {
  const { file, sql, params, mode, readOnly, maxRows, maxLength, maxReplyBytes, maxDbBytes, journalLimit, userVersion, dest } = job;
  if (mode !== 'copy' && mode !== 'adopt' && restoring(file)) throw new Error('${RESTORING_REPLY}');
  if (mode === 'copy') {
    // The server's own copy of an app's file (a schema trial run, a
    // snapshot): VACUUM INTO from a read-only open, a consistent copy under
    // WAL. Never reachable from app SQL: the parent alone picks the mode and
    // the destination, and no authorizer is set because no app text runs.
    const src = new DatabaseSync(file, { readOnly: true });
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
    // checked whole, then copied clean to dest. None of the file's own SQL is
    // run: the checks read pages, VACUUM INTO copies the schema as text, and
    // trusted_schema off keeps its views and triggers from calling functions
    // while it is read. The parent picks the file (its own temp copy).
    const src = new DatabaseSync(file);
    try {
      src.exec('PRAGMA trusted_schema = OFF');
      const check = src.prepare('PRAGMA quick_check').all();
      const first = check[0] ? String(Object.values(check[0])[0]) : 'no answer';
      if (check.length !== 1 || first !== 'ok') {
        throw new Error('the database file is damaged (' + first.slice(0, 200) + ')');
      }
      const userVersion = Number(src.prepare('PRAGMA user_version').get().user_version);
      src.exec("VACUUM INTO '" + String(dest).replace(/'/g, "''") + "'");
      return { userVersion };
    } finally {
      src.close();
    }
  }
  const db = new DatabaseSync(file, { readOnly, limits: { length: maxLength } });
  try {
    // Connection settings first: the authorizer below refuses app PRAGMAs.
    db.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly) {
      db.exec('PRAGMA journal_mode = WAL');
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
    db.setAuthorizer((action, arg1) => {
      if (action === C.SQLITE_ATTACH || action === C.SQLITE_DETACH) return C.SQLITE_DENY;
      if (action === C.SQLITE_PRAGMA) {
        const name = String(arg1 || '').toLowerCase();
        return name === 'table_info' || name === 'table_xinfo' ? C.SQLITE_OK : C.SQLITE_DENY;
      }
      return C.SQLITE_OK;
    });
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
      const r = db.prepare(sql).run(...params);
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
    reply = { id: job.id, ok: false, error: err && err.message ? err.message : String(err) };
  }
  process.send(reply);
});
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

type Reply = { ok: true; result: unknown } | { ok: false; error: string };
type Child = {
  proc: ChildProcess;
  /** False once the process has exited. */
  alive: boolean;
  /** Being killed: never handed out again. */
  doomed: boolean;
  /** Answers the statement it is running, if any. */
  onReply?: (r: Reply & { id?: number }) => void;
  idleTimer?: ReturnType<typeof setTimeout>;
};

const children = new Set<Child>();
const idle: Child[] = [];
const waiting: ((c: Child) => void)[] = [];

function forkChild(): Child {
  const proc = spawn(process.execPath, ['--input-type=commonjs', '-e', CHILD_SOURCE], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    // Structured clone, so a BLOB comes back as bytes, as it did from a worker.
    serialization: 'advanced',
    env: childEnv(),
  });
  const child: Child = { proc, alive: true, doomed: false };
  children.add(child);
  // An idle pool must not keep the server (or a test run) from exiting; a
  // running statement's own timer holds the event loop while it waits.
  proc.unref();
  proc.channel?.unref();
  proc.on('message', (m: Reply & { id?: number }) => {
    const onReply = child.onReply;
    child.onReply = undefined;
    onReply?.(m);
  });
  const gone = (why: string) => {
    if (!child.alive) return;
    child.alive = false;
    children.delete(child);
    const at = idle.indexOf(child);
    if (at >= 0) idle.splice(at, 1);
    if (child.idleTimer) clearTimeout(child.idleTimer);
    const onReply = child.onReply;
    child.onReply = undefined;
    onReply?.({ ok: false, error: why });
    // A statement waiting for a free child gets the slot this one held.
    const next = waiting.shift();
    if (next) next(forkChild());
  };
  proc.once('exit', (code, signal) =>
    gone(`the SQL process exited (${signal ?? `code ${code}`}) before it answered`),
  );
  proc.once('error', (err) => {
    gone(`the SQL process failed: ${errorMessage(err)}`);
    proc.kill('SIGKILL');
  });
  return child;
}

/** A free child: an idle one, a new one while under the cap, else the next
 *  one to come free, waiting at most `waitMs`. */
function acquire(waitMs: number): Promise<Child> {
  for (let c = idle.pop(); c; c = idle.pop()) {
    clearTimeout(c.idleTimer);
    c.idleTimer = undefined;
    // Died while idle and its exit not yet seen: skip it.
    if (c.proc.connected) return Promise.resolve(c);
    void kill(c);
  }
  if (children.size < APP_SQL_MAX_CHILDREN) return Promise.resolve(forkChild());
  return new Promise((resolve, reject) => {
    const take = (child: Child) => {
      clearTimeout(timer);
      resolve(child);
    };
    const timer = setTimeout(() => {
      const at = waiting.indexOf(take);
      if (at >= 0) waiting.splice(at, 1);
      reject(
        new AppSqlBusyError(
          `app SQL is busy: every SQL process was running a statement for ${waitMs} ms; try again`,
        ),
      );
    }, waitMs);
    waiting.push(take);
  });
}

function release(c: Child): void {
  if (!c.alive || c.doomed) return;
  const next = waiting.shift();
  if (next) return next(c);
  c.idleTimer = setTimeout(() => c.proc.kill(), APP_SQL_CHILD_IDLE_MS);
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
  },
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? APP_SQL_TIMEOUT_MS;
  if (opts.mode === 'script' && opts.readOnly)
    throw new Error('a schema script needs a writable open');
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
  mode: 'all' | 'run' | 'script' | 'copy' | 'batch' | 'adopt';
  /** 'copy' and 'adopt' only: the file to write (must not exist). */
  dest?: string;
  /** 'batch' only: the statements, run in one transaction. */
  statements?: AppSqlBatchStatement[];
};

/**
 * Run the server's own statements against an app's file in ONE transaction,
 * in a SQL child, under the same authorizer, caps and time limit as app SQL
 * (apps audit P5: the authoring-time seed used to run on the main thread).
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
          error: `the statement ran longer than ${timeoutMs} ms and was stopped: narrow it (add WHERE or LIMIT, avoid unbounded recursion)`,
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
    child.proc.send({
      id,
      file,
      sql: opts.sql,
      params: opts.params ?? [],
      mode: opts.mode,
      readOnly: opts.readOnly,
      maxRows: APP_SQL_MAX_ROWS,
      maxLength: APP_SQL_MAX_LENGTH,
      maxReplyBytes: APP_SQL_MAX_REPLY_BYTES,
      maxDbBytes: opts.maxDbBytes ?? appSqlMaxDbBytes(),
      journalLimit: APP_SQL_JOURNAL_LIMIT_BYTES,
      userVersion: opts.mode === 'script' ? Math.max(0, Math.floor(opts.userVersion ?? 0)) : 0,
      dest: opts.mode === 'copy' || opts.mode === 'adopt' ? opts.dest : undefined,
      statements: opts.mode === 'batch' ? opts.statements : undefined,
    });
  });
  release(child);
  if (!reply.ok) {
    if (reply.error === RESTORING_REPLY) throw new AppDbRestoringError();
    throw new AppSqlError(reply.error);
  }
  return reply.result;
}

/** The pids of the live SQL children (tests and diagnostics). */
export function appSqlChildPids(): number[] {
  return [...children].flatMap((c) => (c.alive && c.proc.pid ? [c.proc.pid] : []));
}
