import { spawn, type ChildProcess } from 'node:child_process';

import { openTableFile } from './sqlite';
import { envDynamic, envNum } from '@mantle/config';
import { errorMessage } from '@mantle/std';
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
 * outer LIMIT does not stop an aggregate. Only the OS can stop that call.
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
// The parent is gone (exited or crashed): so is the reason to live.
process.on('disconnect', () => process.exit(0));
function run(job) {
  const db = new DatabaseSync(job.file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    const raw = db.prepare(job.sql).all();
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

type ChildReply = { ok: true; columns: string[]; rows: unknown[][] } | { ok: false; error: string };
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
    onReply?.({ ok: false, error: why });
    // A statement waiting for a free child gets the slot this one held.
    const next = waiting.shift();
    if (next) next(forkChild());
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
  const reply = await new Promise<ChildReply>((resolve) => {
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
    child.proc.send({ file, sql: wrapped });
  });
  release(child);

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
