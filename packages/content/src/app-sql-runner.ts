/**
 * Runs ONE app-supplied SQL statement against an app's SQLite file, off the
 * event loop (audit 2026-09-27, Phase 4b). App SQL comes from app bundles,
 * members and anonymous public-share visitors alike, and it used to run on
 * the main thread through `DatabaseSync`, which has no timeout: one endless
 * recursive CTE froze the whole web process for every user. The table runner
 * (@mantle/tabledb sql-runner) already ran its SQL in a worker with a
 * watchdog; this is the same shape for app databases.
 *
 * Inside the worker, three engine-level locks hold whatever the text says
 * (a regex can be fooled; the engine cannot):
 *  - an AUTHORIZER refuses ATTACH (which also covers `VACUUM` and
 *    `VACUUM INTO`, both of which attach a database), DETACH, and every
 *    PRAGMA except `table_info` / `table_xinfo`;
 *  - a size limit on any one string or blob (`limits.length`);
 *  - a row cap on what a query returns.
 * The worker is terminated at the time limit, and an unfinished write is
 * rolled back with its connection.
 */
import { Worker } from 'node:worker_threads';
import { errorMessage } from '@mantle/std';

/** How long one app statement may run. */
export const APP_SQL_TIMEOUT_MS = 5_000;
/** The most rows one app query returns; beyond it the query fails with a
 *  "add a LIMIT" error rather than silently truncating an app's data. */
export const APP_SQL_MAX_ROWS = 50_000;
/** The largest string or blob one statement may produce (16 MiB). */
export const APP_SQL_MAX_LENGTH = 16 * 1024 * 1024;

const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync, constants: C } = require('node:sqlite');
try {
  const { file, sql, params, mode, readOnly, maxRows, maxLength } = workerData;
  const db = new DatabaseSync(file, { readOnly, limits: { length: maxLength } });
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
  const stmt = db.prepare(sql);
  if (mode === 'run') {
    const r = stmt.run(...params);
    db.close();
    parentPort.postMessage({
      ok: true,
      result: { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) },
    });
  } else {
    const rows = [];
    for (const row of stmt.iterate(...params)) {
      if (rows.length >= maxRows) {
        throw new Error('the query returned more than ' + maxRows + ' rows: add a LIMIT or aggregate in SQL');
      }
      rows.push(row);
    }
    db.close();
    parentPort.postMessage({ ok: true, result: rows });
  }
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
`;

type Reply = { ok: true; result: unknown } | { ok: false; error: string };

/** Run `sql` with `params`: mode 'all' returns rows, 'run' returns
 *  `{ changes, lastInsertRowid }`. Rejects on SQL error, a refused statement,
 *  the row or size cap, or the time limit. */
export async function runAppSql(
  file: string,
  opts: {
    sql: string;
    params?: unknown[];
    mode: 'all' | 'run';
    readOnly: boolean;
    timeoutMs?: number;
  },
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? APP_SQL_TIMEOUT_MS;
  const reply = await new Promise<Reply>((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        file,
        sql: opts.sql,
        params: opts.params ?? [],
        mode: opts.mode,
        readOnly: opts.readOnly,
        maxRows: APP_SQL_MAX_ROWS,
        maxLength: APP_SQL_MAX_LENGTH,
      },
    });
    let settled = false;
    const settle = (r: Reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(
      () =>
        settle({
          ok: false,
          error: `the statement ran longer than ${timeoutMs} ms and was stopped: narrow it (add WHERE or LIMIT, avoid unbounded recursion)`,
        }),
      timeoutMs,
    );
    worker.once('message', (m: Reply) => settle(m));
    worker.once('error', (err: unknown) => settle({ ok: false, error: errorMessage(err) }));
    worker.once('exit', (code) => {
      if (code !== 0) settle({ ok: false, error: `the SQL worker exited with code ${code}` });
    });
  });
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}
