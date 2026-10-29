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
  narrowDatabaseUrl,
  narrowLoginNote,
  runtimeRoleOn,
  systemDatabaseUrl,
  readNarrowLogin,
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
import { narrowRouteClient, systemStartupOf } from './narrow-route';

type PgSql = ReturnType<typeof postgres>;

declare global {
  var __mantleSql: ReturnType<typeof postgres> | undefined;

  var __mantleDb: PostgresJsDatabase<typeof schema> | undefined;

  /** The workspace role's small pool (see viewer.ts), opened on first use. */
  var __mantleViewerDbs:
    | Map<PoolRole, { sql: ReturnType<typeof postgres>; db: PostgresJsDatabase<typeof schema> }>
    | undefined;

  /** The narrow route's own pool (plan v3.2 S7b): logs in as
   *  mantle_system_narrow; opened on the first narrow statement. null: the
   *  role has no login here (per-database mode), the route takes the role
   *  per transaction on the system pool instead. */
  var __mantleNarrowSql: ReturnType<typeof postgres> | null | undefined;

  /** The turn-scope handle, over the workspace role's pool. */
  var __mantleTurnDb: PostgresJsDatabase<typeof schema> | undefined;

  /** This process sends scoped login writes to the write role
   *  (openLoginWritePool). */
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

/** Connections of the narrow route's pool per process (narrowPoolSql).
 *  Every process's shares the role's CONNECTION LIMIT
 *  (NARROW_CONNECTION_LIMIT, runtime-role.ts, which is sized to every box
 *  process's pool at this size plus the stdio MCP servers' and the operator
 *  runs'); a process that runs no narrow work opens none. Two: a narrow
 *  statement holds its connection for one round trip (its SET goes with it,
 *  its RESET behind the answer), so a burst queues briefly instead of
 *  asking the server for more (the round trips, measured, are the same). */
export const NARROW_POOL_MAX = 2;

/** Seconds a narrow connection may sit idle before the pool closes it: a
 *  process whose narrow work came in a burst gives its connections back to
 *  the role's limit. */
const NARROW_IDLE_TIMEOUT = 30;

/**
 * The session settings the narrow pool sends when it connects (startup
 * parameters, narrowStartup): they win over any setting stored on the role
 * (ALTER ROLE ... SET, for every database or for one), which the narrow
 * login may store on itself and which would otherwise reach every later
 * narrow session until the next migrate takes it back
 * (runtime-role.ts resetNarrowRoleSettings; the boot line warns on any,
 * narrowLoginNote).
 *
 * A chosen list, not every setting a session can carry: the ones found to
 * refuse narrow work, cut it short, end its session, make a commit return
 * before it is durable, or change what a statement reads, writes or
 * parses. A setting not on it, stored on the role by the narrow login,
 * reaches narrow sessions until that next migrate (RESET ALL each run),
 * and the boot line names it.
 *
 * These are fixed, at the values the app runs every pool with (compose
 * sets none of them, so they are Postgres's defaults): the search path; a
 * read-only default, the isolation default and row security (each would
 * refuse narrow work); the timeouts (each would cut it short);
 * exit_on_error (any error would end the session); synchronous_commit; the
 * text of bytea and floats (drizzle parses it); array_nulls,
 * transform_null_equals, xmloption and gin_fuzzy_search_limit (each
 * changes what a statement reads or writes). transaction_timeout too, on a
 * server that has it (narrowStartup).
 */
export const NARROW_STARTUP_FIXED: Readonly<Record<string, string>> = Object.freeze({
  search_path: '"$user", public',
  default_transaction_read_only: 'off',
  default_transaction_isolation: 'read committed',
  row_security: 'on',
  statement_timeout: '0',
  lock_timeout: '0',
  idle_in_transaction_session_timeout: '0',
  idle_session_timeout: '0',
  exit_on_error: 'off',
  synchronous_commit: 'on',
  bytea_output: 'hex',
  extra_float_digits: '1',
  array_nulls: 'on',
  transform_null_equals: 'off',
  xmloption: 'content',
  gin_fuzzy_search_limit: '0',
});

/** Taken from the system pool: the values a session of it starts with
 *  (narrow-route.ts systemStartup reads them once, `reset_val`, never what a
 *  session set since), so the narrow route reads dates and intervals back
 *  in the text the system pool does (drizzle parses that text), reads a
 *  date's zone abbreviation and a string literal as it does, whatever the
 *  box's server runs with. */
export const NARROW_STARTUP_FROM_SYSTEM = [
  'TimeZone',
  'DateStyle',
  'IntervalStyle',
  'timezone_abbreviations',
  'standard_conforming_strings',
] as const;

/** Postgres 17 added transaction_timeout; an unknown startup parameter
 *  fails the login, so it is sent only to a server that has it. */
const TRANSACTION_TIMEOUT_SINCE = 17;

/**
 * The narrow pool's startup parameters for one connect, from the system
 * pool's session-start values (`system`: narrow-route.ts systemStartup,
 * with `server_version`): NARROW_STARTUP_FIXED, the system pool's
 * NARROW_STARTUP_FROM_SYSTEM, and transaction_timeout 0 on Postgres 17 and
 * later. The narrow route reads them before its first narrow connect and
 * fails closed when it cannot (no narrow statement is sent), so none is
 * missing there.
 */
export function narrowStartup(
  system: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = { ...NARROW_STARTUP_FIXED };
  for (const key of NARROW_STARTUP_FROM_SYSTEM) {
    const value = system[key];
    if (value) out[key] = value;
  }
  const major = Number(/^(\d+)/.exec(system.server_version ?? '')?.[1] ?? 0);
  if (major >= TRANSACTION_TIMEOUT_SINCE) out.transaction_timeout = '0';
  return out;
}

/** Every key narrowStartup may give. */
const NARROW_STARTUP_KEYS = [
  ...Object.keys(NARROW_STARTUP_FIXED),
  ...NARROW_STARTUP_FROM_SYSTEM,
  'transaction_timeout',
];

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
  // DATABASE_URL, or the runtime role on it (runtime-role.ts).
  const url = systemDatabaseUrl();
  // onnotice: an item table's write trigger reports a statement with no
  // actor as a NOTICE (0275); every other notice prints as postgres.js's
  // default does.
  const sql =
    globalThis.__mantleSql ?? postgres(url, { max: 10, prepare: false, onnotice: onPgNotice });
  globalThis.__mantleSql = sql;
  // The narrow route (plan v3.2 S7a): a statement of a reason routed
  // 'narrow' runs as the narrow role.
  const withActor = narrowRouteClient(
    actorClient(sql),
    sql,
    () => systemRouteNow() === 'narrow',
    narrowPoolSql,
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

/** Who the system pool logs in as (DB_ROLE_SQL), asked on the
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

/** Who the system pool logs in as, once per process at its start:
 *  a warning on a box whose app runs as the superuser (MANTLE_DB_RUNTIME_ROLE
 *  off), or as any role but the runtime role. Production only (a test
 *  process opens many pools); never in a statement's path. */
function reportDbRole(base: PgSql): void {
  if (!isProduction()) return;
  base
    .unsafe(`${ACTOR_SQL_TAG} ${DB_ROLE_SQL}`)
    .then(async (rows) => {
      const row = rows[0] as DbRoleRow | undefined;
      if (!row) return;
      // The narrow route's pool logs in as the role but in per-database
      // mode (narrowDatabaseUrl).
      const loginPool = !feature('viewerRolesPerDatabase');
      const narrow = `; narrow system route ${
        loginPool
          ? 'on its own pool, which logs in as mantle_system_narrow'
          : 'taking the role per transaction (per-database mode: the role has no login)'
      }`;
      // The narrow role itself: with the route logging in as it, a role
      // that cannot log in is named with its fix; a setting stored on the
      // role, in either mode (narrowLoginNote).
      const narrowNote = narrowLoginNote(await readNarrowLogin(base).catch(() => null), loginPool);
      const roleNote = dbRoleNote(row, runtimeRoleOn());
      const note = [roleNote && `${roleNote}${narrow}`, narrowNote].filter(Boolean).join('\n');
      if (note) {
        console.warn(
          roleNote ? note : `[db] the system pool logs in as ${row.user}${narrow}\n${note}`,
        );
      } else
        console.log(`[db] the system pool logs in as ${row.user} (arch A9 runtime role)${narrow}`);
    })
    .catch(() => {});
}

/** The system pool's client with the actor (actorClient over
 *  globalThis.__mantleSql): the login write gateway's system path. */
/**
 * Whether a system pool statement sent now takes the narrow route: the
 * exit's pick (the pool's own test, above). For a writer that must send a
 * different statement there (gateway/structure-item.ts), never to choose a
 * pool.
 */
export function narrowRouteNow(): boolean {
  return systemRouteNow() === 'narrow';
}

let adminActorSql: PgSql | null = null;

/** The system pool's handle on the narrow route, always (getNarrowDb). */
let narrowDb: PostgresJsDatabase<typeof schema> | null = null;

/**
 * The system pool's drizzle handle whose every statement runs on the
 * narrow route (plan v3.2 S7a): systemDb's inside a turn or request scope
 * (gateway/handles.ts).
 */
export function getNarrowDb(): PostgresJsDatabase<typeof schema> {
  getAdminDb();
  const sql = globalThis.__mantleSql!;
  return (narrowDb ??= drizzle(
    narrowRouteClient(actorClient(sql), sql, () => true, narrowPoolSql),
    { schema },
  ));
}

/**
 * The narrow route's own pool (plan v3.2 S7b, the design that closes the
 * class of plan 2.1 MED-A): every connection logs in as
 * mantle_system_narrow, which is a member of nothing, so a statement that
 * resets or changes the role has no other role to reach. Made on the first
 * narrow statement (postgres.js connects on the first query), so a process
 * that runs no narrow work opens no connection. null when the role has no
 * login here (narrowDatabaseUrl: per-database mode). A role whose login
 * migrate did not open (migrate not run as a superuser) fails the narrow
 * statement (never the system pool instead): the error names the fix.
 */
function narrowPoolSql(): PgSql | null {
  if (globalThis.__mantleNarrowSql !== undefined) return globalThis.__mantleNarrowSql;
  // A pool being closed (closeDb) opens no new one behind it.
  if (!globalThis.__mantleSql) throw new Error('narrow route: the database pools are closed');
  const url = narrowDatabaseUrl();
  if (!url) return (globalThis.__mantleNarrowSql = null);
  return (globalThis.__mantleNarrowSql = newNarrowPool(url, globalThis.__mantleSql));
}

/**
 * A narrow pool logging in with `url` (narrowDatabaseUrl): its size, idle
 * timeout and startup parameters (narrowStartup, over `system`'s
 * session-start settings, systemStartupOf), and the same type parsers and
 * serializers as `system` (the system pool: drizzle set its own on that
 * client, dates and json pass through as text and drizzle maps them, and a
 * statement drizzle builds is sent on this pool too; without them a jsonb
 * value drizzle already serialized is serialized again). The one place a
 * narrow pool is made: narrowPoolSql, and a test that traps the pool.
 */
export function newNarrowPool(url: string, system: PgSql): PgSql {
  const narrow = postgres(url, {
    max: NARROW_POOL_MAX,
    idle_timeout: NARROW_IDLE_TIMEOUT,
    prepare: false,
    onnotice: onPgNotice,
  });
  Object.assign(narrow.options.parsers, system.options.parsers);
  Object.assign(narrow.options.serializers, system.options.serializers);
  // Read at each connect: postgres.js copies its `connection` option once,
  // when the pool is made, and sends what it holds then with every startup
  // (a key with no value is left out).
  const connection = narrow.options.connection as Record<string, unknown>;
  for (const key of NARROW_STARTUP_KEYS) {
    Object.defineProperty(connection, key, {
      enumerable: true,
      configurable: true,
      get: () => narrowStartup(systemStartupOf(system) ?? {})[key],
    });
  }
  return narrow;
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
 * Open the login write gateway in this process: every process
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
  const narrowSql = globalThis.__mantleNarrowSql;
  globalThis.__mantleSql = undefined;
  globalThis.__mantleNarrowSql = undefined;
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
  // Its own pipelines are done above; a timeout, so a pool whose logins
  // all failed (the role with no login) still ends.
  if (narrowSql) await narrowSql.end({ timeout: 5 });
  if (viewers) await Promise.all([...viewers.values()].map((v) => v.sql.end()));
}
