/**
 * The one write path of an app's own database (A10 #9): a write, and the
 * linked app-table exports' sync after it. Every writer of a running app's
 * rows goes through here: the owner's db broker, a member's
 * (server/web/lib/app-runner.ts), a contact link's (/s/:token/db-broker),
 * the login MCP's app_data_write, and the author's app_db_seed. Before,
 * each called appDbExec (or appDbSeedRows) and then
 * scheduleAppTableExportSync by hand; a writer that forgot the second call
 * left its app's Tables stale until the catch-up task. The scoreboard pins
 * the hand calls at 0 outside this file (handExportSyncCalls).
 *
 * The sync is scheduled in the caller's scope, as each writer did: a
 * member's and an MCP login's write run as system work ('app-data') around
 * the whole call; the owner's and a link's run as they always ran. The
 * export bookkeeping itself (the dirty stamp and the debounced sync) runs
 * as system(app-export) whoever wrote: a contact share's own actor writes
 * its app's data only (A8 matrix F9, migration 0294). Debounced and hash-gated
 * (app-table-exports.ts), so a chatty app costs no extra commits.
 *
 * Server-only (opens the app SQLite): imported as
 * `@mantle/content/app-db-write`, never from the content index.
 */
import {
  appDbExec,
  appDbSeedRows,
  markAppClientWritten,
  type AppDbCaller,
  type AppDbSchema,
  type AppDbSeedResult,
  type DbExecResult,
} from './app-broker';
import { scheduleAppTableExportSync } from './app-table-exports';

/** Where a write came from. `outside`: a contact on a share link, whose
 *  rows count as written from outside (app_databases.client_written_at), so
 *  a Table exported from them is never lowered as if the brain wrote it. */
export type AppDbWriteFrom = { outside?: boolean };

/** Run a write statement against the app's own database, then schedule its
 *  exports' sync. */
export async function appDbWrite(
  ownerId: string,
  appNodeId: string,
  sql: string,
  params: unknown[] = [],
  schema?: AppDbSchema,
  caller: AppDbCaller = {},
  from: AppDbWriteFrom = {},
): Promise<DbExecResult> {
  const res = await appDbExec(ownerId, appNodeId, sql, params, schema, caller);
  if (from.outside) await markAppClientWritten(ownerId, appNodeId);
  scheduleAppTableExportSync(ownerId, appNodeId);
  return res;
}

/** Load rows into one of the app's tables (app_db_seed), then schedule its
 *  exports' sync. */
export async function appDbSeed(
  ownerId: string,
  appNodeId: string,
  table: string,
  rows: Record<string, unknown>[],
  opts: { replace?: boolean } = {},
  schema?: AppDbSchema,
): Promise<AppDbSeedResult> {
  const res = await appDbSeedRows(ownerId, appNodeId, table, rows, opts, schema);
  scheduleAppTableExportSync(ownerId, appNodeId);
  return res;
}
