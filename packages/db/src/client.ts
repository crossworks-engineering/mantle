import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';
import { env } from '@mantle/config';
import {
  currentViewerLevel,
  viewerDatabaseUrl,
  viewerRolePassword,
  type LimitedLevel,
} from './viewer';

declare global {
  var __mantleSql: ReturnType<typeof postgres> | undefined;

  var __mantleDb: PostgresJsDatabase<typeof schema> | undefined;

  /** One small pool per limited level (see viewer.ts), opened on first use. */
  var __mantleViewerDbs:
    | Map<LimitedLevel, { sql: ReturnType<typeof postgres>; db: PostgresJsDatabase<typeof schema> }>
    | undefined;
}

/** Connections per limited pool. Small on purpose: max_connections is 200
 *  and every process of a box opens its own pools. */
const VIEWER_POOL_MAX = 3;

/**
 * Lazy singleton. Initialised on first call so Next.js can build pages that
 * don't actually query the DB without DATABASE_URL set (e.g. /login).
 *
 * The pool MUST be cached in every environment. `db` (below) is a Proxy that
 * calls getDb() on every property access, so without a cache each access would
 * mint a fresh `postgres()` pool (max: 10) and leak connections without bound.
 * The cache used to be gated behind `NODE_ENV !== 'production'` (the usual
 * Next.js survive-HMR-in-dev idiom) — but that inverted the logic: in
 * production nothing was cached, so every query opened a new pool and the
 * long-lived workers/agent exhausted Postgres within seconds. Cache always;
 * globalThis is process-global, so one pool per process is exactly right.
 */
function getAdminDb(): PostgresJsDatabase<typeof schema> {
  if (globalThis.__mantleDb) return globalThis.__mantleDb;
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  const sql = globalThis.__mantleSql ?? postgres(url, { max: 10, prepare: false });
  globalThis.__mantleSql = sql;
  const client = drizzle(sql, { schema });
  globalThis.__mantleDb = client;
  return client;
}

/**
 * The limited pool for a viewer level: logs in as that level's LOGIN role,
 * so row level security filters every read. Fails loudly (never falls back to
 * the admin pool) when the master key is missing or the role cannot log in.
 */
function getViewerDb(level: LimitedLevel): PostgresJsDatabase<typeof schema> {
  const pools = (globalThis.__mantleViewerDbs ??= new Map());
  const cached = pools.get(level);
  if (cached) return cached.db;
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  const password = viewerRolePassword(env('MANTLE_MASTER_KEY') ?? '', level);
  const sql = postgres(viewerDatabaseUrl(url, level, password), {
    max: VIEWER_POOL_MAX,
    prepare: false,
  });
  const client = drizzle(sql, { schema });
  pools.set(level, { sql, db: client });
  return client;
}

/** The pool for the current viewer scope (viewer.ts): admin outside one. */
function getDb(): PostgresJsDatabase<typeof schema> {
  const level = currentViewerLevel();
  return level === 'admin' ? getAdminDb() : getViewerDb(level);
}

/**
 * Content handle. A Proxy that defers initialisation until the first property
 * access, and picks the pool per access: inside `withViewer(level, …)` it is
 * that level's limited pool, so row level security applies.
 */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_t, prop) {
    return Reflect.get(getDb() as object, prop);
  },
});

/**
 * Infrastructure handle: always the admin pool, whatever the viewer. For the
 * writes a limited turn still needs (traces, trace steps, tool-result spills,
 * pending tool calls, share counters, access logs). NEVER for content reads:
 * that would read past row level security. Only an allowlisted set of
 * infrastructure modules may import it.
 */
export const systemDb = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_t, prop) {
    return Reflect.get(getAdminDb() as object, prop);
  },
});

/**
 * End the pooled connections so a short-lived process can exit.
 *
 * Long-lived servers never call this — the pool is meant to outlive any single
 * request. One-shot CLI scripts MUST, because `postgres()` holds open sockets:
 * once the work is done the event loop still has a live handle and node never
 * exits. That failure is silent and expensive — the app-db and table-workbook
 * backup scripts finished their snapshots, printed their summary, then hung
 * forever; `db-dump.sh` runs `snapshot && tar` inside ONE `docker exec`, so the
 * tar was never reached and every archive landed 0 bytes while the run looked
 * clean. Any script that touches `db` and is expected to terminate needs this.
 *
 * Idempotent, and safe to call when the pool was never opened.
 */
export async function closeDb(): Promise<void> {
  const sql = globalThis.__mantleSql;
  const viewers = globalThis.__mantleViewerDbs;
  globalThis.__mantleSql = undefined;
  globalThis.__mantleDb = undefined;
  globalThis.__mantleViewerDbs = undefined;
  if (sql) await sql.end();
  if (viewers) await Promise.all([...viewers.values()].map((v) => v.sql.end()));
}

export type Db = PostgresJsDatabase<typeof schema>;
export { schema };
