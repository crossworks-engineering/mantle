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
 *  - a row cap on what a query returns.
 *
 * Mode 'script' runs an app's declared schema DDL (several statements) in
 * one transaction, under the same authorizer and limits: CREATE TABLE,
 * CREATE INDEX, ALTER TABLE and the rest pass; ATTACH, VACUUM and PRAGMAs
 * (bar table_info / table_xinfo) are refused, and nothing of the script
 * stays when any statement fails or is killed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { envDynamic } from '@mantle/config';
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

/** The child: a plain CommonJS script passed with `-e`, so it needs no file
 *  on disk and runs the same under tsx in dev, in tests and in the image. */
const CHILD_SOURCE = `
const { DatabaseSync, constants: C } = require('node:sqlite');
process.title = 'mantle-app-sql';
// The parent is gone (exited or crashed): so is the reason to live.
process.on('disconnect', () => process.exit(0));
function run(job) {
  const { file, sql, params, mode, readOnly, maxRows, maxLength } = job;
  const db = new DatabaseSync(file, { readOnly, limits: { length: maxLength } });
  try {
    // Connection settings first: the authorizer below refuses app PRAGMAs.
    db.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
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
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // already rolled back by the failing statement
        }
        throw err;
      }
      return null;
    }
    if (mode === 'run') {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    }
    const rows = [];
    for (const row of db.prepare(sql).iterate(...params)) {
      if (rows.length >= maxRows) {
        throw new Error('the query returned more than ' + maxRows + ' rows: add a LIMIT or aggregate in SQL');
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
        new Error(
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

/** Run `sql` with `params`: mode 'all' returns rows, 'run' returns
 *  `{ changes, lastInsertRowid }`, 'script' runs several statements (no
 *  params) in one transaction and returns null. Rejects on SQL error, a
 *  refused statement, the row or size cap, or the time limit. */
export async function runAppSql(
  file: string,
  opts: {
    sql: string;
    params?: unknown[];
    mode: 'all' | 'run' | 'script';
    readOnly: boolean;
    timeoutMs?: number;
  },
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? APP_SQL_TIMEOUT_MS;
  if (opts.mode === 'script' && opts.readOnly)
    throw new Error('a schema script needs a writable open');
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
    });
  });
  release(child);
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

/** The pids of the live SQL children (tests and diagnostics). */
export function appSqlChildPids(): number[] {
  return [...children].flatMap((c) => (c.alive && c.proc.pid ? [c.proc.pid] : []));
}
