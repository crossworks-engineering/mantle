import { Worker } from 'node:worker_threads';

import { openTableFile } from './sqlite';

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
 *   4. Worker thread + watchdog — node:sqlite is synchronous; a hostile
 *      cartesian aggregate would block the event loop, so execution happens
 *      in a throwaway worker that gets terminate()d at the deadline. Required
 *      for the tool's ship, not optional hardening.
 *
 * The worker is spawned from a self-contained eval string (no file URL), so
 * it behaves identically under tsx (apps/api) and Next's bundler (apps/web).
 */

export const SQL_ROW_CAP_DEFAULT = 200;
export const SQL_ROW_CAP_MAX = 1000;

function timeoutMs(): number {
  const raw = Number(process.env.TABLE_SQL_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
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

const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(workerData.file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 2000');
  const stmt = db.prepare(workerData.sql);
  const raw = stmt.all();
  db.close();
  const columns = raw.length > 0 ? Object.keys(raw[0]) : [];
  const rows = raw.map((r) => columns.map((c) => r[c]));
  parentPort.postMessage({ ok: true, columns, rows });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
`;

/**
 * Execute one read-only statement against a workbook file. `cap` clamps to
 * [1, SQL_ROW_CAP_MAX]. Rejects on guard violation, SQL error, or watchdog
 * timeout (the worker is terminated — the event loop never blocks).
 */
export async function runTableSql(
  file: string,
  sqlText: string,
  opts: { cap?: number } = {},
): Promise<SqlRunResult> {
  // Surface a missing file as our structured error BEFORE spawning a worker.
  openTableFile(file, { readOnly: true }).close();

  const statement = assertReadOnlySelect(sqlText);
  const cap = Math.max(1, Math.min(opts.cap ?? SQL_ROW_CAP_DEFAULT, SQL_ROW_CAP_MAX));
  const wrapped = `SELECT * FROM (\n${statement}\n) LIMIT ${cap + 1}`;
  const started = Date.now();

  type WorkerReply =
    { ok: true; columns: string[]; rows: unknown[][] } | { ok: false; error: string };
  const reply = await new Promise<WorkerReply>((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { file, sql: wrapped },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({
        ok: false,
        error: `query exceeded the ${timeoutMs()}ms limit and was killed — narrow it (add WHERE / LIMIT, avoid cross joins)`,
      });
    }, timeoutMs());
    const settle = (r: WorkerReply) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    worker.once('message', (m: WorkerReply) => settle(m));
    worker.once('error', (err) => settle({ ok: false, error: err.message }));
    worker.once('exit', (code) => {
      if (code !== 0) settle({ ok: false, error: `worker exited with code ${code}` });
    });
  });

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
