/**
 * The pools of a process: the system pool (getAdminDb) with its actor
 * client, the limited pools of the workspace roles (getViewerDb), the write
 * role's pool size and switch (openLoginWritePool), and closeDb. The one
 * owner of every globalThis.__mantle* key.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../schema/index';
import { env, feature, isProduction } from '@mantle/config';
import {
  DB_ROLE_SQL,
  dbRoleNote,
  narrowSystemOn,
  runtimeRoleOn,
  systemDatabaseUrl,
  type DbRoleRow,
} from '../runtime-role';
import { systemRouteNow, viewerDatabaseUrl, viewerRolePassword, type PoolRole } from '../viewer';
import {
  forgetBoxActorCheckMode,
  onPgNotice,
  runAsSystem,
  runWithoutActor,
  setActorMissLogger,
  type ActorMiss,
} from '../actor';
import { ACTOR_SQL_TAG, forgetActorCheckModePool, refreshActorCheckMode } from './check-mode';
import { actorClient, actorPipelinesDone } from './actor-sql';
import { narrowRouteClient } from './narrow-route';

type PgSql = ReturnType<typeof postgres>;

declare global {
  var __mantleSql: ReturnType<typeof postgres> | undefined;

  var __mantleDb: PostgresJsDatabase<typeof schema> | undefined;

  /** The workspace role's small pool (see viewer.ts), opened on first use. */
  var __mantleViewerDbs:
    | Map<PoolRole, { sql: ReturnType<typeof postgres>; db: PostgresJsDatabase<typeof schema> }>
    | undefined;

  /** The turn-scope handle (workspaces W4b), over the workspace role's pool. */
  var __mantleTurnDb: PostgresJsDatabase<typeof schema> | undefined;

  /** This process sends scoped login writes to the write role
   *  (openLoginWritePool, arch A2b2b). */
  var __mantleLoginWritePool: boolean | undefined;

  /** The write role's pool size in this process (openLoginWritePool's
   *  `max`; VIEWER_POOL_MAX when not given). */
  var __mantleLoginWritePoolMax: number | undefined;
}

/** Connections of a limited pool, per process and role. Small on purpose:
 *  every process of a box opens its own pools, and their sum must stay under
 *  the box's max_connections (the connection ceiling, task 29008b01).
 *  The write role's pool (getViewerDb('write')) opens only in the processes
 *  that call openLoginWritePool, at the size each asks for (at most this). */
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
export function getAdminDb(): PostgresJsDatabase<typeof schema> {
  if (globalThis.__mantleDb) return globalThis.__mantleDb;
  // DATABASE_URL, or the runtime role on it (arch A9, runtime-role.ts).
  const url = systemDatabaseUrl();
  // onnotice: an item table's write trigger reports a statement with no
  // actor as a NOTICE (0275); every other notice prints as postgres.js's
  // default does.
  const sql =
    globalThis.__mantleSql ?? postgres(url, { max: 10, prepare: false, onnotice: onPgNotice });
  globalThis.__mantleSql = sql;
  // The narrow route (plan v3.2 S7a): its switch read once, here, and
  // logged; a statement of a reason routed 'narrow' runs as the narrow role.
  const narrow = narrowSystemOn();
  const withActor = narrowRouteClient(
    actorClient(sql),
    sql,
    () => narrow && systemRouteNow() === 'narrow',
  );
  adminActorSql = withActor;
  const client = drizzle(withActor, { schema });
  globalThis.__mantleDb = client;
  setActorMissLogger(logActorMiss);
  // Out of the caller's context: the timer must not keep its actor.
  runWithoutActor(() => {
    refreshActorCheckMode(sql);
    reportDbRole(sql);
  });
  return client;
}

/** Who the system pool logs in as (arch A9, DB_ROLE_SQL), asked on the
 *  system pool itself whatever scope the caller is in: system health
 *  reports it. Null when the pool cannot answer. */
export async function systemPoolRole(): Promise<DbRoleRow | null> {
  try {
    // A read on the raw pool: no actor, no scope.
    const rows = await rawAdminSql().unsafe(`${ACTOR_SQL_TAG} ${DB_ROLE_SQL}`);
    return (rows[0] as DbRoleRow | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Who the system pool logs in as, once per process at its start (arch A9):
 *  a warning on a box whose app runs as the superuser (MANTLE_DB_RUNTIME_ROLE
 *  off), or as any role but the runtime role. Production only (a test
 *  process opens many pools); never in a statement's path. */
function reportDbRole(base: PgSql): void {
  if (!isProduction()) return;
  base
    .unsafe(`${ACTOR_SQL_TAG} ${DB_ROLE_SQL}`)
    .then((rows) => {
      const row = rows[0] as DbRoleRow | undefined;
      if (!row) return;
      const note = dbRoleNote(row, runtimeRoleOn());
      // The narrow route's switch, read once when the pool opened.
      const narrow = `; narrow system route ${narrowSystemOn() ? 'on' : 'off'} (MANTLE_NARROW_SYSTEM)`;
      if (note) console.warn(`${note}${narrow}`);
      else
        console.log(`[db] the system pool logs in as ${row.user} (arch A9 runtime role)${narrow}`);
    })
    .catch(() => {});
}

/** The system pool's client with the actor (actorClient over
 *  globalThis.__mantleSql): the login write gateway's system path. */
let adminActorSql: PgSql | null = null;

/** The system pool's handle on the narrow route, always (getNarrowDb). */
let narrowDb: PostgresJsDatabase<typeof schema> | null = null;

/**
 * The system pool's drizzle handle whose every statement runs on the
 * narrow route (plan v3.2 S7a): systemDb's inside a turn or request scope
 * while the switch is on (gateway/handles.ts). The caller asks the switch.
 */
export function getNarrowDb(): PostgresJsDatabase<typeof schema> {
  getAdminDb();
  const sql = globalThis.__mantleSql!;
  return (narrowDb ??= drizzle(
    narrowRouteClient(actorClient(sql), sql, () => true),
    { schema },
  ));
}

/** Write a miss row later, on another connection (20.3 item 7): never in
 *  the transaction that missed, so it assigns that one no transaction id. */
function logActorMiss(miss: ActorMiss): void {
  setImmediate(() => {
    const sql = globalThis.__mantleSql;
    if (!sql) return;
    runAsSystem('actor-check', () =>
      sql
        .unsafe('select "public"."mantle_actor_miss_log"($1, $2, $3, $4)', [
          miss.source,
          miss.check,
          miss.actor,
          miss.detail,
        ])
        .catch(() => {}),
    );
  });
}

/**
 * The limited pool: logs in as the workspace LOGIN role, so row level
 * security filters every read. Fails loudly (never falls back to the admin
 * pool) when the master key is missing or the role cannot log in.
 */
export function getViewerDb(level: PoolRole): PostgresJsDatabase<typeof schema> {
  const pools = (globalThis.__mantleViewerDbs ??= new Map());
  const cached = pools.get(level);
  if (cached) return cached.db;
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  const password = viewerRolePassword(env('MANTLE_MASTER_KEY') ?? '', level);
  const perDatabase = feature('viewerRolesPerDatabase');
  const sql = postgres(viewerDatabaseUrl(url, level, password, perDatabase), {
    // The write role's: the size this process opened it at (openLoginWritePool).
    max: level === 'write' ? loginWritePoolMax() : VIEWER_POOL_MAX,
    prepare: false,
    // No JIT on a scoped connection (W7a): a row rule raises the planner's
    // cost estimate past jit_above_cost, so a vector search that reads 50
    // rows paid about 13 ms of compiling on a large brain copy (5 ms without,
    // 3 ms on the system pool). Scoped reads are small; JIT never pays here.
    connection: { jit: 'off' },
    // A write check's refusal the box mode lets through (off and warn on
    // the write role, 0278) arrives as a NOTICE: a miss, as on the system
    // pool. Every other notice prints as postgres.js's default does.
    onnotice: onPgNotice,
  });
  const client = drizzle(sql, { schema });
  pools.set(level, { sql, db: client });
  return client;
}

/**
 * Open the login write gateway in this process (arch A2b2b): every process
 * that runs a login's tool or request writes in a workspace scope, so the
 * database's write and edit checks hold them there as they do in web:
 *
 *  - web and api (server/web/server/main.ts, server/api/src/main.ts):
 *    VIEWER_POOL_MAX each;
 *  - the runs worker (server/web/workers/runs.ts: a run item's tool call,
 *    in withRunScope) and the stdio MCP server (server/mcp/src/server.ts:
 *    each call in the anchor login's turn scope): `max: 2` each.
 *
 * The role's connection limit is 20 (viewer-roles.ts), shared by every
 * process of a box; connection-ceiling.test.ts counts the pool for each
 * process that calls this, at the size it asks for, and fails on any other
 * caller. `max` is read when the pool opens (the first write on the role):
 * call this at the process's start. Tests open it in vitest.setup.ts.
 */
export function openLoginWritePool(opts: { max?: number } = {}): void {
  const max = opts.max ?? VIEWER_POOL_MAX;
  if (!Number.isInteger(max) || max < 1 || max > VIEWER_POOL_MAX) {
    throw new Error(`openLoginWritePool: max must be 1 to ${VIEWER_POOL_MAX}`);
  }
  globalThis.__mantleLoginWritePool = true;
  globalThis.__mantleLoginWritePoolMax = max;
}

/** The write role's pool size in this process (openLoginWritePool). */
function loginWritePoolMax(): number {
  return globalThis.__mantleLoginWritePoolMax ?? VIEWER_POOL_MAX;
}

/** Whether this process sends login writes to the write role. */
export function loginWritePoolOpen(): boolean {
  return globalThis.__mantleLoginWritePool === true;
}

/** The write role's raw pool (getViewerDb('write')). */
export function writePoolSql(): PgSql {
  getViewerDb('write');
  return globalThis.__mantleViewerDbs!.get('write')!.sql;
}

/** The system pool's client with the actor: the gateway's system path. */
export function adminSql(): PgSql {
  getAdminDb();
  return adminActorSql!;
}

/** The system pool's raw client, no actor (brokerLockTx). */
export function rawAdminSql(): PgSql {
  getAdminDb();
  return globalThis.__mantleSql!;
}

/** The turn-scope handle (globalThis.__mantleTurnDb): built once per
 *  process by `make` over the workspace role's pool. */
export function turnScopedDbOnce(
  make: (base: PgSql) => PostgresJsDatabase<typeof schema>,
): PostgresJsDatabase<typeof schema> {
  if (globalThis.__mantleTurnDb) return globalThis.__mantleTurnDb;
  getViewerDb('user');
  const base = globalThis.__mantleViewerDbs!.get('user')!.sql;
  const client = make(base);
  globalThis.__mantleTurnDb = client;
  return client;
}

/** The resets closeDb runs for the handles cached over these pools in
 *  other modules, each registered once by its owner (onCloseDb). */
const closeResets: Array<() => void> = [];

/** Register a handle cache's reset with closeDb. */
export function onCloseDb(reset: () => void): void {
  closeResets.push(reset);
}

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
  globalThis.__mantleTurnDb = undefined;
  adminActorSql = null;
  narrowDb = null;
  for (const reset of closeResets) reset();
  // The next pool reads its database's actor check mode afresh.
  forgetActorCheckModePool();
  forgetBoxActorCheckMode();
  // A detached write still on its reserved connection finishes first (the
  // pool is no longer globalThis.__mantleSql, so none starts now).
  await actorPipelinesDone();
  if (sql) await sql.end();
  if (viewers) await Promise.all([...viewers.values()].map((v) => v.sql.end()));
}
