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
import { mkdir } from 'node:fs/promises';
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

async function openSqlite(file: string): Promise<SqliteDb> {
  const mod = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (p: string) => SqliteDb;
  };
  return new mod.DatabaseSync(file);
}

/** Statements an app must not run through the broker (file/engine escapes). */
const BLOCKED = /^\s*(attach|detach|vacuum\s+into|pragma)\b/i;
function assertSafe(sql: string): void {
  if (BLOCKED.test(sql)) {
    throw new Error('statement not allowed (ATTACH/DETACH/PRAGMA/VACUUM INTO are blocked)');
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
  try {
    const r = handle.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  } finally {
    handle.close();
  }
}
