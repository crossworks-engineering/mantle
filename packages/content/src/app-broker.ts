/**
 * Per-app SQLite broker. Each app gets ONE durable SQLite database; the host
 * opens only the file registered for the matching app, so a sandboxed app can
 * never reach another app's data (there is no path input — only the
 * authenticated app node id, resolved to a registry row here).
 *
 * Uses the built-in `node:sqlite` (DatabaseSync) — no native dependency; Node 26
 * in both dev and prod since 2026-07-25 (engines >=26). Dynamic-imported so
 * merely importing content elsewhere doesn't trip the experimental-module
 * warning. Server-only.
 *
 * NOT re-exported from the package index — import via '@mantle/content/app-broker'
 * so it stays out of client/edge bundles.
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { db, nodes, appDatabases } from '@mantle/db';
import { env } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { stripLiterals } from '@mantle/tabledb';
import {
  APP_SCHEMA_TIMEOUT_MS,
  APP_SQL_JOURNAL_LIMIT_BYTES,
  AppSqlError,
  appSqlMaxDbBytes,
  copyAppDbFile,
  runAppSql,
  runAppSqlBatch,
} from './app-sql-runner';
import {
  appViewerSalt,
  bindViewerParams,
  resolveAppViewer,
  type AppViewer,
  type AppViewerSubject,
} from './app-viewer';

export { AppSqlBusyError, AppSqlError } from './app-sql-runner';

/**
 * An app's database file is gone although the app had stored something in it
 * (a schema applied, or a write recorded). It is never recreated empty: an
 * empty file would hide the loss, and every later statement would fail with
 * "no such table" while nothing said why (apps audit 2026-10-02, D1). The
 * file has to come back from a backup or a snapshot.
 */
export class AppDbMissingError extends Error {
  constructor(appNodeId: string) {
    super(
      `the database file of app ${appNodeId} is missing on the server. The app had data, so it is not recreated empty: restore the file from a backup (scripts/app-dbs-restore.sh)`,
    );
    this.name = 'AppDbMissingError';
  }
}
export type { AppViewer, AppViewerSubject } from './app-viewer';

/** Root dir for per-app SQLite files. A dedicated volume in prod (see compose);
 *  one file per app: <root>/<owner>/<app>.sqlite. When APP_DB_DIR is unset
 *  (bare full-stack dev) anchor to a SINGLE monorepo-root `.app-dbs` so every
 *  workspace process resolves the same directory — a cwd-relative default
 *  splits web (cwd server/web) and api (cwd server/api) into two roots, the same
 *  split-brain that hit table-dbs (see packages/tabledb/src/paths.ts). */
let cachedRoot: string | undefined;
function appDbRoot(): string {
  if (cachedRoot) return cachedRoot;
  const configured = env('APP_DB_DIR');
  if (configured) return (cachedRoot = configured);
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  let root = process.cwd();
  for (let cur = dir; ;) {
    if (fs.existsSync(path.join(cur, 'pnpm-workspace.yaml'))) {
      root = cur;
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return (cachedRoot = path.join(root, '.app-dbs'));
}

export type AppDbSchema = { schemaSql: string; schemaVersion: number };
export type DbRows = Record<string, unknown>[];
export type DbExecResult = { changes: number; lastInsertRowid: number };
/** Who runs a broker statement: one statement at a time per key (a client
 *  login, a member login, a share link; client tier audit I1). `viewer` is
 *  the authenticated person (app identity): it fills the reserved
 *  `:host_me_*` parameters. Without it, SQL that uses one is refused. */
export type AppDbCaller = { callerKey?: string; viewer?: AppViewerSubject };

/** Minimal structural type for the bits of node:sqlite we use (keeps us
 *  independent of whether @types/node ships the declarations yet). */
type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  close(): void;
};
type SqliteCtor = new (p: string, opts?: { readOnly?: boolean }) => SqliteDb;

async function sqliteCtor(): Promise<SqliteCtor> {
  const mod = (await import('node:sqlite')) as unknown as { DatabaseSync: SqliteCtor };
  return mod.DatabaseSync;
}

async function openSqlite(file: string): Promise<SqliteDb> {
  const DatabaseSync = await sqliteCtor();
  // The parent dir may not exist yet for an app that never stored anything
  // (first provision). An app that DID store something and lost its file
  // never gets here: ensureAppDatabase refuses it first (AppDbMissingError).
  await mkdir(path.dirname(file), { recursive: true });
  const handle = new DatabaseSync(file);
  // Server-side PRAGMAs (not app-supplied SQL, so they bypass assertSafe by
  // design — the app can't set these itself):
  //   journal_mode=WAL — readers don't block writers and writers don't block
  //     readers (only writer-vs-writer serializes). Persistent (stored in the
  //     db header), so this both provisions new DBs and migrates existing ones
  //     to WAL on their next write-open; idempotent (a no-op once already WAL).
  //     Matters now that a single app DB has CONCURRENT users: team-mode shares
  //     (several members) and the responder's read-only queries running while
  //     the app writes. In the old rollback-journal mode those blocked each
  //     other and could hit SQLITE_BUSY; under WAL a reader just sees a
  //     consistent snapshot. Read-only opens (the SQL child's) read a WAL db
  //     fine — verified on the deployed runtime.
  //   synchronous=NORMAL — the safe+fast pairing WITH WAL: fsync at checkpoints
  //     rather than every commit. Durable across an app/process crash; only a
  //     host power/OS crash could lose the last transaction — an acceptable
  //     trade for app data, and materially faster.
  //   busy_timeout=5000 — still wait (not instantly fail) on the one lock WAL
  //     keeps: two concurrent writers to the same app DB.
  //   journal_size_limit / max_page_count: the same WAL and file caps the
  //     SQL runner sets on its writable opens (app-sql-runner.ts), so a seed
  //     cannot grow an app's file past APP_SQL_MAX_DB_MB either.
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA synchronous = NORMAL');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec(`PRAGMA journal_size_limit = ${APP_SQL_JOURNAL_LIMIT_BYTES}`);
  const [ps] = handle.prepare('PRAGMA page_size').all() as { page_size: number }[];
  const pageSize = Number(ps?.page_size) || 4096;
  handle.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(appSqlMaxDbBytes() / pageSize))}`);
  return handle;
}

/** Verbs an app must not use anywhere in a statement (file and engine
 *  escapes). Checked on the text with string literals and comments stripped
 *  (audit 2026-09-27: a leading SQL comment let VACUUM INTO pass a
 *  first-word check), and backed by the engine authorizer in
 *  app-sql-runner.ts, which is the real lock. */
const BLOCKED = /\b(attach|detach|vacuum|pragma)\b/i;
/**
 * The one PRAGMA family apps MAY run: read-only schema introspection
 * (`PRAGMA table_info(<table>)` / `table_xinfo`). Generated apps legitimately
 * need it for idempotent column migrations ("does this column exist yet?") —
 * and it reads the schema of the app's OWN db only: no file paths, no engine
 * settings, so none of the escapes the blanket PRAGMA ban exists for. Anchored
 * end-to-end (only an optional trailing `;`) so nothing can piggyback after
 * the closing paren.
 */
const INTROSPECTION =
  /^\s*pragma\s+table_x?info\s*\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*)\s*\)\s*;?\s*$/i;
export function assertSafe(sql: string): void {
  if (INTROSPECTION.test(sql)) return;
  if (BLOCKED.test(stripLiterals(sql))) {
    throw new AppSqlError(
      'statement not allowed (ATTACH/DETACH/PRAGMA/VACUUM are blocked; the one exception is read-only `PRAGMA table_info(<table>)`)',
    );
  }
}

/**
 * Guard a multi-statement script (the app's declared schema DDL). `assertSafe`
 * is anchored to the FIRST verb, so on its own it would wave through a piggyback
 * like `CREATE TABLE t(x); ATTACH DATABASE '…'`. Split on `;` and check each
 * statement so a blocked verb anywhere in the script is caught. We only scan
 * here — the DDL is still executed as one `exec()` — so a `;` inside a string
 * literal can over-split but never under-blocks (it can't hide a blocked verb).
 */
export function assertSafeScript(sql: string): void {
  for (const stmt of sql.split(';')) {
    if (stmt.trim()) assertSafe(stmt);
  }
}

/** Find or create the registry row + on-disk file for an app's database.
 *  Verifies the app node exists + is owned (defense in depth — the route also
 *  checks ownership before calling). */
type AppDbRegistry = { id: string; storagePath: string; schemaVersion: number; sizeBytes: number };

async function ensureRegistry(ownerId: string, appNodeId: string): Promise<AppDbRegistry> {
  const [existing] = await db
    .select({
      id: appDatabases.id,
      storagePath: appDatabases.storagePath,
      schemaVersion: appDatabases.schemaVersion,
      sizeBytes: appDatabases.sizeBytes,
    })
    .from(appDatabases)
    .where(eq(appDatabases.appNodeId, appNodeId))
    .limit(1);
  if (existing) return existing;

  const [app] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, appNodeId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')))
    .limit(1);
  if (!app) throw new Error(`app ${appNodeId} not found`);

  const storagePath = path.join(appDbRoot(), ownerId, `${appNodeId}.sqlite`);
  await mkdir(path.dirname(storagePath), { recursive: true });
  await db
    .insert(appDatabases)
    .values({ ownerId, appNodeId, storagePath, schemaVersion: 0 })
    .onConflictDoNothing({ target: appDatabases.appNodeId });

  const [row] = await db
    .select({
      id: appDatabases.id,
      storagePath: appDatabases.storagePath,
      schemaVersion: appDatabases.schemaVersion,
      sizeBytes: appDatabases.sizeBytes,
    })
    .from(appDatabases)
    .where(eq(appDatabases.appNodeId, appNodeId))
    .limit(1);
  if (!row) throw new Error('failed to provision app database');
  return row;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Whether the registry says this app stored something: a schema applied or
 *  a write recorded. Such a file must exist. */
function heldData(reg: { schemaVersion: number; sizeBytes: number }): boolean {
  return reg.schemaVersion > 0 || reg.sizeBytes > 0;
}

/** Refuse, loudly, an app whose file is gone although it held data. */
async function assertNotLost(
  appNodeId: string,
  reg: { storagePath: string; schemaVersion: number; sizeBytes: number },
): Promise<void> {
  if (!heldData(reg) || (await fileExists(reg.storagePath))) return;
  console.error(
    `[app-broker] app ${appNodeId}: database file missing at ${reg.storagePath} (schema v${reg.schemaVersion}, ${reg.sizeBytes} bytes recorded); refusing to recreate it empty`,
  );
  throw new AppDbMissingError(appNodeId);
}

/** Ensure the app's DB exists and its declared DDL has been applied (idempotent;
 *  applies only when the manifest schema version is newer than what's recorded).
 *  Refuses an app whose file is gone although it held data (AppDbMissingError). */
export async function ensureAppDatabase(
  ownerId: string,
  appNodeId: string,
  schema?: AppDbSchema,
): Promise<AppDbRegistry> {
  const reg = await ensureRegistry(ownerId, appNodeId);
  await assertNotLost(appNodeId, reg);
  if (schema && schema.schemaSql.trim() && schema.schemaVersion > reg.schemaVersion) {
    // Defense in depth: the schema DDL is agent-authored, so it must clear the
    // same file-escape guard as the runtime broker, and then runs in the
    // child-process runner like every other app statement: the engine
    // authorizer refuses ATTACH, VACUUM and PRAGMA whatever the text looks
    // like, and a time limit stops an endless statement without freezing
    // this process (it used to run here, on the main thread, with no timeout).
    assertSafeScript(schema.schemaSql);
    await applySchema(reg, schema);
  }
  return reg;
}

/**
 * Apply one schema version, once, across processes (apps audit D3). The web
 * and api processes can both reach a new version at the same moment; the row
 * lock makes the second wait and then see the version already applied. The
 * script stamps its version into the file in the same SQLite transaction
 * (user_version), so a crash between that commit and the registry update
 * leaves a file the next run recognises and skips, instead of a script that
 * fails on "already exists" for ever.
 *
 * Applied atomically ('script' mode wraps it in one transaction): SQLite
 * autocommits each statement, so a bare multi-statement exec failing on
 * statement 3 would leave 1-2 committed while the version stays old.
 */
async function applySchema(reg: AppDbRegistry, schema: AppDbSchema): Promise<void> {
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ schemaVersion: appDatabases.schemaVersion })
      .from(appDatabases)
      .where(eq(appDatabases.id, reg.id))
      .for('update');
    if (!locked) throw new Error('the app database registry row is gone');
    if (locked.schemaVersion >= schema.schemaVersion) {
      reg.schemaVersion = locked.schemaVersion;
      return;
    }
    await mkdir(path.dirname(reg.storagePath), { recursive: true });
    await runAppSql(reg.storagePath, {
      sql: schema.schemaSql,
      mode: 'script',
      readOnly: false,
      timeoutMs: APP_SCHEMA_TIMEOUT_MS,
      userVersion: schema.schemaVersion,
    });
    await tx
      .update(appDatabases)
      .set({ schemaVersion: schema.schemaVersion, updatedAt: new Date() })
      .where(
        and(eq(appDatabases.id, reg.id), lt(appDatabases.schemaVersion, schema.schemaVersion)),
      );
    reg.schemaVersion = schema.schemaVersion;
  });
}

/**
 * Try a new schema script against a COPY of the app's live database before it
 * is declared (apps audit D2). A declared schema runs in full against the live
 * file on the app's next statement, so a script that fails there (a plain
 * CREATE TABLE over a table that exists, a syntax error) stops every read and
 * write of the app until someone fixes it. Here it fails on the copy, and the
 * author hears why while nothing changed. The copy is a VACUUM INTO in a SQL
 * child (consistent under WAL, off the event loop) and is removed after. An
 * app with no file yet is tried on an empty database.
 */
export async function checkAppSchemaScript(
  ownerId: string,
  appNodeId: string,
  schemaSql: string,
): Promise<void> {
  assertSafeScript(schemaSql);
  const reg = await lookupAppDatabase(ownerId, appNodeId);
  if (reg) await assertNotLost(appNodeId, reg);
  const dir = reg ? path.dirname(reg.storagePath) : path.join(appDbRoot(), ownerId);
  await mkdir(dir, { recursive: true });
  const trial = path.join(dir, `.schema-check-${appNodeId}-${process.pid}-${Date.now()}.sqlite`);
  try {
    if (reg && (await fileExists(reg.storagePath))) await copyAppDbFile(reg.storagePath, trial);
    await runAppSql(trial, {
      sql: schemaSql,
      mode: 'script',
      readOnly: false,
      timeoutMs: APP_SCHEMA_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof AppSqlError) {
      throw new AppSqlError(
        `the schema fails against the app's current database, so it was not declared: ${err.message}. The whole script runs again on every new version: write it so it can run over the existing tables (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS)`,
      );
    }
    throw err;
  } finally {
    await Promise.all(appDbFiles(trial).map((f) => rm(f, { force: true })));
  }
}

/** The viewer resolver for a broker statement, or null when the caller
 *  named no person (bindViewerParams then refuses the reserved names). */
function viewerThunk(
  ownerId: string,
  appNodeId: string,
  registryId: string,
  opts: AppDbCaller,
): (() => Promise<AppViewer>) | null {
  const subject = opts.viewer;
  if (!subject) return null;
  return () => resolveAppViewer(ownerId, subject, () => appViewerSalt(registryId, appNodeId));
}

/**
 * What `host.me()` answers for this person in this app (app identity): the
 * frame routes bake it into the frame document. Provisions the app's
 * registry row (cheap, idempotent) when the id needs the app's salt.
 */
export async function appViewerFor(
  ownerId: string,
  appNodeId: string,
  subject: AppViewerSubject,
): Promise<AppViewer> {
  return resolveAppViewer(ownerId, subject, async () => {
    const reg = await ensureRegistry(ownerId, appNodeId);
    return appViewerSalt(reg.id, appNodeId);
  });
}

/** Run a read query against the app's own database. Returns row objects.
 *
 *  Opens READ-ONLY. This is load-bearing, not an optimisation: SQLite happily
 *  executes DML through `prepare(sql).all()`, and both db-broker routes map
 *  op:'query' here — including for PUBLIC share visitors, whose op:'exec' is
 *  rejected with a "shared apps are read-only" promise. A read-write open would
 *  let `{op:'query', sql:'DELETE FROM t'}` mutate the owner's app database
 *  anyway. Engine-level read-only closes that for any SQL (same rationale as
 *  the child's read-only open: no SELECT-only regex to outsmart). Writes go through
 *  appDbExec (op:'exec'), which the routes gate. */
export async function appDbQuery(
  ownerId: string,
  appNodeId: string,
  sql: string,
  params: unknown[] = [],
  schema?: AppDbSchema,
  opts: AppDbCaller = {},
): Promise<DbRows> {
  assertSafe(sql);
  const reg = await ensureAppDatabase(ownerId, appNodeId, schema);
  const bound = await bindViewerParams(sql, params, viewerThunk(ownerId, appNodeId, reg.id, opts));
  // A read-only open never creates the file. On an app's very first query
  // (no declared DDL applied, nothing written yet) provision the empty DB
  // with a normal open first, so the read-only open has a file to attach.
  if (!(await fileExists(reg.storagePath))) (await openSqlite(reg.storagePath)).close();
  return (await runAppSql(reg.storagePath, {
    sql,
    params: bound,
    mode: 'all',
    readOnly: true,
    ...(opts.callerKey ? { callerKey: opts.callerKey } : {}),
  })) as DbRows;
}

/** Run a write statement against the app's own database. */
export async function appDbExec(
  ownerId: string,
  appNodeId: string,
  sql: string,
  params: unknown[] = [],
  schema?: AppDbSchema,
  opts: AppDbCaller = {},
): Promise<DbExecResult> {
  assertSafe(sql);
  const reg = await ensureAppDatabase(ownerId, appNodeId, schema);
  const bound = await bindViewerParams(sql, params, viewerThunk(ownerId, appNodeId, reg.id, opts));
  await mkdir(path.dirname(reg.storagePath), { recursive: true });
  const res = (await runAppSql(reg.storagePath, {
    sql,
    params: bound,
    mode: 'run',
    readOnly: false,
    ...(opts.callerKey ? { callerKey: opts.callerKey } : {}),
  })) as DbExecResult;
  // Best-effort: keep the registry's size_bytes truthful after a write (a write
  // is the only thing that grows the file). Never fail the exec over this.
  try {
    const { size } = await stat(reg.storagePath);
    await db
      .update(appDatabases)
      .set({ sizeBytes: size, updatedAt: new Date() })
      .where(eq(appDatabases.id, reg.id));
  } catch {
    /* size tracking is best-effort */
  }
  return res;
}

/**
 * Record that a CLIENT login wrote this app's database (client tier audit
 * I3): set once, on the first client write, and never cleared, so a Table
 * exported from the app stays client-sourced after the app is raised above
 * client (packages/tools/src/client-sourced.ts). The client db-broker calls
 * it after a successful exec, so the registry row exists.
 */
export async function markAppClientWritten(ownerId: string, appNodeId: string): Promise<void> {
  await db
    .update(appDatabases)
    .set({ clientWrittenAt: new Date() })
    .where(
      and(
        eq(appDatabases.appNodeId, appNodeId),
        eq(appDatabases.ownerId, ownerId),
        isNull(appDatabases.clientWrittenAt),
      ),
    );
}

// ── Bulk seeding (authoring tools) ───────────────────────────────────────────

export type AppDbSeedResult = {
  inserted: number;
  deleted: number;
  table: string;
  columns: string[];
};

/** SQLite identifier we accept for a seed target table (no quoting tricks). */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why a seed's target table is refused: a bad name, or not in the app's
 *  database (with the tables that are). */
function seedTableError(table: string, knownTables: string[] | null): Error {
  if (knownTables === null) {
    return new Error(
      `table '${table}' is not a valid table name — use the exact name from the declared schema (app_db_schema_set)`,
    );
  }
  return new Error(
    `table '${table}' does not exist in this app's database — declare it via app_db_schema_set first` +
      (knownTables.length ? ` (existing tables: ${knownTables.join(', ')})` : ''),
  );
}

/** Whether `table` may be a seed target at all (no quoting tricks, no
 *  SQLite internals). */
export function isSeedTableName(table: string): boolean {
  return TABLE_NAME.test(table) && !table.toLowerCase().startsWith('sqlite_');
}

/**
 * The seed plan: every row checked against the LIVE `columns`, then one
 * INSERT per row (an empty `DELETE` first with `replace`). Pure, so the rules
 * are testable without a file; the statements run in one transaction in a
 * SQL child (apps audit P5: the seed used to run on the main thread, where a
 * writer holding the file's lock could stall the whole process for up to
 * busy_timeout). Values must be string/number/boolean/null (booleans stored
 * as 1/0).
 */
export function planSeedStatements(
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  opts: { replace?: boolean } = {},
): { sql: string; params: unknown[] }[] {
  if (!isSeedTableName(table)) throw seedTableError(table, null);
  const colSet = new Set(columns);
  const statements: { sql: string; params: unknown[] }[] = [];
  if (opts.replace) statements.push({ sql: `DELETE FROM "${table}"`, params: [] });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? {};
    const keys = Object.keys(row);
    if (!keys.length) throw new Error(`row ${i} is empty — every row needs at least one column`);
    const values: unknown[] = [];
    for (const k of keys) {
      if (!colSet.has(k)) {
        throw new Error(
          `row ${i} has unknown column '${k}' — this table's columns are: ${columns.join(', ')}`,
        );
      }
      const v = row[k];
      if (v === null || v === undefined) values.push(null);
      else if (typeof v === 'boolean') values.push(v ? 1 : 0);
      else if (typeof v === 'string' || typeof v === 'number') values.push(v);
      else {
        throw new Error(
          `row ${i} column '${k}' has a ${Array.isArray(v) ? 'array' : typeof v} value — seed values must be string, number, boolean, or null (JSON-encode nested data yourself if the column stores it)`,
        );
      }
    }
    const colList = keys.map((k) => `"${k}"`).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    statements.push({
      sql: `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
      params: values,
    });
  }
  return statements;
}

/**
 * Bulk-insert rows into ONE table of an app's own database, atomically — the
 * authoring-time counterpart of the app's runtime `host.db.exec`, so an agent
 * can load reference data without routing thousands of single-row execs through
 * the iframe bridge. Provisions the DB (applying the declared DDL) when this is
 * the first touch. All-or-nothing: any bad row rolls the whole batch back.
 */
export async function appDbSeedRows(
  ownerId: string,
  appNodeId: string,
  table: string,
  rows: Record<string, unknown>[],
  opts: { replace?: boolean } = {},
  schema?: AppDbSchema,
): Promise<AppDbSeedResult> {
  if (!isSeedTableName(table)) throw seedTableError(table, null);
  const reg = await ensureAppDatabase(ownerId, appNodeId, schema);
  if (!(await fileExists(reg.storagePath))) (await openSqlite(reg.storagePath)).close();
  const read = (sql: string) =>
    runAppSql(reg.storagePath, { sql, mode: 'all', readOnly: true }) as Promise<DbRows>;
  const columns = (await read(`PRAGMA table_info("${table}")`)).map((c) => String(c.name));
  if (!columns.length) {
    const known = (
      await read(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
    ).map((t) => String(t.name));
    throw seedTableError(table, known);
  }
  const changes = await runAppSqlBatch(
    reg.storagePath,
    planSeedStatements(table, columns, rows, opts),
  );
  // Same best-effort size tracking as appDbExec.
  try {
    const { size } = await stat(reg.storagePath);
    await db
      .update(appDatabases)
      .set({ sizeBytes: size, updatedAt: new Date() })
      .where(eq(appDatabases.id, reg.id));
  } catch {
    /* size tracking is best-effort */
  }
  return {
    inserted: rows.length,
    deleted: opts.replace ? (changes[0] ?? 0) : 0,
    table,
    columns,
  };
}

// ── Read-only access (agent tools) ──────────────────────────────────────────

export type AppDbSchemaTable = { name: string; sql: string };
export type AppDbSummary = {
  appNodeId: string;
  title: string;
  sizeBytes: number;
  updatedAt: string;
};

/** Owner-scoped registry lookup that creates NOTHING (unlike ensureRegistry).
 *  Returns null when the app has no database registered for this owner. */
async function lookupAppDatabase(
  ownerId: string,
  appNodeId: string,
): Promise<{ storagePath: string; schemaVersion: number; sizeBytes: number } | null> {
  const [row] = await db
    .select({
      storagePath: appDatabases.storagePath,
      schemaVersion: appDatabases.schemaVersion,
      sizeBytes: appDatabases.sizeBytes,
    })
    .from(appDatabases)
    .where(and(eq(appDatabases.appNodeId, appNodeId), eq(appDatabases.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/**
 * Run a READ query against an app's own SQLite for an AGENT (not the app's own
 * runtime). Opens read-only so no statement can mutate; `assertSafe` still
 * blocks ATTACH/DETACH/PRAGMA/VACUUM INTO (a read-only ATTACH would still let
 * the query read ANOTHER file). An app with no database yet (no registry row,
 * or the file never materialized because nothing was written) returns empty —
 * NOT an error, and never creates the file. An app whose file is gone although
 * it held data throws AppDbMissingError: "no rows" would be a lie.
 */
export async function appDbReadQuery(
  ownerId: string,
  appNodeId: string,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: DbRows; empty: boolean }> {
  assertSafe(sql);
  // No person runs the app here: SQL that uses a :host_me_* parameter is
  // refused, and so is a caller-sent value for one.
  const bound = await bindViewerParams(sql, params, null);
  const reg = await lookupAppDatabase(ownerId, appNodeId);
  if (!reg) return { rows: [], empty: true };
  await assertNotLost(appNodeId, reg);
  if (!(await fileExists(reg.storagePath))) return { rows: [], empty: true };
  const rows = (await runAppSql(reg.storagePath, {
    sql,
    params: bound,
    mode: 'all',
    readOnly: true,
  })) as DbRows;
  return { rows, empty: false };
}

/** The app's live table/view schema, read from `sqlite_master` (the actual
 *  applied schema, not the declared DDL — so it can't drift). Empty when the app
 *  has no database file yet. */
export async function appDbSchema(ownerId: string, appNodeId: string): Promise<AppDbSchemaTable[]> {
  const reg = await lookupAppDatabase(ownerId, appNodeId);
  if (!reg) return [];
  await assertNotLost(appNodeId, reg);
  if (!(await fileExists(reg.storagePath))) return [];
  // In a SQL child, read-only (apps audit P5): not on the main thread.
  const rows = (await runAppSql(reg.storagePath, {
    sql: "SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name",
    mode: 'all',
    readOnly: true,
  })) as { name: string; sql: string }[];
  return rows.map((r) => ({ name: r.name, sql: r.sql }));
}

/** Every app of this owner that has a registered database, with its title +
 *  size — the agent's discovery list for "what can I query". */
export async function listAppDatabaseSummaries(ownerId: string): Promise<AppDbSummary[]> {
  const rows = await db
    .select({
      appNodeId: appDatabases.appNodeId,
      sizeBytes: appDatabases.sizeBytes,
      updatedAt: appDatabases.updatedAt,
      title: nodes.title,
    })
    .from(appDatabases)
    .innerJoin(nodes, eq(nodes.id, appDatabases.appNodeId))
    .where(eq(appDatabases.ownerId, ownerId));
  return rows.map((r) => ({
    appNodeId: r.appNodeId,
    title: r.title,
    sizeBytes: r.sizeBytes,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

// ── Backup ───────────────────────────────────────────────────────────────────

export type AppDbSnapshotEntry = { ownerId: string; appNodeId: string; bytes: number };
export type AppDbSnapshotReport = {
  snapshotted: AppDbSnapshotEntry[];
  /** Registry rows whose file is absent — already-lost data, NOT snapshotted. */
  missing: { ownerId: string; appNodeId: string; storagePath: string }[];
  /** Rows that errored on open/vacuum (e.g. lock contention past busy_timeout). */
  failed: { ownerId: string; appNodeId: string; error: string }[];
};

/** Where an app's snapshot lands under destDir — mirrors the live layout
 *  (<destDir>/<owner>/<app>.sqlite) so a restore drops straight back into
 *  APP_DB_DIR without any path rewriting. */
export function snapshotDestPath(destDir: string, ownerId: string, appNodeId: string): string {
  return path.join(destDir, ownerId, `${appNodeId}.sqlite`);
}

/**
 * Consistent-snapshot EVERY registered per-app SQLite database into destDir via
 * `VACUUM INTO` — SQLite's online-backup primitive, so each snapshot is a
 * transactionally consistent, compacted copy even while an app writes
 * concurrently (no raw-file copy race, no sqlite3 CLI dependency). The per-app
 * files live on a separate volume from Postgres, so `pg_dump` alone misses
 * them; this is what folds them into the backup.
 *
 * Returns a report so the caller surfaces partial failures LOUDLY — a backup
 * that silently skips a database is exactly the durability gap this closes. A
 * registry row whose file is gone is reported as `missing` rather than letting
 * openSqlite's self-heal mkdir back up a phantom empty DB.
 */
export async function snapshotAllAppDatabases(destDir: string): Promise<AppDbSnapshotReport> {
  const rows = await db
    .select({
      ownerId: appDatabases.ownerId,
      appNodeId: appDatabases.appNodeId,
      storagePath: appDatabases.storagePath,
    })
    .from(appDatabases);
  const report: AppDbSnapshotReport = { snapshotted: [], missing: [], failed: [] };
  for (const r of rows) {
    try {
      await stat(r.storagePath);
    } catch {
      report.missing.push({
        ownerId: r.ownerId,
        appNodeId: r.appNodeId,
        storagePath: r.storagePath,
      });
      continue;
    }
    const destFile = snapshotDestPath(destDir, r.ownerId, r.appNodeId);
    try {
      await mkdir(path.dirname(destFile), { recursive: true });
      await rm(destFile, { force: true }); // VACUUM INTO refuses an existing target
      // In a SQL child (apps audit P5): a 256 MB VACUUM INTO on the main
      // thread froze the process that runs the backup.
      await copyAppDbFile(r.storagePath, destFile);
      const { size } = await stat(destFile);
      report.snapshotted.push({ ownerId: r.ownerId, appNodeId: r.appNodeId, bytes: size });
    } catch (err) {
      report.failed.push({
        ownerId: r.ownerId,
        appNodeId: r.appNodeId,
        error: errorMessage(err),
      });
    }
  }
  return report;
}

/** Every on-disk file SQLite may create for one database: the file itself plus
 *  the rollback-journal / WAL sidecars. We clean all of them on delete. */
export function appDbFiles(storagePath: string): string[] {
  return ['', '-journal', '-wal', '-shm'].map((suffix) => `${storagePath}${suffix}`);
}

/** Where an app's database file lives, or null when it never had one. Read
 *  BEFORE the app is deleted: the registry row cascades away with the node. */
export async function appDatabasePath(ownerId: string, appNodeId: string): Promise<string | null> {
  return (await lookupAppDatabase(ownerId, appNodeId))?.storagePath ?? null;
}

/**
 * Remove an app's on-disk SQLite file(s), given the path read before the app
 * was deleted (apps audit D6: the files go AFTER the node, so a delete that
 * fails leaves the app with its data, never an app with none). Idempotent
 * (`force` ignores a missing file).
 */
export async function removeAppDatabaseFiles(storagePath: string): Promise<void> {
  await Promise.all(appDbFiles(storagePath).map((f) => rm(f, { force: true })));
}
