import { spawn, type ChildProcess } from 'node:child_process';

import { openTableFile } from './sqlite';
import { envDynamic, envNum } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { killWithParent } from '@mantle/std/kill-with-parent';
import { runtimeFlags } from '@mantle/std/self-spawn';

/**
 * table_sql — read-only SQL over one workbook file (plan §3.4). Layered:
 *
 *   1. readOnly open — writes rejected at the ENGINE level (probe-pinned).
 *   2. Statement gate — SELECT/WITH only, single statement, ATTACH/DETACH/
 *      PRAGMA/VACUUM denied anywhere (comments + string literals stripped
 *      before scanning, so a blocked verb can't hide in either).
 *   3. Row cap — the statement is wrapped in `SELECT * FROM (…) LIMIT cap+1`,
 *      so an over-wide result truncates at the engine instead of
 *      materializing.
 *   4. Child process + watchdog: node:sqlite is synchronous; a hostile
 *      cartesian aggregate would block the event loop, so execution happens
 *      in a child process that gets SIGKILLed at the deadline. Required for
 *      the tool's ship, not optional hardening.
 *
 * A child process, not a worker thread. worker.terminate() cannot stop a
 * thread inside a native SQLite call: the caller got its timeout error, the
 * query kept one core busy for ever, and the server could no longer exit. An
 * outer LIMIT does not stop an aggregate. Only the OS can stop that call. A
 * child also dies with this process: one inside a statement cannot see this
 * process go, so killWithParent gives each a guard.
 *
 * The tool runs often, and on Linux a fork from a large server blocks the
 * event loop for tens of milliseconds, so a small pool of long-lived children
 * serves one statement at a time each (the same shape as app-sql-runner.ts in
 * @mantle/content, which this package cannot import). Each statement opens
 * and closes its own connection in the child, so the per-request handle
 * discipline (sqlite.ts) holds and a reused child carries nothing over.
 *
 * The child is spawned from a self-contained eval string (no file URL), so it
 * behaves identically under tsx (server/api) and Next's bundler (server/web).
 */

export const SQL_ROW_CAP_DEFAULT = 200;
export const SQL_ROW_CAP_MAX = 1000;

/** The most SQL child processes alive at once. Each is a bare Node process
 *  (about 50 MB). A statement beyond it waits for a free child, for at most
 *  its own time limit. */
const TABLE_SQL_MAX_CHILDREN = 4;
/** An idle child exits after this long, so a quiet server holds none. */
const TABLE_SQL_CHILD_IDLE_MS = 60_000;
/** The longest string or BLOB a statement may make or read (SQLite's own
 *  limit). Without it `SELECT zeroblob(943718400)` is a legal query, and its
 *  bytes reach this process. */
export const TABLE_SQL_MAX_LENGTH = 16 * 1024 * 1024;
/** The most a reply may hold. This keeps the bytes out of this process. It
 *  does not bound the child: a row is built whole before it can be read, so 64
 *  columns of the longest value peak near 2 GB there (measured 2026-11-01). */
export const TABLE_SQL_MAX_REPLY_BYTES = 16 * 1024 * 1024;

function timeoutMs(): number {
  return envNum('TABLE_SQL_TIMEOUT_MS');
}

export type SqlRunResult = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  /** True when the result was cut at the row cap. */
  truncated: boolean;
  durationMs: number;
};

/** Strip string literals and comments so verb scanning can't be evaded by
 *  hiding a blocked keyword inside either. Replaced with spaces to keep the
 *  scan positions honest. */
export function stripLiterals(sqlText: string): string {
  return sqlText
    .replace(/'(?:[^']|'')*'/g, ' ')
    .replace(/"(?:[^"]|"")*"/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Validate a user statement for the runner. Throws with a teach-the-agent
 *  message on violation; returns the trimmed statement (trailing ';' ok). */
export function assertReadOnlySelect(sqlText: string): string {
  const trimmed = sqlText.trim().replace(/;\s*$/, '');
  if (!trimmed) throw new Error('table_sql: empty statement');
  const scan = stripLiterals(trimmed);
  if (!/^\s*(select|with)\b/i.test(scan)) {
    throw new Error('table_sql is read-only: the statement must start with SELECT or WITH');
  }
  if (scan.includes(';')) {
    throw new Error('table_sql runs exactly one statement — remove the extra ";"');
  }
  // 'pragma' matches WITHOUT a trailing word boundary so the function form
  // (pragma_table_info(...)) is caught too — describeWorkbook already hands
  // agents the schema, so there is no legitimate need for any pragma surface.
  if (/\b(attach|detach|vacuum)\b|\bpragma/i.test(scan)) {
    throw new Error('table_sql: ATTACH/DETACH/PRAGMA/VACUUM are not allowed');
  }
  return trimmed;
}

const CHILD_SOURCE = `
const { DatabaseSync } = require('node:sqlite');
process.title = 'mantle-table-sql';
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
function run(job) {
  const db = new DatabaseSync(job.file, { readOnly: true, limits: { length: job.maxLength } });
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    const raw = [];
    let bytes = 0;
    for (const row of db.prepare(job.sql).iterate()) {
      bytes += rowBytes(row);
      if (bytes > job.maxReplyBytes) {
        throw new Error('the query returned more than ' + Math.round(job.maxReplyBytes / 1048576) + ' MB: add a LIMIT, select fewer columns or aggregate in SQL');
      }
      raw.push(row);
    }
    const columns = raw.length > 0 ? Object.keys(raw[0]) : [];
    return { columns, rows: raw.map((r) => columns.map((c) => r[c])) };
  } finally {
    // This child lives on for the next statement: close, error or not.
    db.close();
  }
}
process.on('message', (job) => {
  let reply;
  try {
    reply = { ok: true, ...run(job) };
  } catch (err) {
    reply = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  process.send(reply);
});
`;

/** What the child sees of the environment: enough for SQLite (temp files, and
 *  TZ for the 'localtime' date modifier), none of the server's secrets. */
function childEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'TMPDIR', 'SQLITE_TMPDIR', 'TZ', 'LANG', 'LC_ALL']) {
    const v = envDynamic(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

type ChildReply =
  | { ok: true; columns: string[]; rows: unknown[][] }
  /** `lost`: the child died on its own, so the statement may not have run. */
  | { ok: false; error: string; lost?: boolean };
type Child = {
  proc: ChildProcess;
  /** False once the process has exited. */
  alive: boolean;
  /** Being killed: never handed out again. */
  doomed: boolean;
  /** Answers the statement it is running, if any. */
  onReply?: (r: ChildReply) => void;
  idleTimer?: ReturnType<typeof setTimeout>;
};

const children = new Set<Child>();
const idle: Child[] = [];
const waiting: ((c: Child) => void)[] = [];

function forkChild(): Child {
  const argv = [...runtimeFlags(), '--input-type=commonjs', '-e', CHILD_SOURCE];
  const proc = spawn(process.execPath, argv, {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    // Structured clone, so a BLOB comes back as bytes, as it did from a worker.
    serialization: 'advanced',
    env: childEnv(),
  });
  killWithParent(proc);
  const child: Child = { proc, alive: true, doomed: false };
  children.add(child);
  // An idle pool must not keep the server (or a test run) from exiting; a
  // running statement's own timer holds the event loop while it waits. Bun's
  // channel has no unref.
  proc.unref();
  proc.channel?.unref?.();
  proc.on('message', (m: ChildReply) => {
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
    clearTimeout(child.idleTimer);
    const onReply = child.onReply;
    child.onReply = undefined;
    onReply?.({ ok: false, error: why, lost: true });
    // A statement waiting for a free child gets the slot this one held. A
    // fork that throws here would reach no caller: that waiter times out.
    const next = waiting.shift();
    if (next) {
      try {
        next(forkChild());
      } catch (err) {
        console.warn(`[table_sql] no new SQL process: ${errorMessage(err)}`);
      }
    }
  };
  proc.once('exit', (code, signal) =>
    gone(`the SQL process exited (${signal ?? `code ${code}`}) before it answered`),
  );
  // on, not once: a failed spawn and a failed send can each raise one, and an
  // 'error' with no listener would take the whole server down.
  proc.on('error', (err) => {
    gone(`the SQL process failed: ${errorMessage(err)}`);
    proc.kill('SIGKILL');
  });
  return child;
}

/** A free child: an idle one, a new one while under the cap, else the next one
 *  to come free, waiting at most `waitMs`. */
function acquire(waitMs: number): Promise<Child> {
  for (let c = idle.pop(); c; c = idle.pop()) {
    clearTimeout(c.idleTimer);
    c.idleTimer = undefined;
    // Died while idle and its exit not yet seen: skip it.
    if (c.proc.connected) return Promise.resolve(c);
    void kill(c);
  }
  if (children.size < TABLE_SQL_MAX_CHILDREN) return Promise.resolve(forkChild());
  return new Promise((resolve, reject) => {
    const take = (child: Child) => {
      clearTimeout(timer);
      resolve(child);
    };
    const timer = setTimeout(() => {
      const at = waiting.indexOf(take);
      if (at >= 0) waiting.splice(at, 1);
      reject(
        new Error(`table_sql: busy, every SQL process ran a statement for ${waitMs}ms; try again`),
      );
    }, waitMs);
    waiting.push(take);
  });
}

function release(c: Child): void {
  if (!c.alive || c.doomed) return;
  const next = waiting.shift();
  if (next) return next(c);
  c.idleTimer = setTimeout(() => {
    idle.splice(idle.indexOf(c), 1);
    c.doomed = true;
    c.proc.kill();
  }, TABLE_SQL_CHILD_IDLE_MS);
  c.idleTimer.unref();
  idle.push(c);
}

/** SIGKILL a child and wait until it is gone: the signal needs no help from
 *  the process, so it works inside a native SQLite call. */
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

/** One statement on one child, at most `limitMs`. */
function ask(child: Child, file: string, sql: string, limitMs: number): Promise<ChildReply> {
  // A spawn that failed, or a child that died before it was handed out.
  if (!child.alive) {
    return Promise.resolve({ ok: false, error: 'the SQL process did not start', lost: true });
  }
  return new Promise<ChildReply>((resolve) => {
    const timer = setTimeout(() => {
      child.onReply = undefined;
      void kill(child).then(() =>
        resolve({
          ok: false,
          error: `query exceeded the ${limitMs}ms limit and was killed — narrow it (add WHERE / LIMIT, avoid cross joins)`,
        }),
      );
    }, limitMs);
    child.onReply = (r) => {
      clearTimeout(timer);
      resolve(r);
    };
    try {
      child.proc.send({
        file,
        sql,
        maxLength: TABLE_SQL_MAX_LENGTH,
        maxReplyBytes: TABLE_SQL_MAX_REPLY_BYTES,
      });
    } catch (err) {
      // Bun: a child that failed to spawn has no send.
      child.onReply?.({ ok: false, error: errorMessage(err), lost: true });
    }
  });
}

/**
 * Execute one read-only statement against a workbook file. `cap` clamps to
 * [1, SQL_ROW_CAP_MAX]. Rejects on guard violation, SQL error, a busy pool or
 * watchdog timeout (the child is SIGKILLed and gone before the caller hears of
 * it; the event loop never blocks).
 */
export async function runTableSql(
  file: string,
  sqlText: string,
  opts: { cap?: number } = {},
): Promise<SqlRunResult> {
  // Surface a missing file as our structured error BEFORE using a child.
  openTableFile(file, { readOnly: true }).close();

  const statement = assertReadOnlySelect(sqlText);
  const cap = Math.max(1, Math.min(opts.cap ?? SQL_ROW_CAP_DEFAULT, SQL_ROW_CAP_MAX));
  const wrapped = `SELECT * FROM (\n${statement}\n) LIMIT ${cap + 1}`;
  const started = Date.now();
  const limitMs = timeoutMs();

  const child = await acquire(limitMs);
  let reply = await ask(child, file, wrapped, limitMs);
  release(child);
  // A child can die between two statements, and nothing here can see that
  // until it fails. The statement only reads, so it may run on a fresh one.
  if (!reply.ok && reply.lost) {
    const fresh = await acquire(limitMs);
    reply = await ask(fresh, file, wrapped, limitMs);
    release(fresh);
  }

  if (!reply.ok) throw new Error(`table_sql: ${reply.error}`);
  const truncated = reply.rows.length > cap;
  const rows = truncated ? reply.rows.slice(0, cap) : reply.rows;
  return {
    columns: reply.columns,
    rows,
    rowCount: rows.length,
    truncated,
    durationMs: Date.now() - started,
  };
}

/** The pids of the live SQL children (tests and diagnostics). */
export function tableSqlChildPids(): number[] {
  return [...children].flatMap((c) => (c.alive && c.proc.pid ? [c.proc.pid] : []));
}
