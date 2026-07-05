/**
 * Per-app SQLite broker. Each app gets ONE durable SQLite database; the host
 * opens only the file registered for the matching app, so a sandboxed app can
 * never reach another app's data (there is no path input — only the
 * authenticated app node id, resolved to a registry row here).
 *
 * Uses the built-in `node:sqlite` (DatabaseSync) — no native dependency; works
 * on Node 24+ (prod) and 26 (dev). Dynamic-imported so merely importing content
 * elsewhere doesn't trip the experimental-module warning. Server-only.
 *
 * NOT re-exported from the package index — import via '@mantle/content/app-broker'
 * so it stays out of client/edge bundles.
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db, nodes, appDatabases } from '@mantle/db';

/** Root dir for per-app SQLite files. A dedicated volume in prod (see compose);
 *  defaults under the repo/cwd in dev. One file per app: <root>/<owner>/<app>.sqlite */
const ROOT = process.env.APP_DB_DIR ?? path.join(process.cwd(), '.app-dbs');

export type AppDbSchema = { schemaSql: string; schemaVersion: number };
export type DbRows = Record<string, unknown>[];
export type DbExecResult = { changes: number; lastInsertRowid: number };

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
  // Ensure the parent dir exists on EVERY open, not just first-provision. The
  // registry row persists the absolute storagePath in Postgres, but the file
  // lives on APP_DB_DIR — if that dir goes missing (a fresh/rotated volume, or
  // an ephemeral APP_DB_DIR wiped by a container recreate), `new DatabaseSync`
  // throws "unable to open database file" and the app hangs forever on its
  // initial load. mkdir-ing here self-heals to a fresh empty DB instead.
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
  //     consistent snapshot. Read-only opens (openSqliteReadOnly) read a WAL db
  //     fine — verified on the deployed runtime.
  //   synchronous=NORMAL — the safe+fast pairing WITH WAL: fsync at checkpoints
  //     rather than every commit. Durable across an app/process crash; only a
  //     host power/OS crash could lose the last transaction — an acceptable
  //     trade for app data, and materially faster.
  //   busy_timeout=5000 — still wait (not instantly fail) on the one lock WAL
  //     keeps: two concurrent writers to the same app DB.
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA synchronous = NORMAL');
  handle.exec('PRAGMA busy_timeout = 5000');
  return handle;
}

/** Open an app's SQLite file READ-ONLY. Any write throws at the ENGINE level
 *  ("attempt to write a readonly database"), so an agent-facing query tool
 *  cannot mutate app data no matter what SQL it sends — no SELECT-only regex to
 *  outsmart (SQLite allows DML inside CTEs; a regex guard would leak). Assumes
 *  the file exists (callers check) — read-only open never creates it. */
async function openSqliteReadOnly(file: string): Promise<SqliteDb> {
  const DatabaseSync = await sqliteCtor();
  const handle = new DatabaseSync(file, { readOnly: true });
  // busy_timeout is a connection setting (no file write), fine on a read-only
  // handle; wrap defensively in case a driver quirk rejects it.
  try {
    handle.exec('PRAGMA busy_timeout = 5000');
  } catch {
    /* readers rarely block; non-fatal */
  }
  return handle;
}

/** Statements an app must not run through the broker (file/engine escapes). */
const BLOCKED = /^\s*(attach|detach|vacuum\s+into|pragma)\b/i;
export function assertSafe(sql: string): void {
  if (BLOCKED.test(sql)) {
    throw new Error('statement not allowed (ATTACH/DETACH/PRAGMA/VACUUM INTO are blocked)');
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
async function ensureRegistry(
  ownerId: string,
  appNodeId: string,
): Promise<{ id: string; storagePath: string; schemaVersion: number }> {
  const [existing] = await db
    .select({ id: appDatabases.id, storagePath: appDatabases.storagePath, schemaVersion: appDatabases.schemaVersion })
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

  const storagePath = path.join(ROOT, ownerId, `${appNodeId}.sqlite`);
  await mkdir(path.dirname(storagePath), { recursive: true });
  await db
    .insert(appDatabases)
    .values({ ownerId, appNodeId, storagePath, schemaVersion: 0 })
    .onConflictDoNothing({ target: appDatabases.appNodeId });

  const [row] = await db
    .select({ id: appDatabases.id, storagePath: appDatabases.storagePath, schemaVersion: appDatabases.schemaVersion })
    .from(appDatabases)
    .where(eq(appDatabases.appNodeId, appNodeId))
    .limit(1);
  if (!row) throw new Error('failed to provision app database');
  return row;
}

/** Ensure the app's DB exists and its declared DDL has been applied (idempotent;
 *  applies only when the manifest schema version is newer than what's recorded). */
export async function ensureAppDatabase(
  ownerId: string,
  appNodeId: string,
  schema?: AppDbSchema,
): Promise<{ id: string; storagePath: string; schemaVersion: number }> {
  const reg = await ensureRegistry(ownerId, appNodeId);
  if (schema && schema.schemaSql.trim() && schema.schemaVersion > reg.schemaVersion) {
    // Defense in depth: the schema DDL is agent-authored and applied via a raw
    // multi-statement exec, so it must clear the same file-escape guard as the
    // runtime broker — otherwise an ATTACH in the DDL would reach the filesystem.
    assertSafeScript(schema.schemaSql);
    const handle = await openSqlite(reg.storagePath);
    try {
      handle.exec(schema.schemaSql);
    } finally {
      handle.close();
    }
    await db
      .update(appDatabases)
      .set({ schemaVersion: schema.schemaVersion, updatedAt: new Date() })
      .where(eq(appDatabases.id, reg.id));
    reg.schemaVersion = schema.schemaVersion;
  }
  return reg;
}

/** Run a read query against the app's own database. Returns row objects. */
export async function appDbQuery(
  ownerId: string,
  appNodeId: string,
  sql: string,
  params: unknown[] = [],
  schema?: AppDbSchema,
): Promise<DbRows> {
  assertSafe(sql);
  const reg = await ensureAppDatabase(ownerId, appNodeId, schema);
  const handle = await openSqlite(reg.storagePath);
  try {
    const rows = handle.prepare(sql).all(...params);
    return rows as DbRows;
  } finally {
    handle.close();
  }
}

/** Run a write statement against the app's own database. */
export async function appDbExec(
  ownerId: string,
  appNodeId: string,
  sql: string,
  params: unknown[] = [],
  schema?: AppDbSchema,
): Promise<DbExecResult> {
  assertSafe(sql);
  const reg = await ensureAppDatabase(ownerId, appNodeId, schema);
  const handle = await openSqlite(reg.storagePath);
  let res: DbExecResult;
  try {
    const r = handle.prepare(sql).run(...params);
    res = { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  } finally {
    handle.close();
  }
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
): Promise<{ storagePath: string } | null> {
  const [row] = await db
    .select({ storagePath: appDatabases.storagePath })
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
 * NOT an error, and never creates the file.
 */
export async function appDbReadQuery(
  ownerId: string,
  appNodeId: string,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: DbRows; empty: boolean }> {
  assertSafe(sql);
  const reg = await lookupAppDatabase(ownerId, appNodeId);
  if (!reg) return { rows: [], empty: true };
  try {
    await stat(reg.storagePath);
  } catch {
    return { rows: [], empty: true };
  }
  const handle = await openSqliteReadOnly(reg.storagePath);
  try {
    return { rows: handle.prepare(sql).all(...params) as DbRows, empty: false };
  } finally {
    handle.close();
  }
}

/** The app's live table/view schema, read from `sqlite_master` (the actual
 *  applied schema, not the declared DDL — so it can't drift). Empty when the app
 *  has no database file yet. */
export async function appDbSchema(ownerId: string, appNodeId: string): Promise<AppDbSchemaTable[]> {
  const reg = await lookupAppDatabase(ownerId, appNodeId);
  if (!reg) return [];
  try {
    await stat(reg.storagePath);
  } catch {
    return [];
  }
  const handle = await openSqliteReadOnly(reg.storagePath);
  try {
    const rows = handle
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name",
      )
      .all() as { name: string; sql: string }[];
    return rows.map((r) => ({ name: r.name, sql: r.sql }));
  } finally {
    handle.close();
  }
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

/** Build the `VACUUM INTO '<file>'` statement with the destination path safely
 *  single-quote-escaped. The path is server-derived (never app input), but we
 *  escape defensively so a stray quote can't break out of the literal. */
export function vacuumIntoStatement(destFile: string): string {
  return `VACUUM INTO '${destFile.replace(/'/g, "''")}'`;
}

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
      report.missing.push({ ownerId: r.ownerId, appNodeId: r.appNodeId, storagePath: r.storagePath });
      continue;
    }
    const destFile = snapshotDestPath(destDir, r.ownerId, r.appNodeId);
    try {
      await mkdir(path.dirname(destFile), { recursive: true });
      await rm(destFile, { force: true }); // VACUUM INTO refuses an existing target
      const handle = await openSqlite(r.storagePath);
      try {
        handle.exec(vacuumIntoStatement(destFile));
      } finally {
        handle.close();
      }
      const { size } = await stat(destFile);
      report.snapshotted.push({ ownerId: r.ownerId, appNodeId: r.appNodeId, bytes: size });
    } catch (err) {
      report.failed.push({
        ownerId: r.ownerId,
        appNodeId: r.appNodeId,
        error: err instanceof Error ? err.message : String(err),
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

/**
 * Remove an app's on-disk SQLite file(s). Called when the app node is deleted —
 * the `app_databases` registry row cascades away with the node, but the file on
 * the volume would otherwise leak. Best-effort + idempotent (`force` ignores a
 * missing file); no-op if the app never opened a database.
 */
export async function deleteAppDatabaseFile(ownerId: string, appNodeId: string): Promise<void> {
  const [row] = await db
    .select({ storagePath: appDatabases.storagePath })
    .from(appDatabases)
    .where(and(eq(appDatabases.appNodeId, appNodeId), eq(appDatabases.ownerId, ownerId)))
    .limit(1);
  if (!row) return;
  await Promise.all(appDbFiles(row.storagePath).map((f) => rm(f, { force: true })));
}
