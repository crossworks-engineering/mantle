import { spawn, type ChildProcess } from 'node:child_process';
import { availableParallelism } from 'node:os';

import { openTableFile } from './sqlite';
import { envDynamic, envNum } from '@mantle/config';
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
 * has no file to find under any bundler.
 */

export const SQL_ROW_CAP_DEFAULT = 200;
export const SQL_ROW_CAP_MAX = 1000;

/** The most SQL child processes alive at once in this process: the reader
 *  limit, `FILE_DB_READERS`. Each is a bare Bun process. A statement beyond it
 *  waits for a free child, for at most its own time limit, then hears `busy`.
 *  A second try on a new child can pass it, for at most one time limit (see
 *  `release`). The web and api processes each hold a pool. */
function maxChildren(): number {
  return fileDbReaders();
}

/** The reader limit of this process (`FILE_DB_READERS`, else the default). */
export function fileDbReaders(): number {
  return envNum('FILE_DB_READERS', fileDbReadersDefault());
}

/** The default reader limit: half the cores, at least 1, at most 4. A 2-core
 *  box gets 1 per process, so 2 on the box (web and api). Measured on a
 *  2-core, 2 GB stand-in (report file-sql-many). */
export function fileDbReadersDefault(cores = availableParallelism()): number {
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}
/** An idle child exits after this long, so a quiet server holds none. */
const TABLE_SQL_CHILD_IDLE_MS = 60_000;
/** The longest string or BLOB a statement may make or read (SQLite's own
 *  limit). Without it `SELECT zeroblob(943718400)` is a legal query, and its
 *  bytes reach this process. */
export const TABLE_SQL_MAX_LENGTH = 16 * 1024 * 1024;
/** The most a reply may hold. This keeps the bytes out of this process. */
export const TABLE_SQL_MAX_REPLY_BYTES = 16 * 1024 * 1024;
/** The kernel limit on a SQL process. A row is built whole before the reply
 *  cap can read it, so 64 columns of the longest value reach 3 GB without it.
 *  With it the process stops near 500 MB of real memory. Node 26 needs about
 *  575 MB of the limit to start, nearly all of it address space it does not
 *  touch (measured 2026-11-01). */
export const TABLE_SQL_CHILD_MEMORY_MB = 1024;
/** What a caller hears when a statement meets that limit: SQLite's own answer,
 *  then a process that ended and most likely met it. */
const OUT_OF_MEMORY =
  'the statement needs more memory than a SQL process may use: add a LIMIT, select fewer columns or aggregate in SQL';
const CRASHED =
  'the statement ended its SQL process, most likely at the memory limit: add a LIMIT, select fewer columns or aggregate in SQL';
/** Refusals at the memory limit that pass at once, then the most per second
 *  (each one kills a child, and a new one is forked: see refusalPace). */
export const TABLE_SQL_REFUSAL_BURST = 4;
export const TABLE_SQL_REFUSALS_PER_SECOND = 2;
let paceRefusal = refusalPace(TABLE_SQL_REFUSAL_BURST, TABLE_SQL_REFUSALS_PER_SECOND);
/** Children killed at the memory limit and not yet replaced. A fork for a new
 *  statement or a waiter pays one first (a turn of paceRefusal), so refused
 *  statements cannot make this process fork faster than the pace. A second
 *  try forks at once: it is one fork per refused statement whose own child was
 *  paced, and waiting would let a waiter take its place past the cap. The
 *  count is close, not exact: a fork may pay and then find a free child. */
let refusalDebt = 0;
/** Why a statement failed, for a caller that acts on it (file_sql over many
 *  files): `busy` no free reader, `timeout` the time limit, `memory` the
 *  memory limit, `too-big` the reply cap, `sql` anything else (the engine's
 *  own words: a syntax error, no such table). */
export type TableSqlErrorCode = 'busy' | 'timeout' | 'memory' | 'too-big' | 'sql';

export class TableSqlError extends Error {
  constructor(
    message: string,
    readonly code: TableSqlErrorCode,
  ) {
    super(message);
    this.name = 'TableSqlError';
  }
}

const busy = (waitMs: number) =>
  new TableSqlError(
    `table_sql: busy, every file database reader on this server is in use (waited ${waitMs}ms); try again in a few seconds`,
    'busy',
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

/** A string, a quoted or bracketed name, or a comment, as SQLite's tokenizer
 *  reads them: whichever opens first takes the text up to its close, so a
 *  quote inside a comment opens nothing and a comment mark inside a string
 *  starts nothing. A doubled quote reads as two strings side by side. One
 *  left open runs to the end of the text, which also keeps this one pass:
 *  unclosed comments cannot make it start over. */
const LITERAL_OR_COMMENT =
  /'[^']*(?:'|$)|"[^"]*(?:"|$)|`[^`]*(?:`|$)|\[[^\]]*(?:\]|$)|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g;

/** Strip string literals, quoted names and comments, so a verb scan can't be
 *  evaded by hiding a blocked keyword inside either. A hint for a good error
 *  and no more: this text is not SQLite's own tokenizer, so what must hold is
 *  held by the engine (the children's authorizers, and for a batch the text
 *  the engine reports it read). */
export function stripLiterals(sqlText: string): string {
  return sqlText.replace(LITERAL_OR_COMMENT, ' ');
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
const { DatabaseSync, constants: C } = require('node:sqlite');
process.title = 'mantle-table-sql';
// Reads only, whatever the text says (a regex can be fooled; the engine
// cannot). FTS5 asks for PRAGMA data_version on its own, and that is a number.
function readRule(action, arg1) {
  if (action === C.SQLITE_PRAGMA) {
    return String(arg1 || '').toLowerCase() === 'data_version' ? C.SQLITE_OK : C.SQLITE_DENY;
  }
  return action === C.SQLITE_READ ||
    action === C.SQLITE_SELECT ||
    action === C.SQLITE_FUNCTION ||
    action === C.SQLITE_RECURSIVE
    ? C.SQLITE_OK
    : C.SQLITE_DENY;
}
// The parent is gone (exited or crashed): so is the reason to live. An idle
// child hears it here; in a statement it cannot, and its guard kills it.
process.on('disconnect', () => process.exit(0));
// About what a row costs once serialized and read back: keys, values, a
// little framing. A BLOB is an object in the reader of the reply, so an empty
// one is not free.
function valueBytes(v) {
  if (v === null || v === undefined) return 4;
  if (typeof v === 'string') return Buffer.byteLength(v) + 2;
  if (v instanceof Uint8Array) return 64 + v.byteLength;
  return 8;
}
function rowBytes(row) {
  let n = 2;
  for (const k in row) n += k.length + 4 + valueBytes(row[k]);
  return n;
}
const quoteName = (n) => '"' + String(n).replaceAll('"', '""') + '"';
// A file read only, or the rows of many files as table results in memory:
// filled before the authorizer is set, and after it nothing writes.
function open(job) {
  if (!job.results) {
    const db = new DatabaseSync(job.file, { readOnly: true, limits: { length: job.maxLength } });
    db.exec('PRAGMA busy_timeout = 2000');
    return db;
  }
  const db = new DatabaseSync(':memory:', { limits: { length: job.maxLength } });
  try {
    const names = job.results.columns.map(quoteName);
    db.exec('CREATE TABLE results (' + names.join(', ') + ')');
    const insert = db.prepare('INSERT INTO results VALUES (' + names.map(() => '?').join(', ') + ')');
    db.exec('BEGIN');
    for (const row of job.results.rows) insert.run(...row);
    db.exec('COMMIT');
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
function run(job) {
  const db = open(job);
  try {
    db.setAuthorizer(readRule);
    const raw = [];
    let bytes = 0;
    for (const row of db.prepare(job.sql).iterate()) {
      bytes += rowBytes(row);
      if (bytes > job.maxReplyBytes) {
        const big = new Error('the query returned more than ' + Math.max(1, Math.round(job.maxReplyBytes / 1048576)) + ' MB: add a LIMIT, select fewer columns or aggregate in SQL');
        big.tooBig = true;
        throw big;
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
    const error = err && err.message ? err.message : String(err);
    // SQLite's own code (SQLITE_NOMEM), then the engine's own error on Bun.
    // Never the text alone: a statement can raise any text it likes.
    const nomem = (err && typeof err.errcode === 'number' && (err.errcode & 0xff) === 7) ||
      (err instanceof RangeError && /^out of memory$/i.test(error));
    reply = nomem
      ? { ok: false, error: ${JSON.stringify(OUT_OF_MEMORY)}, spent: true }
      : { ok: false, error, ...(err && err.tooBig === true ? { tooBig: true } : {}) };
  }
  process.send(reply);
});
// It runs: an exit from here on is not a start-up failure.
process.send(${JSON.stringify(CHILD_READY)});
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
  /** `lost`: the child died on its own, so the statement may not have run.
   *  `spent`: it met the memory limit, so it does not serve again.
   *  `tooBig`: the reply cap. `timedOut`: the time limit. */
  | {
      ok: false;
      error: string;
      lost?: boolean;
      spent?: boolean;
      tooBig?: boolean;
      timedOut?: boolean;
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
  onReply?: (r: ChildReply) => void;
  idleTimer?: ReturnType<typeof setTimeout>;
};

const children = new Set<Child>();
const idle: Child[] = [];
const waiting: ((c: Child) => void)[] = [];

function forkChild(): Child {
  const { command, args } = withMemoryLimit(TABLE_SQL_CHILD_MEMORY_MB, {
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
  proc.on('message', (m: ChildReply | typeof CHILD_READY) => {
    if (m === CHILD_READY) {
      child.started = true;
      return;
    }
    const onReply = child.onReply;
    child.onReply = undefined;
    onReply?.(m);
  });
  /** `spent`: it met the limit. `lost`: the statement may not have run, so it
   *  runs once more. `final`: neither (a child that never started). */
  const gone = (why: string, kind: 'spent' | 'lost' | 'final' = 'lost') => {
    if (!child.alive) return;
    child.alive = false;
    children.delete(child);
    const at = idle.indexOf(child);
    if (at >= 0) idle.splice(at, 1);
    clearTimeout(child.idleTimer);
    const onReply = child.onReply;
    child.onReply = undefined;
    onReply?.({
      ok: false,
      error: why,
      ...(kind === 'spent' ? { spent: true } : kind === 'lost' ? { lost: true } : {}),
    });
    // A statement waiting for a free child gets the slot this one held, while
    // the pool is under its cap: at once, or after the turn a fork owes for a
    // refused child. A fork that throws here reaches no caller, so that waiter
    // goes back to the front of the line.
    const serveWaiter = () => {
      const next = livePlaces(children) < maxChildren() ? waiting.shift() : undefined;
      if (!next) return;
      try {
        next(forkChild());
      } catch (err) {
        waiting.unshift(next);
        console.warn(`[table_sql] no new SQL process: ${errorMessage(err)}`);
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
          'final',
        );
      case 'crashed':
        return gone(CRASHED, 'spent');
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

/** A free child: an idle one, a new one while under the cap, else the next one
 *  to come free, waiting at most `waitMs` in all. */
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
  if (children.size < maxChildren()) return forkChild();
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
  if (livePlaces(children) > maxChildren()) return void kill(c);
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

/** What a statement reads: a file, read only, or rows as table `results` in
 *  memory. */
export type SqlSource = { file: string } | { results: { columns: string[]; rows: unknown[][] } };

/** One statement on one child, at most `limitMs`. */
function ask(
  child: Child,
  source: SqlSource,
  sql: string,
  limitMs: number,
  maxReplyBytes: number,
): Promise<ChildReply> {
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
          timedOut: true,
        }),
      );
    }, limitMs);
    child.onReply = (r) => {
      clearTimeout(timer);
      resolve(r);
    };
    try {
      child.proc.send({ ...source, sql, maxLength: TABLE_SQL_MAX_LENGTH, maxReplyBytes });
    } catch {
      // A child that failed to spawn has no send.
      child.onReply?.({ ok: false, error: 'the SQL process did not start', lost: true });
    }
  });
}

/** One statement on one child, and the child back in the pool, or out of it
 *  when it met the memory limit. */
async function answer(
  child: Child,
  source: SqlSource,
  sql: string,
  limitMs: number,
  maxReplyBytes: number,
): Promise<ChildReply> {
  const reply = await ask(child, source, sql, limitMs, maxReplyBytes);
  child.used = true;
  if (!reply.ok && reply.spent) {
    void kill(child);
    // Its replacement waits its turn (owedPace).
    refusalDebt = Math.min(refusalDebt + 1, 2 * maxChildren());
  }
  release(child);
  return reply;
}

/** The code of a failed reply. */
function codeOf(reply: Extract<ChildReply, { ok: false }>): TableSqlErrorCode {
  if (reply.tooBig) return 'too-big';
  if (reply.timedOut) return 'timeout';
  if (reply.spent) return 'memory';
  return 'sql';
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
  const cap = Math.max(1, Math.min(opts.cap ?? SQL_ROW_CAP_DEFAULT, SQL_ROW_CAP_MAX));
  return runReadOnlySql({ file }, sqlText, { cap });
}

/**
 * One read-only statement on the reader pool, over a file or over rows in
 * memory (file_sql over many files). `cap` is taken as given (at least 1);
 * `maxReplyBytes` and `limitMs` may only lower the defaults. A failure is a
 * TableSqlError with its code.
 */
export async function runReadOnlySql(
  source: SqlSource,
  sqlText: string,
  opts: { cap: number; maxReplyBytes?: number; limitMs?: number },
): Promise<SqlRunResult> {
  // Surface a missing file as our structured error BEFORE using a child.
  if ('file' in source) openTableFile(source.file, { readOnly: true }).close();

  const statement = assertReadOnlySelect(sqlText);
  const cap = Math.max(1, Math.floor(opts.cap));
  const wrapped = `SELECT * FROM (\n${statement}\n) LIMIT ${cap + 1}`;
  const started = Date.now();
  const limitMs = Math.max(1, Math.min(opts.limitMs ?? timeoutMs(), timeoutMs()));
  const maxReplyBytes = Math.max(
    1,
    Math.min(opts.maxReplyBytes ?? TABLE_SQL_MAX_REPLY_BYTES, TABLE_SQL_MAX_REPLY_BYTES),
  );

  const child = await acquire(limitMs);
  const used = child.used;
  let reply = await answer(child, source, wrapped, limitMs, maxReplyBytes);
  // A child can die between two statements, and nothing here can see that
  // until it fails. One that served before can also fail at the limit where a
  // new one passes: what it freed still counts. The statement only reads, so
  // it runs once more, always on a new child, whose answer is the last. So a
  // statement can take two time limits, and its wait for a child.
  if (!reply.ok && (reply.lost || (reply.spent && used))) {
    try {
      reply = await answer(forkChild(), source, wrapped, limitMs, maxReplyBytes);
    } catch {
      // No new process: the first answer stands.
    }
  }

  if (!reply.ok) throw new TableSqlError(`table_sql: ${reply.error}`, codeOf(reply));
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

/** Tests only: count or change the pace of refusals. */
export function __setRefusalPaceForTests(pace: () => Promise<void>): void {
  paceRefusal = pace;
}

/** The pids of the live SQL children (tests and diagnostics). */
export function tableSqlChildPids(): number[] {
  return [...children].flatMap((c) => (c.alive && c.proc.pid ? [c.proc.pid] : []));
}
