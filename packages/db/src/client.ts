import { AsyncLocalStorage } from 'node:async_hooks';
import { sql as sqlTag } from 'drizzle-orm';
import { getTableName, is } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PgDialect, PgTable, getTableConfig, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema/index';
import { holderWorkspacesSql } from './grant-reads';
import { env, feature, isProduction } from '@mantle/config';
import {
  DB_ROLE_SQL,
  dbRoleNote,
  runtimeRoleOn,
  systemDatabaseUrl,
  type DbRoleRow,
} from './runtime-role';
import {
  currentScopeTx,
  currentSpaceScope,
  currentScope,
  isSystemScope,
  SCOPE_AREAS,
  type ScopeArea,
  newTxHooks,
  runInSystemTx,
  runInWorkspaceTx,
  currentWorkspaceScope,
  inTurnScope,
  assertSystemDbCaller,
  systemDbAccessChecked,
  isUnscoped,
  runInTurnScope,
  type WorkspaceScope,
  runTxHooks,
  runInViewerScope,
  type ViewerFor,
  type AppRunFor,
  viewerDatabaseUrl,
  viewerRolePassword,
  type PoolRole,
  currentRequestMode,
  noteOwnRuleSystemRead,
  noteRequestSystemWrite,
  requestWriteScope,
  currentCreateHome,
  currentSystemTx,
  requestScopeMemo,
  loginWriteScope,
  type CreateHome,
  type SystemTxNest,
  type TxHooks,
  systemDbCallerOf,
  afterCommit,
  afterRollback,
} from './viewer';
import {
  actorCheckMode,
  actorSetting,
  checkActorBound,
  currentActor,
  forgetBoxActorCheckMode,
  noteBoxActorCheckMode,
  onPgNotice,
  runAsSystem,
  runWithoutActor,
  loginActor,
  longStack,
  noteActorMiss,
  noteTestWriteRoleGap,
  systemActor,
  setActorMissLogger,
  writeModeOf,
  type Actor,
  type ActorMiss,
} from './actor';
import { reserveLease, withLease, type Lease } from './reserved';
import { errorMessage } from '@mantle/std';
import { BusyError, permissionGapOf } from './pg-error';
import {
  GAP_WRITER_ROLE,
  WRITE_ROLE_GAP_TABLES,
  WRITE_ROLE_GAP_UNREADABLE,
  WRITE_ROLE_TABLES,
  isWriteRoleGapTable,
  writeRoleGapTable,
} from './access-matrix';

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
}

/** Connections of a limited pool, per process and role. Small on purpose:
 *  every process of a box opens its own pools, and their sum must stay under
 *  the box's max_connections (the connection ceiling, task 29008b01).
 *  The write role's pool (getViewerDb('write')) is opened by no process
 *  until A2b2b (docs/actors.md, "A2b2b must"). */
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
  // DATABASE_URL, or the runtime role on it (arch A9, runtime-role.ts).
  const url = systemDatabaseUrl();
  // onnotice: an item table's write trigger reports a statement with no
  // actor as a NOTICE (0275); every other notice prints as postgres.js's
  // default does.
  const sql =
    globalThis.__mantleSql ?? postgres(url, { max: 10, prepare: false, onnotice: onPgNotice });
  globalThis.__mantleSql = sql;
  const withActor = actorClient(sql);
  adminActorSql = withActor;
  const client = drizzle(withActor, { schema });
  globalThis.__mantleDb = client;
  setActorMissLogger(logActorMiss);
  // Out of the caller's context: the timer must not keep its actor.
  runWithoutActor(() => refreshActorCheckMode(sql));
  runWithoutActor(() => reportDbRole(sql));
  return client;
}

/** Who the system pool logs in as (arch A9, DB_ROLE_SQL), asked on the
 *  system pool itself whatever scope the caller is in: system health
 *  reports it. Null when the pool cannot answer. */
export async function systemPoolRole(): Promise<DbRoleRow | null> {
  try {
    const rows = await runWithoutActor(() =>
      rawAdminSql().unsafe(`${ACTOR_SQL_TAG} ${DB_ROLE_SQL}`),
    );
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
      if (note) console.warn(note);
      else console.log(`[db] the system pool logs in as ${row.user} (arch A9 runtime role)`);
    })
    .catch(() => {});
}

// ── The actor on the system pool (workspaces arch A2a) ──────────────────────

/** The system pool's client with the actor (actorClient over
 *  globalThis.__mantleSql): the login write gateway's system path. */
let adminActorSql: PgSql | null = null;

/** The pipelined statements in flight (actorClient), for closeDb. */
const actorPipelines = new Set<Promise<unknown>>();

/** The pool whose box mode a timer reads (refreshActorCheckMode). */
let actorModePool: PgSql | null = null;

/**
 * The pool's first mode read while it is out, else null (A2b, the startup
 * race). Until it answers, a write or a transaction that has an actor waits
 * for it, so a process's first writes never go out as off on a box that is
 * warn or on. Reads never wait. A failed read is tried again after 1 s,
 * then 2 s, 4 s ... (A2b1 audit, L5), but nothing waits longer than
 * FIRST_MODE_WAIT_MS: then the process goes on with MANTLE_ACTOR_CHECK as
 * the floor. A one-time cost at a process's start, no statement of its own.
 */
let firstModeRead: Promise<void> | null = null;

/** The longest a write waits for the pool's first mode read. */
const FIRST_MODE_WAIT_MS = 3_000;

/** An unref'd sleep: it never keeps a process alive. */
const quietSleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms).unref();
  });

/**
 * Read the box's actor check mode when the pool opens, then each minute on
 * an unref'd timer: never inside a statement's path, so a request runs no
 * new query for it (fix round; the owner's no-new-query rule). Until the
 * first read lands the process uses MANTLE_ACTOR_CHECK alone (off unless
 * set) as a floor: a read runs as before, and a write or a transaction
 * with an actor waits for that first read (firstModeRead). Exported for
 * actor-client.test.ts only (not in index.ts).
 */
export function refreshActorCheckMode(base: PgSql): void {
  if (actorModePool === base) return;
  actorModePool = base;
  /** One read; true when the mode is known after it. */
  const read = (): Promise<boolean> => {
    if (actorModePool !== base) return Promise.resolve(true);
    return base
      .unsafe(`${ACTOR_SQL_TAG} select "public"."mantle_actor_check_mode"() as m`)
      .then((rows) => {
        // A pool closed (closeDb) while the read was out: its answer is
        // not the next pool's (fix round 2, L8).
        if (actorModePool !== base) return true;
        noteBoxActorCheckMode((rows[0] as { m?: string } | undefined)?.m ?? null);
        return true;
      })
      .catch((err: unknown) => {
        // A database without 0275 yet (the function is missing): off. Any
        // other failure (a dropped connection, a busy pool) keeps the last
        // mode read (fix round 2, L2).
        if (actorModePool === base && (err as { code?: string } | null)?.code === '42883') {
          noteBoxActorCheckMode(null);
          return true;
        }
        return false;
      });
  };
  /** The first read, tried again with backoff until it lands (L5). Then,
   *  once per pool, the triggers against the box mode (warnActorCheckDrift). */
  const warm = async () => {
    for (let delay = 1_000; !(await read()) && actorModePool === base; delay *= 2) {
      await quietSleep(Math.min(delay, 30_000));
    }
    if (actorModePool === base) warnActorCheckDrift(base);
  };
  const first: Promise<void> = Promise.race([warm(), quietSleep(FIRST_MODE_WAIT_MS)]).finally(
    () => {
      if (firstModeRead === first) firstModeRead = null;
    },
  );
  firstModeRead = first;
  const timer = setInterval(() => {
    if (actorModePool !== base) clearInterval(timer);
    else void read();
  }, 60_000);
  timer.unref();
}

/**
 * The actor check's triggers against the box mode (0277; A2b1 fix round 2
 * re-audit): one row when they differ. Off wants every mantle_actor_check
 * trigger disabled, warn and on want all enabled. A bare ALTER DATABASE or
 * a restore (scripts/db-restore.sh) can leave them apart. Any role may run
 * it (mantle_actor_check_mode and pg_trigger are readable). The integrity
 * row actor_check_drift and the boot warning read it.
 */
export const ACTOR_CHECK_DRIFT_SQL = checkDriftSql(
  `"public"."mantle_actor_check_mode"()`,
  `g.tgname = 'mantle_actor_check'`,
);

/** The same for the edit check (arch A3a, 0280): its box mode and every
 *  trigger named mantle_edit_check or mantle_edit_check_* (the matrix's
 *  and the read-only refusal). The integrity row edit_check_drift and the
 *  boot warning read it. */
export const EDIT_CHECK_DRIFT_SQL = checkDriftSql(
  `"public"."mantle_check_box_mode"('edit_check')`,
  `(g.tgname = 'mantle_edit_check' OR g.tgname LIKE 'mantle\\_edit\\_check\\_%')`,
);

/** One row when the triggers `triggers` picks do not follow the mode
 *  `mode` reads: off wants them all disabled, warn and on all enabled. */
function checkDriftSql(mode: string, triggers: string): string {
  return `
  SELECT m.mode, t.enabled::int AS enabled, t.total::int AS total
    FROM (SELECT ${mode} AS mode) m,
         (SELECT count(*) FILTER (WHERE g.tgenabled <> 'D') AS enabled, count(*) AS total
            FROM pg_catalog.pg_trigger g
           WHERE ${triggers} AND NOT g.tgisinternal) t
   WHERE NOT ((m.mode = 'off' AND t.enabled = 0) OR (m.mode <> 'off' AND t.enabled = t.total))`;
}

/** One warning at a pool's start when a check's triggers and its box mode
 *  differ (never each minute), for the actor check and the edit check. The
 *  app does not fix it: no DDL from the app. A database before a check's
 *  migration answers an error, ignored. */
function warnActorCheckDrift(base: PgSql): void {
  for (const [check, drift, setter] of [
    ['actor check', ACTOR_CHECK_DRIFT_SQL, 'mantle_set_actor_check'],
    ['edit check', EDIT_CHECK_DRIFT_SQL, 'mantle_set_edit_check'],
  ] as const) {
    base
      .unsafe(`${ACTOR_SQL_TAG} ${drift}`)
      .then((rows) => {
        const r = rows[0] as { mode?: string; enabled?: number; total?: number } | undefined;
        if (!r || typeof r.total !== 'number') return;
        console.warn(
          `[db] ${check}: the box mode is ${r.mode} but ${r.enabled} of ${r.total} ` +
            `triggers are enabled. As the superuser that runs migrations: ` +
            `select ${setter}('${r.mode}'); (docs/update-prod.md)`,
        );
      })
      .catch(() => {});
  }
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

/** The handle properties that send a statement: the TypeScript actor check
 *  (A2a) runs on each access. drizzle's own reads (session, dialect) do
 *  not count. */
const STATEMENT_PROPS: ReadonlySet<PropertyKey> = new Set([
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  'execute',
  'query',
  'transaction',
  'with',
  '$with',
  '$count',
  'refreshMaterializedView',
]);

/** The actor of the transaction (packages/db only: the
 *  actor-setters-in-db-only lint). Plain set_config, as mantle_set_actor
 *  does without its checks: it works on every role and on a database
 *  before 0275 (an operator or a test role), and actor.ts already checked
 *  the value.
 *
 *  The values are inlined as quoted literals, not sent as parameters (fix
 *  round 2): with prepare off, postgres.js sends a statement that has
 *  parameters in two steps (describe, wait for the answer, then execute),
 *  and nothing queued behind it goes out until the first step is answered.
 *  A statement with no parameters goes out in one step, so the next one is
 *  sent with it: the SET adds no round trip.
 *
 *  Each value is checked against its shape first and refused otherwise
 *  (A2b, defence in depth for the inlined literals): actor.ts builds them,
 *  so a refusal here is a bug, never a caller's input. Exported for
 *  actor-client.test.ts only (not in index.ts). */
export function setActorSql(
  [actor, writeMode, mode]: [string, string, string],
  local = true,
): string {
  if (!ACTOR_VALUE_RE.test(actor)) throw new Error('actor setting: not an actor');
  if (writeMode !== 'rw' && writeMode !== 'ro') throw new Error('actor setting: write mode');
  if (mode !== 'off' && mode !== 'warn' && mode !== 'on') {
    throw new Error('actor setting: check mode');
  }
  const lit = (v: string) => {
    // standard_conforming_strings is on (the Postgres default since 9.1):
    // only a quote needs doubling. The shapes above admit no quote and no
    // NUL; this stays as the second line.
    if (v.includes('\0')) throw new Error('actor setting: NUL');
    return `'${v.replace(/'/g, "''")}'`;
  };
  return (
    `select set_config('mantle.actor', ${lit(actor)}, ${local}), ` +
    `set_config('mantle.write_mode', ${lit(writeMode)}, ${local}), ` +
    `set_config('mantle.actor_check', ${lit(mode)}, ${local})`
  );
}

/** Takes back a session-level setActorSql(…, false): a real RESET, so each
 *  setting is the database's default again (the box mode for
 *  mantle.actor_check). Sent with the simple protocol (three statements). */
export const RESET_ACTOR_SQL =
  '/* mantle:actor */ reset mantle.actor; reset mantle.write_mode; reset mantle.actor_check';

/** The shape of a mantle.actor value (actorSetting's output): no quote, no
 *  space, no NUL. Wider than mantle_set_actor's own pattern on purpose:
 *  that one names the kinds, this one only keeps the literal safe. */
const ACTOR_VALUE_RE = /^[a-z0-9:._/@-]{1,200}$/i;

/** Statements Postgres refuses inside a transaction block: they run as they
 *  are, with no actor set (DDL and maintenance; no item trigger fires). */
const NO_TX_SQL =
  /^(vacuum|cluster|checkpoint|discard\s+all|call|reindex\s+(\([^)]*\)\s*)?(database|schema|system)\b|reindex\b[^;]*\bconcurrently|(create|drop)\s+(unique\s+)?index\s+concurrently|(create|drop)\s+(database|tablespace)|alter\s+system)\b/i;

/** `query` without its leading comments and whitespace, and with
 *  `setsToo`, its leading SET statements. */
function statementBody(query: string, setsToo: boolean): string {
  let body = query;
  for (;;) {
    let next = body
      .replace(/^\s+/, '')
      .replace(/^--[^\n]*\n?/, '')
      .replace(/^\/\*[\s\S]*?\*\//, '');
    if (setsToo) next = next.replace(/^set\s+(?!transaction\b)[^;]*;/i, '');
    if (next === body) return body;
    body = next;
  }
}

/**
 * Whether `query` must run outside a transaction block (fix round, M3b):
 * matched after its leading comments, whitespace and SET statements.
 */
export function runsOutsideTransaction(query: string): boolean {
  return NO_TX_SQL.test(statementBody(query, true));
}

/** A statement that only reads: SELECT, VALUES, TABLE, SHOW, an EXPLAIN
 *  without ANALYZE (or ANALYSE), and a WITH that names no write verb. */
const READ_VERB = /^(select|values|table|show)\b/i;
const EXPLAIN_NO_ANALYZE = /^explain\b(?![^;]*\banaly[sz]e\b)/i;
/** A write verb anywhere in a WITH (fix round 2, L4): a false match only
 *  costs the wrap, a missed one would send a write with no actor. */
const WITH_WRITES = /\b(insert|update|delete|merge)\b/i;
/** A `;` with more text after it: more than one statement, unknown. */
const MORE_STATEMENTS = /;\s*\S/;

/** The tag on the actor's own statements (the mode read, a login read now,
 *  the write wrapper's RESET): the round-trip test
 *  (a2a-round-trips.db.test.ts) proves the check off sends none, and counts
 *  their round trips as the actor's cost in warn. */
const ACTOR_SQL_TAG = '/* mantle:actor */';

/**
 * Whether the system pool sends `query` with the actor set (owner decision,
 * A2a fix round): writes only. INSERT, UPDATE, DELETE, MERGE, TRUNCATE,
 * COPY, a WITH that names a write verb, more than one statement, and any
 * verb not named here (the safe side) are wrapped; a read runs plain,
 * exactly as with the check off. A SELECT that calls a function that writes
 * an item table runs plain too, and the 0275 trigger then logs a miss in
 * warn: that shows the case (docs/actors.md).
 */
export function needsActorWrap(query: string): boolean {
  const body = statementBody(query, false);
  if (MORE_STATEMENTS.test(body)) return true;
  if (READ_VERB.test(body) || EXPLAIN_NO_ANALYZE.test(body)) return false;
  if (/^with\b/i.test(body)) return WITH_WRITES.test(body);
  return true;
}

/** The mantle_set_actor parameters for the current actor, or null: no actor
 *  bound, or the check is off (then nothing changes). */
function actorParams(): [string, string, string] | null {
  const mode = actorCheckMode();
  if (mode === 'off') return null;
  const actor = currentActor();
  if (!actor) return null;
  return [actorSetting(actor), writeModeOf(actor), mode];
}

/** SET TRANSACTION (drizzle's transaction config): Postgres takes it only
 *  as the transaction's first statement, so the actor follows it. */
const SET_TRANSACTION_SQL = /^\s*set\s+transaction\b/i;

/**
 * A transaction's client that sets the actor with its first statement (fix
 * round, M3a): after a SET TRANSACTION (drizzle's isolation level, access
 * mode, deferrable), which Postgres refuses after any query. Covers
 * drizzle's path (`unsafe`), a savepoint opened first, and a tagged-template
 * statement (which then returns a plain promise).
 *
 * The SET is sent unawaited, right before that first statement, on the
 * transaction's one connection: postgres.js sends both in one write, so
 * warn adds no round trip to a transaction (fix round 2, the owner's
 * scaling rule). A SET that fails is the error reported, not the
 * statement's follow-on "current transaction is aborted". Exported for
 * actor-client.test.ts only (not in index.ts).
 */
export function actorInTransaction(t: PgSql, params: [string, string, string]): PgSql {
  return settingsFirst(t, () => setActorSql(params));
}

/**
 * A transaction's client that sends `setSql()` (a statement with no
 * parameters that only sets transaction-local settings) unawaited, right
 * before its first statement: actorInTransaction's actor, and the write
 * role's scope and actor (the login write gateway, A2b2b). See
 * actorInTransaction.
 */
function settingsFirst(t: PgSql, setSql: () => string): PgSql {
  /** The SET's outcome once sent: null, or its error. Never rejects. */
  let set: Promise<unknown> | null = null;
  /** The SET answered without an error: later statements run plain. Until
   *  then each one waits for the SET's answer too, so a statement sent in
   *  parallel with the first reports the SET's own error, not the follow-on
   *  "current transaction is aborted" (A2b, the A2a audit's LOW). */
  let setOk = false;
  const sendSet = (): Promise<unknown> =>
    (set ??= t.unsafe(setSql()).then(
      () => {
        setOk = true;
        return null;
      },
      (err: unknown) => err ?? new Error('the actor SET failed'),
    ));
  /** Start `start` right behind the SET. Both `.then` calls are direct, so
   *  postgres.js queues the SET first. */
  const afterSet = (start: () => PromiseLike<unknown>): Promise<unknown> => {
    const setErr = sendSet();
    const run = start().then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    return Promise.all([setErr, run]).then(([err, r]) => {
      if (err) throw err;
      if (!r.ok) throw r.e;
      return r.v;
    });
  };
  const lazy = (start: () => PromiseLike<unknown>) => {
    let pending: Promise<unknown> | null = null;
    const once = () => (pending ??= afterSet(start));
    return {
      then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => once().then(ok, bad),
      catch: (bad?: (e: unknown) => unknown) => once().catch(bad),
      finally: (f?: () => void) => once().finally(f),
    };
  };
  return new Proxy(t, {
    apply(target, thisArg, args: unknown[]) {
      const first = args[0] as { raw?: unknown } | undefined;
      const call = () =>
        Reflect.apply(
          target as unknown as (...a: unknown[]) => unknown,
          thisArg,
          args,
        ) as PromiseLike<unknown>;
      if (setOk || !Array.isArray(first) || !('raw' in first)) return call();
      return afterSet(call);
    },
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: unknown) => {
          if (setOk) return target.unsafe(query, args as never[], opts as never);
          if (!set && SET_TRANSACTION_SQL.test(query)) {
            return target.unsafe(query, args as never[], opts as never);
          }
          const q = () => target.unsafe(query, args as never[], opts as never);
          return Object.assign(lazy(q), {
            values: () => afterSet(() => q().values()),
            simple: () => afterSet(() => q().simple()),
          });
        };
      }
      if (prop === 'savepoint') {
        return (...a: unknown[]) =>
          afterSet(() =>
            (
              target as unknown as { savepoint: (...x: unknown[]) => PromiseLike<unknown> }
            ).savepoint(...a),
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * The system pool's postgres.js client with the actor (arch A2a, plan 4.2):
 * while the check is not off and an actor is bound, a transaction (`begin`)
 * sets the actor with its first statement (no round trip of its own), and a
 * write outside one (needsActorWrap) runs pipelined with a session-level
 * SET and a RESET on one reserved connection (pipelined, below): the SET in
 * the same send as the write, the RESET after the caller has its answer.
 * A read runs plain. With the check off, or no actor
 * bound, every statement runs exactly as before. Statements Postgres refuses in a
 * transaction block (runsOutsideTransaction) always run as they are.
 * Exported for actor-client.test.ts only (not in index.ts).
 */
export function actorClient(base: PgSql): PgSql {
  /**
   * A write outside a transaction, as the actor (A2b1 audit, Q1): on one
   * reserved connection, a session-level SET, the write and a RESET, all
   * pipelined. The SET goes in the same send as the write, and the write
   * commits by itself (no BEGIN, no COMMIT), so the caller waits exactly as
   * long as with the check off; it gets the write's own result. The RESET
   * runs behind the write, off the caller's path: the connection goes back
   * to the pool only once the RESET has answered, so no other statement
   * ever sees this actor. A RESET that fails ends the connection instead
   * (pg_terminate_backend on itself), never handing it back with the
   * settings on; a connection that died is neither sent to nor handed back
   * (reserved.ts, hotfix after v0.300.13).
   */
  const pipelined = (
    params: [string, string, string],
    query: string,
    args: unknown[] | undefined,
    mode: 'rows' | 'values' | 'simple',
  ): Promise<unknown> => {
    let settle!: (v: Promise<unknown>) => void;
    const result = new Promise<unknown>((r) => (settle = r));
    let answered = false;
    /** The caller's answer, once: a later one is dropped (never left as an
     *  unhandled rejection). */
    const answer = (v: Promise<unknown>) => {
      if (answered) return;
      answered = true;
      settle(v);
    };
    // Kept until the connection is back: closeDb waits for these first
    // (postgres.js never finishes ending a pool whose reserved connection
    // comes back late).
    const life = (async () => {
      // The SET's text first: a value it refuses (setActorSql throws) fails
      // the caller before any connection is taken (A2b1 fix round 2, L1).
      let setSql: string;
      let lease: Lease;
      try {
        setSql = setActorSql(params, false);
        lease = await reserveLease(base);
      } catch (err) {
        answer(Promise.reject(err));
        return;
      }
      // True once the SET is built: postgres.js sends it a moment later.
      // Ending a connection the SET never reached errs on the safe side.
      let sent = false;
      try {
        const conn = lease.sql;
        const set = conn.unsafe(setSql);
        sent = true;
        const q = conn.unsafe(query, (args ?? []) as never[]);
        const main = mode === 'values' ? q.values() : mode === 'simple' ? q.simple() : q;
        const reset = conn.unsafe(RESET_ACTOR_SQL).simple();
        answer(
          Promise.allSettled([lease.watch(set), lease.watch(main)]).then(([s, m]) => {
            // The write's own result. A SET that failed is reported when the
            // write failed too (it is the cause); a write that ran without
            // its actor meets the SQL check (a miss in warn, refused in on).
            if (m.status === 'fulfilled') return m.value;
            throw s.status === 'rejected' ? s.reason : m.reason;
          }),
        );
        await lease.watch(reset);
      } catch (err) {
        // Anything that throws here (a failed RESET, or a throw while the
        // statements are built) fails the caller if it has no answer yet,
        // and a connection that may hold the settings ends instead of going
        // back (lease.end: never handed back, nothing sent if it died).
        if (!answered) answer(Promise.reject(err));
        if (sent) await lease.end();
      } finally {
        lease.release();
      }
    })();
    actorPipelines.add(life);
    const done = () => actorPipelines.delete(life);
    life.then(done, done);
    return result;
  };
  /** Run `query` as the actor bound now (decided when it runs). */
  const run = (
    query: string,
    args: unknown[] | undefined,
    opts: unknown,
    mode: 'rows' | 'values' | 'simple',
  ): Promise<unknown> => {
    // A pool being closed (closeDb) takes no new reserved connection: one
    // that comes back after its end began keeps postgres.js from ending.
    const open = globalThis.__mantleSql === base;
    const params = open ? actorParams() : null;
    if (params && !runsOutsideTransaction(query) && needsActorWrap(query)) {
      return pipelined(params, query, args, mode);
    }
    const q = base.unsafe(query, args as never[], opts as never);
    return mode === 'values' ? q.values() : mode === 'simple' ? q.simple() : q;
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: unknown) => {
          // Nothing to set: the plain query, every method of it (M3c). The
          // mode first: with the check off no statement is classified.
          // While the first mode read is out (the startup race), a write
          // with an actor waits for it and then decides (run).
          const waitFor = firstModeRead;
          const wait = !actorParams() && waitFor !== null && currentActor() !== null;
          if (
            (!wait && !actorParams()) ||
            runsOutsideTransaction(query) ||
            !needsActorWrap(query)
          ) {
            return target.unsafe(query, args as never[], opts as never);
          }
          const go = (mode: 'rows' | 'values' | 'simple') =>
            wait ? waitFor.then(() => run(query, args, opts, mode)) : run(query, args, opts, mode);
          let pending: Promise<unknown> | null = null;
          const once = () => (pending ??= go('rows'));
          return {
            values: () => go('values'),
            simple: () => go('simple'),
            then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
              once().then(ok, bad),
            catch: (bad?: (e: unknown) => unknown) => once().catch(bad),
            finally: (fn?: () => void) => once().finally(fn),
          };
        };
      }
      if (prop === 'begin') {
        return (...args: unknown[]) => {
          const fn = args[args.length - 1] as (t: PgSql) => unknown;
          if (typeof fn !== 'function') {
            return (target.begin as (...a: unknown[]) => unknown)(...args);
          }
          const wrapped = async (t: PgSql) => {
            // The startup race: wait for the pool's first mode read once.
            const waitFor = firstModeRead;
            if (waitFor && currentActor() && !actorParams()) await waitFor;
            const params = actorParams();
            return fn(params ? actorInTransaction(t, params) : t);
          };
          return (target.begin as (...a: unknown[]) => unknown)(...args.slice(0, -1), wrapped);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * The limited pool: logs in as the workspace LOGIN role, so row level
 * security filters every read. Fails loudly (never falls back to the admin
 * pool) when the master key is missing or the role cannot log in.
 */
function getViewerDb(level: PoolRole): PostgresJsDatabase<typeof schema> {
  const pools = (globalThis.__mantleViewerDbs ??= new Map());
  const cached = pools.get(level);
  if (cached) return cached.db;
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  const password = viewerRolePassword(env('MANTLE_MASTER_KEY') ?? '', level);
  const perDatabase = feature('viewerRolesPerDatabase');
  const sql = postgres(viewerDatabaseUrl(url, level, password, perDatabase), {
    max: VIEWER_POOL_MAX,
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

// ── The login write gateway (workspaces arch A2b2b, plan 20.1) ─────────────

/**
 * Open the login write gateway in this process (arch A2b2b): web and api
 * only (server/web/server/main.ts, server/api/src/main.ts). The role's
 * connection limit is 20 and its pool takes VIEWER_POOL_MAX per process, so
 * every other process keeps its login writes on the system pool
 * (connection-ceiling.test.ts counts the pool for the processes that call
 * this). Tests open it in vitest.setup.ts. `false` closes it again (tests).
 */
export function openLoginWritePool(open = true): void {
  globalThis.__mantleLoginWritePool = open;
}

/** Whether this process sends login writes to the write role. */
function loginWritePoolOpen(): boolean {
  return globalThis.__mantleLoginWritePool === true;
}

/** The actors whose scoped writes go to the write role (plan 20.1):
 *  everything but system work and a peer(share), which writes nothing. */
const WRITE_ROLE_ACTORS: ReadonlySet<Actor['kind']> = new Set([
  'login',
  'assistant',
  'link',
  'contact',
]);

/** The tables the write role writes, as `schema.table` (WRITE_ROLE_TABLES). */
const WRITE_ROLE_TABLE_SET: ReadonlySet<string> = new Set(WRITE_ROLE_TABLES);

/** Whether a drizzle table is one the write role writes: a typed write to
 *  any other table goes to the system pool, decided before it is sent
 *  (no failed attempt). */
function isWriteRoleTable(table: unknown): boolean {
  if (!is(table, PgTable)) return false;
  return WRITE_ROLE_TABLE_SET.has(
    `${getTableConfig(table).schema ?? 'public'}.${getTableName(table)}`,
  );
}

/** The table a single INSERT, UPDATE or DELETE writes, as `schema.table`
 *  (an unqualified name is public's), or null: another statement, a WITH,
 *  more than one statement, a name it cannot read. Exported for
 *  actor-client.test.ts only (not in index.ts). */
export function rawWriteTarget(query: string): string | null {
  const body = statementBody(query, false);
  if (MORE_STATEMENTS.test(body)) return null;
  const m =
    /^(?:insert\s+into|update(?:\s+only)?|delete\s+from(?:\s+only)?)\s+(?:"?([a-z_][a-z0-9_]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?(?=[\s(;]|$)/i.exec(
      body,
    );
  if (!m) return null;
  return `${(m[1] ?? 'public').toLowerCase()}.${m[2]!.toLowerCase()}`;
}

/** db.insert, update or delete of a scoped write (the db proxy): the
 *  gateway's handle for a write-role table, the system pool's for any
 *  other (arch A2b2b). */
function typedWrite(prop: 'insert' | 'update' | 'delete', gateway: boolean): unknown {
  return (table: unknown, ...rest: unknown[]) => {
    const handle = gateway && isWriteRoleTable(table) ? loginWriteDb() : getAdminDb();
    const fn = Reflect.get(handle as object, prop) as (...args: unknown[]) => unknown;
    return fn.call(handle, table, ...rest);
  };
}

/** Where a write runs on the write role: the one SET of its transaction
 *  (scope, actor, create home), the actor (a gap's log line), the scope and
 *  the box mode (a gap's rerun: checked in on, as before in warn). Two
 *  writes with the same `setSql` run as the same actor in the same scope:
 *  the second may join the first's open transaction. */
type LoginWriteRoute = {
  setSql: string;
  actor: string;
  scope: WorkspaceScope;
  mode: 'warn' | 'on';
};

/**
 * The login write gateway's one decision (arch A2b2b): the settings a write
 * that runs now takes on the write role, or null for the system pool
 * (today's path, unchanged). The write role when all hold:
 *  - this process opened it (openLoginWritePool: web and api);
 *  - the actor check is not off (the box mode read from the catalog, where
 *    a session can only make it stricter; MANTLE_ACTOR_CHECK raises it for
 *    one process). Off is the rollout switch: today's path, no statement
 *    and no round trip added;
 *  - the actor is a login, an assistant, a link or a contact;
 *  - the write carries a scope its reads use too (loginWriteScope: a
 *    login's mutating request scope, an Admin turn; not an Admin user's
 *    write request, whose reads are unscoped). asSystem masks it, and a
 *    named repair or an Admin area route binds a system actor: both stay
 *    on the system pool.
 */
function loginWriteRoute(): LoginWriteRoute | null {
  if (!loginWritePoolOpen()) return null;
  const params = actorParams();
  if (!params) return null;
  const actor = currentActor();
  if (!actor || !WRITE_ROLE_ACTORS.has(actor.kind)) return null;
  const scope = loginWriteScope();
  if (!scope) return null;
  const home = currentCreateHome();
  const writeScope = writeScopeWithPrivate(scope, home);
  return {
    setSql: writeRoleSettingsSql(writeScope, params, home),
    actor: params[0],
    scope: writeScope,
    mode: params[2] === 'on' ? 'on' : 'warn',
  };
}

/** loginWriteRoute, after the pool's first mode read when it is still out
 *  (the startup race: a first write never goes out as off on a warn box). */
async function loginWriteRouteNow(): Promise<LoginWriteRoute | null> {
  const waitFor = firstModeRead;
  if (waitFor && loginWritePoolOpen() && currentActor() && !actorParams()) await waitFor;
  return loginWriteRoute();
}

/** Whether a write handed out now may go to the write role (decided again
 *  when it runs). False: the system handle as before, byte for byte. */
function loginWritesMayRoute(): boolean {
  return loginWritePoolOpen() && (actorCheckMode() !== 'off' || firstModeRead !== null);
}

/** A settings value as a quoted literal: the same rule as setActorSql's. */
function settingLiteral(v: string): string {
  if (v.includes('\0')) throw new Error('write role setting: NUL');
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * The one statement that sets a write-role transaction's scope, actor and
 * create home, transaction-local (SET LOCAL as set_config(..., true)),
 * sent pipelined with the transaction's first statement. Never a session
 * SET: a scope left on a pooled connection would be a stale access right.
 * Values inlined as checked literals (uuids, the actor's shapes, the stamp
 * as JSON), so it goes out in one step (see setActorSql).
 * `mantle.login_id` is the scope's login: the write role reads a login's
 * own rows by it, and the write check holds a fact of no item to it.
 * Exported for actor-client.test.ts only (not in index.ts).
 */
export function writeRoleSettingsSql(
  scope: WorkspaceScope,
  params: [string, string, string],
  home: CreateHome | null,
): string {
  if (scope.loginId !== null && !UUID_RE.test(scope.loginId)) {
    throw new Error('write role setting: login');
  }
  const set = (name: string, v: string) => `set_config('${name}', ${settingLiteral(v)}, true)`;
  const parts = [
    set('mantle.ws', uuidArrayLiteral(scope.ws, 'write role ws')),
    set('mantle.mod_ws', uuidArrayLiteral(scope.modWs, 'write role modWs')),
    set('mantle.login_id', scope.loginId?.toLowerCase() ?? ''),
  ];
  if (home) {
    parts.push(
      set('mantle.create_ws', checkedUuidOrEmpty(home.createWs)),
      set('mantle.private_ws', checkedUuidOrEmpty(home.privateWs)),
      set('mantle.ingest_notify', home.quiet ? 'off' : ''),
      set(
        'mantle.create_stamp',
        home.stamp && Object.keys(home.stamp).length > 0 ? JSON.stringify(home.stamp) : '',
      ),
    );
  }
  return `${ACTOR_SQL_TAG} ${setActorSql(params)}, ${parts.join(', ')}`;
}

/** The write role's raw pool (getViewerDb('write')). */
function writePoolSql(): PgSql {
  getViewerDb('write');
  return globalThis.__mantleViewerDbs!.get('write')!.sql;
}

/** The system pool's client with the actor: the gateway's system path. */
function adminSql(): PgSql {
  getAdminDb();
  return adminActorSql!;
}

/** The system pool's raw client: the checked rerun sets the actor itself,
 *  with the write role and the scope (checkedSettingsSql). */
function rawAdminSql(): PgSql {
  getAdminDb();
  return globalThis.__mantleSql!;
}

type QueryMode = 'rows' | 'values' | 'simple';

/** A postgres.js-like pending query over `run`: sent once, on the first
 *  `then`, `values` or `simple` (drizzle awaits it or calls `.values()`). */
function lazyQuery(run: (mode: QueryMode) => Promise<unknown>) {
  let pending: Promise<unknown> | null = null;
  const once = () => (pending ??= run('rows'));
  return {
    values: () => run('values'),
    simple: () => run('simple'),
    then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => once().then(ok, bad),
    catch: (bad?: (e: unknown) => unknown) => once().catch(bad),
    finally: (fn?: () => void) => once().finally(fn),
  };
}

/** A pending query: postgres.js's, or lazyQuery's. */
type QueryLike = PromiseLike<unknown> & { values(): unknown; simple(): unknown };

/** `q` in `mode`, sent now: its `.then` is called before this returns, so
 *  statements sent one after another go out in that order (postgres.js
 *  queues a query when its `.then` is called). */
function sendIn(q: QueryLike, mode: QueryMode): Promise<unknown> {
  const m = (
    mode === 'values' ? q.values() : mode === 'simple' ? q.simple() : q
  ) as PromiseLike<unknown>;
  return new Promise<unknown>((resolve, reject) => {
    m.then(resolve, reject);
  });
}

// ── Write-role gaps (A2b2b fix round 1, H1 and M1) ──────────────────────────

/**
 * A gap table (WRITE_ROLE_GAP_TABLES) met in a login's write transaction on
 * the write role: the gateway throws it for a statement whose target is
 * one (never sent), and at the end of a transaction whose caller caught a
 * gap (a savepoint): the transaction rolls back whole and runs again
 * (onLoginWritePool). Code 42501 and Postgres's own message, so a caller's
 * error handling is the same as for the database's answer.
 */
class WriteRoleGapError extends Error {
  readonly code = '42501';
  constructor(
    readonly table: string,
    options?: { cause?: unknown },
  ) {
    super(`permission denied for table ${table}`, options);
    this.name = 'WriteRoleGapError';
  }
}

/** The gap table of an error (writeRoleGapTable), else null. */
function gapTableOf(err: unknown): string | null {
  return writeRoleGapTable(permissionGapOf(err));
}

/**
 * A right the write role does not hold, met by a login write: noted every
 * time (a caught one too). Tests record it (vitest.setup.ts fails on one
 * that is not a gap table); elsewhere it is a miss row (check
 * 'write-role-gap') with what was denied and the caller. Never for a
 * refusal the database decided (a write check, a row rule).
 */
function noteWriteRoleGap(route: LoginWriteRoute, what: string): void {
  if (env('NODE_ENV') === 'test') {
    noteTestWriteRoleGap(what);
    return;
  }
  // The first frame outside @mantle/db (longStack's own frame included).
  const stack = longStack()
    .split('\n')
    .filter((line, i) => i === 0 || !line.replace(/\\/g, '/').includes('packages/db/src/'))
    .join('\n');
  const caller = systemDbCallerOf(stack) ?? 'unknown caller';
  noteActorMiss({
    source: 'ts',
    check: 'write-role-gap',
    actor: route.actor,
    detail: `${what.slice(0, 200)} from ${caller}`,
  });
}

/** A word in a statement's text that is one of `names`; never a match when
 *  there is none (an empty alternation would match everywhere: the gap list
 *  is empty since A3a). */
function nameRegExp(names: readonly string[]): RegExp {
  return names.length === 0 ? /(?!)/ : new RegExp(`\\b(${names.join('|')})\\b`, 'i');
}

/** The name of a gap table the write role cannot read, in a statement's
 *  text (a read that names one). */
const GAP_UNREADABLE_NAME = nameRegExp(WRITE_ROLE_GAP_UNREADABLE);

/** The name of any gap table in a statement's text. */
const GAP_TABLE_NAME = nameRegExp(Object.keys(WRITE_ROLE_GAP_TABLES));

/** A row-locking read (FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE, FOR KEY
 *  SHARE): it needs UPDATE on the table, which the write role holds on no
 *  gap table. */
const LOCKING_READ = /\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b/i;

/**
 * Whether a statement of a checked transaction runs as GAP_WRITER_ROLE (fix
 * round 2, L2): a single write whose target is a gap table, a row-locking
 * read that names a gap table (round 3, B: FOR UPDATE needs UPDATE), or a
 * read (needsActorWrap: none) that names a gap table the write role cannot
 * read at all. That role holds rights on the gap tables only, so nothing else
 * it might name is written there (a statement that needs more fails).
 * Every other statement runs as the write role, its row rules and write
 * checks on; one that needs a gap table there fails (never a second rerun).
 */
function runsAsGapWriterWhenChecked(query: string): boolean {
  const target = rawWriteTarget(query);
  if (target !== null) return isWriteRoleGapTable(target);
  if (needsActorWrap(query)) return false;
  const body = statementBody(query, false);
  // A row-locking read of a gap table (Recall's mapOr404, round 3, B), or
  // any read of one the write role cannot read.
  return (LOCKING_READ.test(body) && GAP_TABLE_NAME.test(body)) || GAP_UNREADABLE_NAME.test(body);
}

/** The write role's name, as its row rules and write checks name it. */
const WRITE_ROLE = 'mantle_write_user';

/** The checked rerun's settings (A2b2b fix round 1, M1): the write role
 *  (SET LOCAL ROLE as set_config), with the route's scope and actor. */
function checkedSettingsSql(route: LoginWriteRoute): string {
  return `${route.setSql}, set_config('role', '${WRITE_ROLE}', true)`;
}

// ── The write-role transaction (A2b2b fix round 1, M1 and M2) ──────────────

/** A login's write transaction open in this async context: on the write
 *  role, or the checked rerun on the system pool. */
type WriteTx = {
  route: LoginWriteRoute;
  /** The checked rerun: the system pool, every statement as the write role
   *  but those on a gap table (runsAsGapWriterWhenChecked). */
  checked: boolean;
  /** Its client once its work runs: a write that joins it runs here. */
  t: PgSql | null;
  /** Its work ended (or failed): nothing joins it, and no statement of it
   *  or of a savepoint under it reaches the driver any more. */
  done: boolean;
  /** The first gap table met on the role, a caught one too. */
  gap: string | null;
  /** The hooks of a withSystemTx joined to it (joinedSystemTx): run when
   *  this transaction commits or rolls back. */
  hooks: TxHooks;
  /** The savepoints at this level (joins, and drizzle's nested
   *  transactions), one after another (fix round 2, M1; round 3, C):
   *  settles when the last one queued has. Never rejects. */
  joins: Promise<void>;
  /** Savepoints queued or open at this level: a statement of this level
   *  waits for them (a savepoint between a statement and its answer would
   *  take the statement with it when it rolls back). */
  inFlight: number;
  /** Savepoints in the whole transaction, joins and nested withSystemTx
   *  alike (NESTED_SAVEPOINT_WARN; round 3, E). */
  saves: { n: number };
  /** The level this savepoint is under; null for the transaction. */
  parent: WriteTx | null;
};

const openWriteTx = new AsyncLocalStorage<WriteTx>();

/**
 * Run `fn` if the transaction the caller's work joined rolls back: an open
 * login write transaction (a request's db.transaction, M2), whose savepoint
 * the work's own transaction was, or else the scope's (afterRollback: a
 * personal space, a withSystemTx). Outside both the work has committed, and
 * this does nothing. For bytes written beside rows that may never commit (a
 * store broker's stage, A3b fix round 2, N6).
 */
export function afterOuterRollback(fn: () => unknown): void {
  const open = openWriteTx.getStore();
  if (open && !open.done) {
    open.hooks.rollback.push(fn);
    return;
  }
  afterRollback(fn);
}

/**
 * Run `fn` once the transaction the caller's work joined COMMITS (the twin
 * of afterOuterRollback); outside one the work has committed and `fn` runs
 * now. For what a store broker keeps until its flip can no longer be rolled
 * back (the old bytes of a file it replaced, A3b part 2).
 */
export async function afterOuterCommit(fn: () => unknown): Promise<void> {
  const open = openWriteTx.getStore();
  if (open && !open.done) {
    open.hooks.commit.push(fn);
    return;
  }
  await afterCommit(fn);
}

/**
 * One short transaction on a fresh connection of the system pool, outside
 * every caller's transaction and scope (never joined to an open login write
 * transaction or a savepoint of one, whose link it would wait behind), with
 * `lock_timeout`: a store broker's put-back after a flip that never landed
 * (A3b part 2 fix round 2, N3). `q` runs one statement in it; a lock wait
 * past `lockTimeoutMs` throws (55P03), as does a database that is gone.
 */
export async function brokerLockTx<T>(
  fn: (q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
  lockTimeoutMs = 2_000,
): Promise<T> {
  const sql = rawAdminSql();
  const ms = Math.max(1, Math.floor(lockTimeoutMs));
  // The raw client: no actor, no scope, no caller transaction to join (it
  // only reads and locks a row).
  return sql.begin(async (t) => {
    await t.unsafe(`set local lock_timeout = '${ms}ms'`);
    return fn(
      async (text, params = []) =>
        (await t.unsafe(text, params as never[])) as unknown as Record<string, unknown>[],
    );
  }) as Promise<T>;
}

/** A write transaction's state (WriteTx), or a savepoint's under `parent`.
 *  `saves`: the transaction's savepoint count when it is a system
 *  transaction's too (withSystemTx on the write role). */
function newWriteTx(
  route: LoginWriteRoute,
  checked: boolean,
  parent: WriteTx | null,
  saves?: { n: number },
): WriteTx {
  return {
    route,
    checked,
    t: null,
    done: false,
    gap: null,
    hooks: newTxHooks(),
    joins: Promise.resolve(),
    inFlight: 0,
    saves: parent ? parent.saves : (saves ?? { n: 0 }),
    parent,
  };
}

/** A statement or a join of a write transaction (or a savepoint of it)
 *  that had already ended or failed: refused before it reaches the driver
 *  (fix round 3, A). */
export class JoinedWriteEndedError extends Error {
  constructor() {
    super(
      'login write gateway: a statement of a write transaction that had ended (a detached call, or one left running when the transaction failed)',
    );
    this.name = 'JoinedWriteEndedError';
  }
}

/** Statements watchTx handed to the driver (tests: round 4, N1). */
let watchedSends = 0;

/** Tests only (not in index.ts): statements watched write transactions
 *  sent to the driver so far. */
export function watchedSendsForTests(): number {
  return watchedSends;
}

/** Whether `level` or a level above it has ended. */
function levelEnded(level: WriteTx): boolean {
  for (let l: WriteTx | null = level; l; l = l.parent) if (l.done) return true;
  return false;
}

/** Whether the current async context runs inside a savepoint under
 *  `level` (its store is a level below it). */
function insideBelow(level: WriteTx): boolean {
  for (let l = openWriteTx.getStore()?.parent ?? null; l; l = l.parent) {
    if (l === level) return true;
  }
  return false;
}

/** The savepoints joinWriteTx opens itself: the watched client lets them
 *  through, with the level their statements belong to. */
const ownSavepoints = new WeakMap<(sp: PgSql) => unknown, WriteTx>();

/**
 * Run `work` in a savepoint of `open` (M2; fix round 2, M1; round 3, A
 * and C): every savepoint at one level, a join's or drizzle's nested
 * transaction, runs one after another, never two at once (concurrent ones
 * interleave: a rollback to the second takes the first's statement with it
 * after its caller was told it succeeded). Its statements are a level of
 * their own (a WriteTx under `open`, the store while `work` runs). When
 * `work` fails, the level ends first and its own savepoints settle before
 * the `rollback to` (nothing of it runs after). Each counts toward
 * NESTED_SAVEPOINT_WARN with the transaction's other savepoints. postgres.js
 * never releases a savepoint, and a released one would not help: Postgres
 * keeps a subtransaction's id until the top transaction ends. Its hooks
 * join `open`'s when it succeeds.
 */
function joinWriteTx(open: WriteTx, work: (sp: PgSql) => unknown): Promise<unknown> {
  open.inFlight += 1;
  const run = open.joins.then(async () => {
    if (levelEnded(open)) throw new JoinedWriteEndedError();
    open.saves.n += 1;
    if (open.saves.n === NESTED_SAVEPOINT_WARN + 1) {
      console.warn(
        `[db] login write gateway: more than ${NESTED_SAVEPOINT_WARN} savepoints in one ` +
          'transaction (a top-level write in a loop?): past 64 subtransactions that write, ' +
          'every snapshot on the box gets slower (docs/actors.md)',
      );
    }
    const child = newWriteTx(open.route, open.checked, open);
    const inside = (sp: PgSql) => {
      child.t = sp;
      return openWriteTx.run(child, async () => {
        try {
          const value = await work(sp);
          await child.joins;
          return value;
        } catch (err) {
          // Ended first: what it left running settles, refused, before the
          // rollback to this savepoint.
          child.done = true;
          // Uncapped (round 5, N5): every savepoint scope under it must
          // finish before its own `rollback to` goes.
          await child.joins;
          throw err;
        } finally {
          child.done = true;
        }
      });
    };
    ownSavepoints.set(inside, child);
    try {
      const out = await (
        open.t as unknown as { savepoint: (fn: (sp: PgSql) => unknown) => Promise<unknown> }
      ).savepoint(inside);
      open.hooks.commit.push(...child.hooks.commit);
      open.hooks.rollback.push(...child.hooks.rollback);
      return out;
    } catch (err) {
      child.done = true;
      await runTxHooks(child.hooks.rollback, 'rollback');
      throw err;
    }
  });
  const settled = run.finally(() => {
    open.inFlight -= 1;
  });
  open.joins = settled.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The open write transaction a write of `route` joins (M2): same actor,
 *  scope and create home, its work still running. */
function joinableWriteTx(route: LoginWriteRoute): WriteTx | null {
  const open = openWriteTx.getStore();
  return open && !levelEnded(open) && open.t && open.route.setSql === route.setSql ? open : null;
}

/**
 * A transaction's client (of `level`, in the transaction `tx`) that
 * watches each statement (wrapped by settingsFirst, so the SET goes first):
 *  - a statement of a level that has ended (or one above it) is refused
 *    before it reaches the driver (fix round 3, A): nothing is sent after
 *    the transaction's ROLLBACK, or a savepoint's;
 *  - a statement of a level with savepoints queued or open goes after them
 *    (fix round 2, M1), unless it runs inside one of them;
 *  - on the write role, a write whose target is a gap table is never sent:
 *    a WriteRoleGapError, the gap noted and kept (H1, L6). A denial
 *    Postgres answers is noted; a gap table's is kept too, so a gap the
 *    caller caught still runs the transaction again;
 *  - checked (M1), a statement on a gap table runs as GAP_WRITER_ROLE
 *    (rights on the gap tables only), between `set local role` to it and
 *    the write role set back, sent in one go; every other runs as the
 *    write role.
 * A savepoint (drizzle's nested transaction) is one of the level's
 * savepoints (joinWriteTx): in line with the joins, a level of its own.
 */
function watchTx(t: PgSql, tx: WriteTx, level: WriteTx): PgSql {
  const observe = (p: Promise<unknown>): Promise<unknown> =>
    p.catch((err: unknown) => {
      const what = permissionGapOf(err);
      if (what) {
        noteWriteRoleGap(tx.route, what);
        const table = writeRoleGapTable(what);
        if (table && !tx.checked) tx.gap ??= table;
      }
      throw err;
    });
  const statement = (text: string, send: () => Promise<unknown>): Promise<unknown> => {
    // The gateway's own SET is never held: a savepoint waits for it.
    if (text.startsWith(ACTOR_SQL_TAG)) return direct(text, send);
    if (level.inFlight > 0 && !insideBelow(level)) {
      return level.joins.then(() => direct(text, send));
    }
    return direct(text, send);
  };
  const direct = (text: string, send: () => Promise<unknown>): Promise<unknown> => {
    // Nothing of an ended level reaches the driver, the gateway's own SET
    // neither (round 4, N1): sent late it would land on a pooled
    // connection, maybe in another actor's transaction, with this one's
    // scope and actor. (The gap window's role switches go on the raw `t`.)
    if (levelEnded(level)) return Promise.reject(new JoinedWriteEndedError());
    watchedSends += 1;
    if (!tx.checked) {
      const target = rawWriteTarget(text);
      if (target !== null && isWriteRoleGapTable(target)) {
        const table = target.replace(/^public\./, '');
        noteWriteRoleGap(tx.route, `permission denied for table ${table}`);
        tx.gap ??= table;
        return Promise.reject(new WriteRoleGapError(table));
      }
      return observe(send());
    }
    if (!runsAsGapWriterWhenChecked(text)) return observe(send());
    // In order, in one send: the gap writer for this statement only.
    const off = sendIn(t.unsafe(`${ACTOR_SQL_TAG} set local role ${GAP_WRITER_ROLE}`), 'rows');
    const main = observe(send());
    const back = sendIn(
      t.unsafe(`${ACTOR_SQL_TAG} select set_config('role', '${WRITE_ROLE}', true)`),
      'rows',
    );
    return Promise.allSettled([off, main, back]).then(([a, b, c]) => {
      if (a.status === 'rejected') throw a.reason;
      if (b.status === 'rejected') throw b.reason;
      if (c.status === 'rejected') throw c.reason;
      return b.value;
    });
  };
  const client: PgSql = new Proxy(t, {
    apply(target, thisArg, args: unknown[]) {
      const strings = args[0] as TemplateStringsArray | undefined;
      const call = () =>
        Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
      // Not a statement (a helper: identifiers, values): as it is.
      if (!Array.isArray(strings) || !('raw' in strings)) return call();
      return lazyQuery((mode) =>
        statement(strings.join('$1'), () => sendIn(call() as QueryLike, mode)),
      );
    },
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: unknown) =>
          lazyQuery((mode) =>
            statement(query, () =>
              sendIn(target.unsafe(query, args as never[], opts as never), mode),
            ),
          );
      }
      if (prop === 'savepoint') {
        return (...a: unknown[]) => {
          const fn = a[a.length - 1] as (sp: PgSql) => unknown;
          const child = ownSavepoints.get(fn);
          // Another savepoint (drizzle's nested transaction): one of this
          // level's, in line (round 3, C).
          if (!child) {
            if (levelEnded(level)) return Promise.reject(new JoinedWriteEndedError());
            return joinWriteTx(level, fn);
          }
          return (
            target as unknown as { savepoint: (...x: unknown[]) => PromiseLike<unknown> }
          ).savepoint(...a.slice(0, -1), (sp: PgSql) => fn(watchTx(sp, tx, child)));
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return client;
}

// ── A bounded wait for the write pool (A2b2b fix round 1, M2) ──────────────

/** How long a write waits for a write-pool connection (VIEWER_POOL_MAX per
 *  process) before it fails: the pool held by stuck work becomes an error,
 *  never a hang. */
const WRITE_POOL_WAIT_MS = 15_000;
let writePoolWaitMs = WRITE_POOL_WAIT_MS;

/** Tests only (not in index.ts): the write pool's wait; null restores it. */
export function setWritePoolWaitForTests(ms: number | null): void {
  writePoolWaitMs = ms ?? WRITE_POOL_WAIT_MS;
}

/** No write-pool connection within the wait (WRITE_POOL_WAIT_MS). Busy:
 *  the API answers it as one (isBusy, 409), and it is logged. */
export class WritePoolBusyError extends BusyError {
  constructor() {
    super('The server is busy; try again in a moment.');
    this.name = 'WritePoolBusyError';
  }
}

function writePoolBusy(): WritePoolBusyError {
  console.error(
    `[db] login write gateway: no write-pool connection within ${writePoolWaitMs} ms (A2b2b M2)`,
  );
  return new WritePoolBusyError();
}

/**
 * A new write-pool connection is taken while this context holds another
 * (a write of another actor or scope inside an open write transaction):
 * enough of them at once would wait on each other. Tests fail on it; the
 * bounded wait covers the rest.
 */
function checkNestedAcquire(): void {
  const open = openWriteTx.getStore();
  if (open && !open.done && !open.checked && env('NODE_ENV') === 'test') {
    throw new Error(
      'login write gateway: a second write-pool connection taken inside an open write transaction (A2b2b M2)',
    );
  }
}

/** sql.begin on the write pool, waiting at most writePoolWaitMs for a
 *  connection. A begin that gets one later rolls back at once. */
function boundedBegin(config: unknown[], work: (t: PgSql) => Promise<unknown>): Promise<unknown> {
  checkNestedAcquire();
  let started = false;
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const begun = (writePoolSql().begin as (...a: unknown[]) => Promise<unknown>)(
    ...config,
    (t: PgSql) => {
      if (late) throw new WritePoolBusyError();
      started = true;
      clearTimeout(timer);
      return work(t);
    },
  );
  begun.catch(() => undefined);
  const wait = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (started) return;
      late = true;
      reject(writePoolBusy());
    }, writePoolWaitMs);
    timer.unref?.();
  });
  return Promise.race([begun, wait]).finally(() => clearTimeout(timer));
}

/** A write-pool connection as a lease (reserved.ts: back to the pool only
 *  while usable), waiting at most writePoolWaitMs. One that comes later
 *  goes back at once, by its lease. */
async function boundedReserve(): Promise<Lease> {
  checkNestedAcquire();
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reserved = reserveLease(writePoolSql());
  const wait = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      late = true;
      reject(writePoolBusy());
    }, writePoolWaitMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([reserved, wait]);
  } finally {
    clearTimeout(timer);
    if (late)
      void reserved.then(
        (lease) => lease.release(),
        () => undefined,
      );
  }
}

// ── The gateway's runner ────────────────────────────────────────────────────

/** How one kind of write runs through the gateway. */
type GatewayPaths<T> = {
  /** Today's path, the system pool (off; a gap's rerun in warn). */
  system: () => Promise<T>;
  /** On the write role. */
  write: (route: LoginWriteRoute) => Promise<T>;
  /** Inside an open write transaction of the same route (M2). */
  join: (open: WriteTx) => Promise<T>;
  /** A gap's rerun in on: checked (M1). None: the gap stays an error. */
  checked?: (route: LoginWriteRoute) => Promise<T>;
};

/**
 * Run a write through the gateway (arch A2b2b): `system` when
 * loginWriteRoute says the system pool; inside an open write transaction
 * of the same route, `join`; else `write` on the write role. An attempt
 * that met a gap table (H1: WRITE_ROLE_GAP_TABLES only) rolled back whole
 * and runs once more: in warn on the system pool, as before A2b2b; in on
 * checked (M1), so no item write leaves the role's checks. Any other
 * error, any other denial included, is the caller's.
 */
async function onLoginWritePool<T>(paths: GatewayPaths<T>): Promise<T> {
  const route = await loginWriteRouteNow();
  if (!route) return paths.system();
  const open = joinableWriteTx(route);
  if (open) return paths.join(open);
  // A write of the same route left running inside a transaction that has
  // ended (round 3, A): refused, never sent on a connection of its own.
  const store = openWriteTx.getStore();
  if (store && store.route.setSql === route.setSql && levelEnded(store)) {
    throw new JoinedWriteEndedError();
  }
  try {
    return await paths.write(route);
  } catch (err) {
    if (gapTableOf(err) === null) throw err;
    if (route.mode === 'warn') return paths.system();
    if (!paths.checked) throw err;
    return paths.checked(route);
  }
}

/**
 * One write outside a transaction on the write role: BEGIN, the settings,
 * the statement and COMMIT pipelined on one reserved connection (one round
 * trip, as a turn scope's read). A failing statement aborts the
 * transaction, the COMMIT then rolls back, and the first error is thrown.
 */
async function writeRoleStatement(
  route: LoginWriteRoute,
  query: string,
  args: unknown[] | undefined,
  mode: QueryMode,
): Promise<unknown> {
  const lease = await boundedReserve();
  try {
    const conn = lease.sql;
    // BEGIN and COMMIT are the gateway's own, tagged as the actor's
    // (a2a-round-trips.db.test.ts counts them apart). Sent in this order,
    // each watched (a connection error marks the lease gone).
    const begin = lease.watch(sendIn(conn.unsafe(`${ACTOR_SQL_TAG} begin`), 'rows'));
    const set = lease.watch(sendIn(conn.unsafe(route.setSql), 'rows'));
    const main = lease.watch(sendIn(conn.unsafe(query, (args ?? []) as never[]), mode));
    const commit = lease.watch(sendIn(conn.unsafe(`${ACTOR_SQL_TAG} commit`), 'rows'));
    const out = await Promise.allSettled([begin, set, main, commit]);
    const failed = out.find((r) => r.status === 'rejected');
    if (failed) {
      const err = (failed as PromiseRejectedResult).reason;
      const what = permissionGapOf(err);
      if (what) noteWriteRoleGap(route, what);
      throw err;
    }
    return (out[2] as PromiseFulfilledResult<unknown>).value;
  } finally {
    lease.release();
  }
}

/**
 * Run `work` as the outermost login write transaction `begin` opens: its
 * client watched (watchTx) behind the one SET (settingsFirst), open to
 * writes that join it while `work` runs (openWriteTx). A gap it met (a
 * caught one too) fails it whole. The hooks of a withSystemTx joined to it
 * run once it commits or rolls back.
 */
async function writeTxOf(
  tx: WriteTx,
  setSql: string,
  begin: (work: (t: PgSql) => Promise<unknown>) => Promise<unknown>,
  work: (t: PgSql) => unknown,
): Promise<unknown> {
  let out: unknown;
  try {
    // Open to joins only while its work runs: the connection is taken
    // outside (checkNestedAcquire sees the caller's context, not this).
    out = await begin((t) =>
      openWriteTx.run(tx, async () => {
        const client = settingsFirst(watchTx(t, tx, tx), () => setSql);
        tx.t = client;
        try {
          const value = await work(client);
          // Joins left running (not awaited) finish inside it.
          await tx.joins;
          if (tx.gap) throw new WriteRoleGapError(tx.gap);
          return value;
        } catch (err) {
          // Ended first (round 3, A): what it left running settles,
          // refused before the driver, before postgres.js sends the
          // ROLLBACK and hands the connection back.
          tx.done = true;
          // Uncapped (round 5, N5): a capped wait let postgres.js send a
          // late `rollback to` on a connection already handed on.
          await tx.joins;
          if (tx.gap && gapTableOf(err) === null) {
            throw new WriteRoleGapError(tx.gap, { cause: err });
          }
          throw err;
        } finally {
          tx.done = true;
        }
      }),
    );
  } catch (err) {
    tx.done = true;
    await runTxHooks(tx.hooks.rollback, 'rollback');
    throw err;
  }
  await runTxHooks(tx.hooks.commit, 'commit');
  return out;
}

/** A transaction on the write role (begin's arguments, the last one its
 *  work): its settings go with its first statement, so they cost no round
 *  trip. */
function writeRoleBegin(
  route: LoginWriteRoute,
  args: unknown[],
  saves?: { n: number },
): Promise<unknown> {
  const work = args[args.length - 1] as (t: PgSql) => unknown;
  const tx = newWriteTx(route, false, null, saves);
  return writeTxOf(tx, route.setSql, (w) => boundedBegin(args.slice(0, -1), w), work);
}

/**
 * A gap's rerun in on (M1): the same transaction on the system pool, every
 * statement as the write role (SET LOCAL ROLE, its row rules and write
 * checks on) but those on a gap table, which run as GAP_WRITER_ROLE
 * (runsAsGapWriterWhenChecked). The staged checks refuse here as the role
 * does in on (the session is not the write role's login). Needs a system
 * login that may SET ROLE to the write role (a superuser, as every box's
 * is); one that may not fails loudly.
 */
function checkedBegin(
  route: LoginWriteRoute,
  args: unknown[],
  saves?: { n: number },
): Promise<unknown> {
  const work = args[args.length - 1] as (t: PgSql) => unknown;
  const tx = newWriteTx(route, true, null, saves);
  return writeTxOf(
    tx,
    checkedSettingsSql(route),
    (w) => (rawAdminSql().begin as (...a: unknown[]) => Promise<unknown>)(...args.slice(0, -1), w),
    work,
  );
}

/** A transaction (begin's arguments) joined to an open write transaction
 *  (M2): a savepoint of it, watched as it is (joinWriteTx). */
function joinedBegin(open: WriteTx, args: unknown[]): Promise<unknown> {
  return joinWriteTx(open, args[args.length - 1] as (t: PgSql) => unknown);
}

/** One statement joined to an open write transaction (M2), in a savepoint
 *  of its own: a statement that fails leaves the transaction as it was, as
 *  on a connection of its own. */
function joinedStatement(
  open: WriteTx,
  query: string,
  args: unknown[] | undefined,
  mode: QueryMode,
): Promise<unknown> {
  return joinedBegin(open, [
    (sp: PgSql) => sendIn(sp.unsafe(query, (args ?? []) as never[]), mode),
  ]);
}

/**
 * The client behind the gateway's drizzle handle (loginWriteDb): what a
 * scoped write that `db` sends to the system pool (insert, update, delete,
 * a mutating request's transaction, executeWrite) runs on. Each statement
 * and each transaction asks the gateway when it runs; the system path is
 * exactly the system pool's client.
 */
function loginWriteClient(): PgSql {
  const run = (query: string, args: unknown[] | undefined, mode: QueryMode) => {
    const system = () => sendIn(adminSql().unsafe(query, args as never[]), mode);
    if (runsOutsideTransaction(query)) return system();
    // A single write to a table the write role holds no right on goes to
    // the system pool before it is sent (no failed attempt).
    const target = rawWriteTarget(query);
    if (target !== null && !WRITE_ROLE_TABLE_SET.has(target)) return system();
    return onLoginWritePool({
      system,
      write: (route) => writeRoleStatement(route, query, args, mode),
      join: (open) => joinedStatement(open, query, args, mode),
    });
  };
  const client = {
    get options() {
      return adminSql().options;
    },
    unsafe(query: string, args?: unknown[]) {
      return lazyQuery((mode) => run(query, args, mode));
    },
    begin(...args: unknown[]) {
      return onLoginWritePool({
        system: () => (adminSql().begin as (...a: unknown[]) => Promise<unknown>)(...args),
        write: (route) => writeRoleBegin(route, args),
        join: (open) => joinedBegin(open, args),
        checked: (route) => checkedBegin(route, args),
      });
    },
  };
  return client as unknown as PgSql;
}

let loginWriteDbCache: PostgresJsDatabase<typeof schema> | null = null;

/** The gateway's drizzle handle (loginWriteClient), one per process. */
function loginWriteDb(): PostgresJsDatabase<typeof schema> {
  return (loginWriteDbCache ??= drizzle(loginWriteClient(), { schema }));
}

/** The handle a scoped write goes to: the gateway's when it may route,
 *  else the system pool's, as before A2b2b. */
function systemWriteDb(): PostgresJsDatabase<typeof schema> {
  return loginWritesMayRoute() ? loginWriteDb() : getAdminDb();
}

/** How the system transaction being opened (withSystemTx) runs: read by
 *  writeTxDb's begin. */
type WriteTxOpen =
  | { how: 'write'; route: LoginWriteRoute; saves: { n: number } }
  | { how: 'checked'; route: LoginWriteRoute; saves: { n: number } }
  | { how: 'join'; open: WriteTx };
const writeTxOpen = new AsyncLocalStorage<WriteTxOpen>();

let writeTxDbCache: PostgresJsDatabase<typeof schema> | null = null;

/** A drizzle handle whose transactions open as writeTxOpen says
 *  (withSystemTx's write paths). */
function writeTxDb(): PostgresJsDatabase<typeof schema> {
  return (writeTxDbCache ??= drizzle(
    {
      get options() {
        return adminSql().options;
      },
      begin(...args: unknown[]) {
        const o = writeTxOpen.getStore();
        if (!o) return Promise.reject(new Error('writeTxDb: no write route'));
        if (o.how === 'join') return joinedBegin(o.open, args);
        return o.how === 'checked'
          ? checkedBegin(o.route, args, o.saves)
          : writeRoleBegin(o.route, args, o.saves);
      },
    } as unknown as PgSql,
    { schema },
  ));
}

/** A withSystemTx on the write role (`how`), as the outermost system
 *  transaction: its own hooks and nest (openSystemTx). */
function writeRoleSystemTx<T>(
  how: 'write' | 'checked',
  route: LoginWriteRoute,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  // One savepoint count for the transaction: its nested withSystemTx and
  // its joins (round 3, E).
  return openSystemTx(
    (run, saves) => writeTxOpen.run({ how, route, saves }, () => writeTxDb().transaction(run)),
    fn,
  );
}

/**
 * withSystemTx inside an open login write transaction of the same route (a
 * request's db.transaction, M2): a savepoint of it, as nestedSystemTx is of
 * a system transaction, never a second connection. An inner error rolls
 * back the inner writes and runs its rollback hooks; on success its hooks
 * follow the outer transaction's end.
 */
async function joinedSystemTx<T>(
  open: WriteTx,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const hooks = newTxHooks();
  // The transaction's own savepoint count (round 3, E).
  const nest: SystemTxNest = { ...systemTxKeys(), busy: false, done: false, saves: open.saves };
  let result: T;
  try {
    result = await writeTxOpen.run({ how: 'join', open }, () =>
      writeTxDb().transaction((tx) => runInSystemTx({ tx, hooks, nest }, () => fn(tx))),
    );
  } catch (err) {
    nest.done = true;
    await runTxHooks(hooks.rollback, 'rollback');
    throw err;
  }
  nest.done = true;
  open.hooks.commit.push(...hooks.commit);
  open.hooks.rollback.push(...hooks.rollback);
  return result;
}

/**
 * A turn's scope was looked for at query time and is gone (workspaces W4b):
 * a query built inside a turn scope ran after the turn ended, or from a
 * callback that does not carry it. Refused, never run unscoped.
 */
export class ScopeLostError extends Error {
  readonly code = 'scope-lost';
  constructor() {
    super('A scoped query ran outside its turn scope; refused (it never runs unscoped).');
    this.name = 'ScopeLostError';
  }
}

const SCOPE_SETTINGS_SQL =
  "select set_config('mantle.ws', $1, true), set_config('mantle.mod_ws', $2, true), " +
  "set_config('mantle.login_id', $3, true)";

/** The settings of the turn scope running NOW: read when a query runs, not
 *  when it was built. */
function turnScopeParams(): [string, string, string] {
  const scope = currentWorkspaceScope();
  if (!scope || !inTurnScope()) throw new ScopeLostError();
  return [
    uuidArrayLiteral(scope.ws, 'turn scope ws'),
    uuidArrayLiteral(scope.modWs, 'turn scope modWs'),
    scope.loginId ?? '',
  ];
}

type PgSql = ReturnType<typeof postgres>;

/**
 * A postgres.js client for drizzle that runs every query in its own short
 * transaction on the workspace role: BEGIN, the turn's scope settings
 * (transaction-local), the query, COMMIT, pipelined on one connection. The
 * scope is read when the query RUNS; with none (the turn ended, or the
 * callback lost it) the query is refused (ScopeLostError), never sent on
 * another pool. `begin` (db.transaction) sets the same settings first, so a
 * search step that needs one transaction (withHnswPool) keeps the scope.
 * Exported for reserved.db.test.ts only (not in index.ts).
 */
export function turnScopedClient(base: PgSql): PgSql {
  // BEGIN, the settings, the query and COMMIT go out together on one
  // reserved connection: one round trip, not three (W6a: `begin` waits for
  // BEGIN, and COMMIT is a trip of its own). A failing statement aborts the
  // transaction; the COMMIT then rolls back, and the first error is thrown.
  const run = async (
    query: string,
    params: unknown[] | undefined,
    mode: 'rows' | 'values' | 'simple',
  ) => {
    const settings = turnScopeParams();
    // A connection that died on the way is not handed back (reserved.ts).
    return withLease(base, async (lease) => {
      const conn = lease.sql;
      const begin = conn.unsafe('begin');
      const scope = conn.unsafe(SCOPE_SETTINGS_SQL, settings);
      const q = conn.unsafe(query, (params ?? []) as never[]);
      // A raw caller's simple protocol (a parameterless query with its own
      // literals, entities.ts graph paths) works in a scope too (W7a).
      const main = mode === 'values' ? q.values() : mode === 'simple' ? q.simple() : q;
      const commit = conn.unsafe('commit');
      const out = await Promise.allSettled([begin, scope, main, commit].map((s) => lease.watch(s)));
      const failed = out.find((r) => r.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
      return (out[2] as PromiseFulfilledResult<unknown>).value;
    });
  };
  const client = {
    options: base.options,
    unsafe(query: string, params?: unknown[]) {
      let pending: Promise<unknown> | null = null;
      const once = () => (pending ??= run(query, params, 'rows'));
      return {
        values: () => run(query, params, 'values'),
        simple: () => run(query, params, 'simple'),
        then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => once().then(ok, bad),
        catch: (bad?: (e: unknown) => unknown) => once().catch(bad),
        finally: (fn?: () => void) => once().finally(fn),
      };
    },
    begin(fn: (t: PgSql) => unknown) {
      let settings: [string, string, string];
      try {
        settings = turnScopeParams();
      } catch (err) {
        return Promise.reject(err);
      }
      return base.begin(async (t) => {
        await t.unsafe(SCOPE_SETTINGS_SQL, settings);
        return fn(t as unknown as PgSql);
      });
    },
  };
  return client as unknown as PgSql;
}

/** The drizzle handle of turn scopes: one per process, over the workspace
 *  role's pool. */
function getTurnScopedDb(): PostgresJsDatabase<typeof schema> {
  if (globalThis.__mantleTurnDb) return globalThis.__mantleTurnDb;
  getViewerDb('user');
  const base = globalThis.__mantleViewerDbs!.get('user')!.sql;
  const client = drizzle(turnScopedClient(base), { schema });
  globalThis.__mantleTurnDb = client;
  return client;
}

/** The handle for the current scope (viewer.ts): a scope's own transaction,
 *  a turn scope's per-query handle, else admin (system work). */
function getDb(): PostgresJsDatabase<typeof schema> {
  const tx = currentScopeTx();
  if (tx) return tx as PostgresJsDatabase<typeof schema>;
  if (inTurnScope()) return getTurnScopedDb();
  return getAdminDb();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A nested system transaction that cannot reuse the open one (arch A2b,
 *  plan 20.2): another actor or create home, a second nested call while one
 *  runs, or a call after the open transaction ended. */
export class NestedSystemTxError extends Error {
  readonly code = 'nested-system-tx';
  constructor(what: 'actor' | 'create home' | 'parallel' | 'ended') {
    super(
      what === 'parallel'
        ? 'withSystemTx: a nested call while another nested call runs on the same transaction is refused'
        : what === 'ended'
          ? 'withSystemTx: a nested call after its transaction ended is refused (a detached call?)'
          : `withSystemTx: a nested call with a different ${what} than the open transaction is refused`,
    );
    this.name = 'NestedSystemTxError';
  }
}

/** What a system transaction opened now would run as: its actor and create
 *  home, as keys a nested call compares (SystemTxNest). The write scope is
 *  not one: inside a system transaction it reads as none (the transaction
 *  masks the request's), so the open one's applies. */
function systemTxKeys(): Pick<SystemTxNest, 'actor' | 'home'> {
  const actor = currentActor();
  const home = currentCreateHome();
  return {
    actor: actor ? `${actorSetting(actor)}|${writeModeOf(actor)}` : '',
    home: home
      ? JSON.stringify([home.createWs, home.privateWs, !!home.quiet, home.stamp ?? null])
      : '',
  };
}

/**
 * Nested calls in one outer transaction before a warning (A2b1 fix round 2,
 * L2). Each is a savepoint that postgres.js never releases, and a released
 * one would not help: Postgres keeps a subtransaction's id until the top
 * transaction ends. Past 64 subtransactions that wrote, the backend's
 * subtransaction cache overflows and every snapshot on the box pays for it.
 * So no nested write in a loop; the warning finds one.
 */
export const NESTED_SAVEPOINT_WARN = 32;

/**
 * withSystemTx nested in an open system transaction (arch A2b, plan 20.2;
 * A2b1 audit M2): a SAVEPOINT of that transaction, never a second one. An
 * inner error rolls back the inner writes only, and runs the inner
 * rollback hooks; on success the inner hooks join the outer ones and
 * follow its outcome. One nested call at a time per level, and none after
 * the level ended (a detached call).
 */
async function nestedSystemTx<T>(
  outer: NonNullable<ReturnType<typeof currentSystemTx>>,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (outer.nest.done) throw new NestedSystemTxError('ended');
  if (outer.nest.busy) throw new NestedSystemTxError('parallel');
  const want = systemTxKeys();
  if (want.actor !== outer.nest.actor) throw new NestedSystemTxError('actor');
  if (want.home && want.home !== outer.nest.home) throw new NestedSystemTxError('create home');
  const hooks = newTxHooks();
  const nest: SystemTxNest = {
    actor: outer.nest.actor,
    home: outer.nest.home,
    busy: false,
    done: false,
    saves: outer.nest.saves,
  };
  // Counted once (round 4, N2): on the write role its savepoint goes
  // through joinWriteTx, which counts it in the same count. Only when this
  // system transaction is that write transaction (round 5, N6): a system
  // pool one inside a live write transaction counts its own.
  const onRole = openWriteTx.getStore();
  const countedByJoin = !!onRole && !levelEnded(onRole) && onRole.saves === outer.nest.saves;
  if (!countedByJoin) outer.nest.saves.n += 1;
  if (!countedByJoin && outer.nest.saves.n === NESTED_SAVEPOINT_WARN + 1) {
    console.warn(
      `[db] withSystemTx: more than ${NESTED_SAVEPOINT_WARN} nested calls in one transaction ` +
        '(a nested write in a loop?): past 64 subtransactions that write, every snapshot ' +
        'on the box gets slower (docs/actors.md)',
    );
  }
  outer.nest.busy = true;
  let result: T;
  try {
    result = await (outer.tx as PostgresJsDatabase<typeof schema>).transaction((sp) =>
      runInSystemTx({ tx: sp, hooks, nest }, () =>
        fn(sp as unknown as PostgresJsDatabase<typeof schema>),
      ),
    );
  } catch (err) {
    nest.done = true;
    outer.nest.busy = false;
    await runTxHooks(hooks.rollback, 'rollback');
    throw err;
  }
  nest.done = true;
  outer.nest.busy = false;
  outer.hooks.commit.push(...hooks.commit);
  outer.hooks.rollback.push(...hooks.rollback);
  return result;
}

/**
 * Run `fn` in ONE admin-pool transaction, on its own connection: every `db`
 * query inside is that transaction (`fn` gets it too). `afterCommit` work
 * inside runs once it commits, `afterRollback` work once it rolls back:
 * file side effects follow the rows they belong to (team apps follow-up).
 * Only from outside any viewer scope and outside another transaction scope,
 * or nested in a system transaction: then it is a savepoint of that one
 * (nestedSystemTx), for the same actor and create home only.
 */
export async function withSystemTx<T>(
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const outer = currentSystemTx();
  if (outer) return nestedSystemTx(outer, fn);
  // A request scope (W6a) writes through here: writes stay on the system
  // pool with their rule in the statement (plan 2.3), in a read request too
  // (a lazy backfill, a root folder made on first open).
  const inRequest = currentRequestMode() !== null;
  if ((!isSystemScope() && !inRequest) || currentScopeTx()) {
    throw new Error('withSystemTx: only outside a viewer scope and any other transaction');
  }
  // Tests and development: a request scope's system transaction is one of
  // its writes (W6a fix round 2, L-c), pinned by the route sweep with the
  // file that opened it.
  if (inRequest) noteRequestSystemWrite('withSystemTx');
  // Arch A2a: the transaction runs as the current actor (actorClient sets
  // it first); none bound is a miss, logged only.
  checkActorBound('withSystemTx');
  // A scoped write (a login's, an Admin user's write request, an Admin
  // turn) runs on the write role when the gateway says so (arch A2b2b):
  // its scope, actor and create home set by one SET LOCAL with its first
  // statement. Else the system pool, as before.
  return onLoginWritePool({
    system: () => systemPoolTx(fn),
    write: (route) => writeRoleSystemTx('write', route, fn),
    join: (open) => joinedSystemTx(open, fn),
    checked: (route) => writeRoleSystemTx('checked', route, fn),
  });
}

/** A system transaction as before A2b2b, on the system pool. */
function systemPoolTx<T>(fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>): Promise<T> {
  // An Admin user's write request (W6a fix round 1, M1): the login's scope
  // on the transaction, so the database checks moves (0241/0245), creates in
  // a folder and deletes (0266) against its workspaces. mantle.login_id is
  // left unset: the 0250 stamp would otherwise mark trace, run and chat rows
  // made in the same transaction as this login's, which nothing asks for.
  const writeScope = requestWriteScope();
  const settings = writeScope
    ? [
        uuidArrayLiteral(writeScope.ws, 'write scope ws'),
        uuidArrayLiteral(writeScope.modWs, 'write scope modWs'),
      ]
    : null;
  // Where a create lands (W6b): the database's default home reads these.
  const home = currentCreateHome();
  const homeSettings = home
    ? [
        checkedUuidOrEmpty(home.createWs),
        checkedUuidOrEmpty(home.privateWs),
        home.stamp && Object.keys(home.stamp).length > 0 ? JSON.stringify(home.stamp) : '',
      ]
    : null;
  return openSystemTx(
    (run) =>
      getAdminDb().transaction(async (tx) => {
        if (settings) {
          await tx.execute(
            sqlTag`select set_config('mantle.ws', ${settings[0]}, true),
                          set_config('mantle.mod_ws', ${settings[1]}, true)`,
          );
        }
        if (homeSettings) {
          await tx.execute(
            sqlTag`select set_config('mantle.create_ws', ${homeSettings[0]}, true),
                          set_config('mantle.private_ws', ${homeSettings[1]}, true),
                          set_config('mantle.ingest_notify', ${home?.quiet ? 'off' : ''}, true),
                          set_config('mantle.create_stamp', ${homeSettings[2]}, true)`,
          );
        }
        return run(tx);
      }),
    fn,
  );
}

/** Run `fn` as the outermost system transaction that `open` opens: its own
 *  hooks and nest (withSystemTx's rules), its rollback hooks run when it
 *  fails, its commit hooks once it commits. */
async function openSystemTx<T>(
  open: (
    run: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
    saves: { n: number },
  ) => Promise<T>,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const hooks = newTxHooks();
  const nest: SystemTxNest = { ...systemTxKeys(), busy: false, done: false, saves: { n: 0 } };
  let result: T;
  try {
    result = await open((tx) => runInSystemTx({ tx, hooks, nest }, () => fn(tx)), nest.saves);
  } catch (err) {
    nest.done = true;
    await runTxHooks(hooks.rollback, 'rollback');
    throw err;
  }
  nest.done = true;
  await runTxHooks(hooks.commit, 'commit');
  return result;
}

/**
 * login(rw | owner) for `loginId`, read as that login is NOW (arch A2a, plan
 * 4.1): deferred work done for a login (a run, a heartbeat, a pending call,
 * a turn) binds this when it runs, not what the login was when the work was
 * queued. A2a refuses nothing: a login disabled since (or gone) is still
 * bound and named in one warning. `entry` is the system reason of the entry
 * asking (worker:runs); a bad id gives system(entry).
 */
export async function loginActorNow(
  loginId: string,
  entry: string,
  mode: 'rw' | 'owner' = 'rw',
): Promise<Actor> {
  let actor: Actor;
  try {
    actor = loginActor(loginId, mode);
  } catch {
    return systemActor(entry);
  }
  // With the check off nothing reads the actor: no query (fix round, L1;
  // the owner's rule, no new query on a hot path while off).
  if (actorCheckMode() === 'off') return actor;
  try {
    const rows = (await runAsSystem(entry, () =>
      getAdminDb().execute(
        // The actor's own lookup: tagged (ACTOR_SQL_TAG).
        sqlTag`/* mantle:actor */ select disabled_at is not null as off from auth.users where id = ${loginId}::uuid`,
      ),
    )) as unknown as { off: boolean }[];
    if (!rows[0] || rows[0].off) {
      console.warn(`[${entry}] login ${loginId} is disabled now; the work runs as it anyway (A2a)`);
    }
  } catch (err) {
    console.warn(`[${entry}] could not read login ${loginId}: ${errorMessage(err)}`);
  }
  return actor;
}

/** A uuid, checked, or '' for none. */
function checkedUuidOrEmpty(id: string | null): string {
  if (id === null) return '';
  if (!UUID_RE.test(id)) throw new Error('create home: not a uuid');
  return id.toLowerCase();
}

/** A Postgres uuid[] literal from validated ids. */
function uuidArrayLiteral(ids: readonly string[], what: string): string {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`${what}: not a uuid: ${String(id).slice(0, 40)}`);
  }
  return `{${[...new Set(ids)].sort().join(',')}}`;
}

/**
 * Run `fn` in ONE workspace scope (workspaces W1, plan section 2.1): a short
 * transaction on the workspace role (`mantle_view_user`) that sets
 * `mantle.ws`, `mantle.mod_ws` and `mantle.login_id`; every `db` query inside
 * runs in it, so row security shows only what those workspaces hold (and a
 * per-login row only to its login). `modWs` must be a subset of `ws`.
 * Not nested in any other scope (fails loudly); keep it short, never across
 * an LLM call.
 */
export async function withScope<T>(scope: WorkspaceScope, fn: () => Promise<T>): Promise<T> {
  if (currentWorkspaceScope() || currentScopeTx() || currentSpaceScope()) {
    throw new Error('withScope: already inside a scope');
  }
  // The one scope check (scopeProblem), in withScope's own words; unlike a
  // turn, a request scope may read no workspace (an empty list reads nothing).
  const problem = scopeProblem(scope, 'withScope', { needsWorkspace: false });
  if (problem) throw new Error(problem);
  const ws = uuidArrayLiteral(scope.ws, 'withScope ws');
  const mod = uuidArrayLiteral(scope.modWs, 'withScope modWs');
  const frozen: WorkspaceScope = {
    kind: scope.kind,
    loginId: scope.loginId,
    ws: Object.freeze([...new Set(scope.ws)].sort()),
    modWs: Object.freeze([...new Set(scope.modWs)].sort()),
  };
  const hooks = newTxHooks();
  let result: T;
  try {
    result = await getViewerDb('user').transaction(async (tx) => {
      await tx.execute(
        sqlTag`select set_config('mantle.ws', ${ws}, true),
                      set_config('mantle.mod_ws', ${mod}, true),
                      set_config('mantle.login_id', ${scope.loginId ?? ''}, true)`,
      );
      return runInWorkspaceTx({ ws: frozen, tx, hooks }, fn);
    });
  } catch (err) {
    await runTxHooks(hooks.rollback, 'rollback');
    throw err;
  }
  await runTxHooks(hooks.commit, 'commit');
  return result;
}

/**
 * Run `fn` as an assistant TURN in one workspace scope (workspaces W4b, plan
 * 5.1): every `db` query inside, after any await, runs on the workspace role
 * (`mantle_view_user`) in its own short transaction that sets the scope, so
 * no transaction is held across an LLM call. Fails closed: a query built
 * here that runs after the turn ended (or from a callback that lost it) is
 * refused (ScopeLostError), never sent on the system pool. Nested in the
 * same scope it just runs `fn`;
 * inside any other scope it is refused. `modWs` must be a subset of `ws`.
 * Writes are not made here: they go through the system pool's own paths.
 */
export async function withTurnScope<T>(
  scope: WorkspaceScope,
  fn: () => Promise<T>,
  opts: { writes?: boolean } = {},
): Promise<T> {
  const problem = turnScopeProblem(scope);
  if (problem) throw new Error(problem);
  const frozen: WorkspaceScope = Object.freeze({
    kind: scope.kind,
    loginId: scope.loginId,
    ws: Object.freeze([...new Set(scope.ws)].sort()),
    modWs: Object.freeze([...new Set(scope.modWs)].sort()),
  });
  // An Admin turn (W7a, `writes`): the Admin assistant and the Admin MCP
  // surface write as an Admin user's mutating request does, on the system
  // pool with the turn's scope set on its transactions (the database's
  // move, create and delete checks), and read drafts as the editor does.
  return runInTurnScope(
    frozen,
    fn,
    opts.writes ? Object.freeze({ writes: true, drafts: true }) : undefined,
  );
}

/**
 * Why withTurnScope refuses `scope`, or null: a login id or a workspace id
 * that is not a uuid, no workspace at all, or a Moderator workspace the
 * scope does not read. The one check: withTurnScope throws it, and the gate
 * (gate.ts) asks it before it lists or calls, so listing equals calling.
 */
export function turnScopeProblem(scope: WorkspaceScope): string | null {
  return scopeProblem(scope, 'withTurnScope', { needsWorkspace: true });
}

/**
 * The one scope check, worded for the function that asks it (`prefix`):
 * withTurnScope (turnScopeProblem, and the gate through it) and withScope.
 * `needsWorkspace`: no workspace at all is a problem (a turn); a request
 * scope (withScope) may read none.
 */
function scopeProblem(
  scope: WorkspaceScope,
  prefix: 'withTurnScope' | 'withScope',
  opts: { needsWorkspace: boolean },
): string | null {
  if (scope.loginId !== null && !UUID_RE.test(scope.loginId)) {
    return `${prefix}: loginId must be a uuid`;
  }
  for (const [ids, what] of [
    [scope.ws, `${prefix} ws`],
    [scope.modWs, `${prefix} modWs`],
  ] as const) {
    for (const id of ids) {
      if (!UUID_RE.test(id)) return `${what}: not a uuid: ${String(id).slice(0, 40)}`;
    }
  }
  if (opts.needsWorkspace && scope.ws.length === 0) {
    return `${prefix}: a turn reads at least one workspace`;
  }
  const inWs = new Set(scope.ws);
  if (scope.modWs.some((id) => !inWs.has(id))) return `${prefix}: modWs must be a subset of ws`;
  return null;
}

/** The transaction handle `db.transaction` gives its callback. */
type ReadTx = Parameters<Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]>[0];

/**
 * A transaction that only READS (W7a): in a turn or request scope it runs
 * on the workspace role with the scope set, even where `db.transaction` is
 * a write (a mutating request, an Admin turn) and goes to the system pool.
 * A vector search's settings transaction (withHnswPool) uses it, so a scoped
 * search never reads past the scope. Anywhere else it is `db.transaction`.
 */
export function readTransaction<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

const holdsAdmin = new WeakMap<WorkspaceScope, Promise<boolean>>();

/**
 * Whether the current code may do Admin-workspace work (plan 5.4, adminOnly):
 * unscoped system work (the owner's paths, and the Admin assistant and the
 * Admin MCP surface under MANTLE_ADMIN_READS=system) yes; a workspace scope when it holds
 * the Admin workspace (asked of the database once per scope). Fails closed:
 * an error reads as no.
 */
export async function scopeHoldsAdmin(): Promise<boolean> {
  const scope = currentWorkspaceScope();
  if (!scope) return isUnscoped();
  let p = holdsAdmin.get(scope);
  if (!p) {
    p = (async () => {
      try {
        const rows = (await getDb().execute(
          sqlTag`select "public"."mantle_scope_is_admin"() as a`,
        )) as unknown as { a: boolean }[];
        return rows[0]?.a === true;
      } catch {
        return false;
      }
    })();
    holdsAdmin.set(scope, p);
  }
  return p;
}

/**
 * Whether the current code may do an "Admin only" thing in `area` (plan S2,
 * 2.4): system work may; a user scope may when it holds the Admin workspace,
 * its login is a user there and its limits leave the area on
 * (mantle_scope_has_area, the rule of areasFor); so may an assistant turn
 * that answers such a login (W7a: the Admin assistant, which answers the
 * owner when no login asks). A link and an assistant turn with no login
 * never may. An unknown kind or area is refused (fails
 * closed).
 */
export async function scopeHasArea(area: ScopeArea): Promise<boolean> {
  if (!SCOPE_AREAS.includes(area)) return false;
  const scope = currentScope();
  switch (scope.kind) {
    case 'system':
      return true;
    case 'user':
    case 'assistant': {
      if (!scope.loginId) return false;
      try {
        const rows = (await getDb().execute(
          sqlTag`select "public"."mantle_scope_has_area"(${area}) as a`,
        )) as unknown as { a: boolean }[];
        return rows[0]?.a === true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

/**
 * Whether `loginId` is a user of this brain's live Admin workspace now, its
 * login enabled (W7 integration fix 3, L1): what the rollback switch
 * (MANTLE_ADMIN_READS=system) asks before it puts a login's reads on the
 * system pool, never the admin role alone (a login taken out of Admin keeps
 * its role). A brain not on workspaces: yes (the role decides, as before).
 * Fails closed. Admin pool.
 */
export async function loginHoldsAdmin(loginId: string): Promise<boolean> {
  if (!UUID_RE.test(loginId)) return false;
  try {
    if (!(await brainOnWorkspacesNow())) return true;
    const rows = (await getAdminDb().execute(
      sqlTag`select exists (
               select 1 from workspaces w
                 join workspace_users u on u.workspace_id = w.id and u.login_id = ${loginId}::uuid
                 join auth.users l on l.id = u.login_id and l.disabled_at is null
                where w.owner_id = mantle_brain_id() and w.is_admin and w.archived_at is null) as a`,
    )) as unknown as { a: boolean }[];
    return rows[0]?.a === true;
  } catch {
    return false;
  }
}

/**
 * Whether login `loginId` holds Admin `area` now, asked on the system pool
 * for a login other than the current caller (W7a fix round 3: the maker of
 * an API tool, when the tool's secret refs resolve at run time). The rule
 * of mantle_scope_has_area and areasFor: a live login that is a user of the
 * brain's live Admin workspace whose limits leave the area on. A brain not
 * on workspaces keeps today's rule (any admin: yes). Fails closed.
 */
export async function loginHasArea(loginId: string, area: ScopeArea): Promise<boolean> {
  if (!SCOPE_AREAS.includes(area) || !UUID_RE.test(loginId)) return false;
  try {
    if (!(await brainOnWorkspacesNow())) return true;
    const rows = (await getAdminDb().execute(
      sqlTag`select exists (
               select 1 from workspaces w
                 join workspace_users u on u.workspace_id = w.id and u.login_id = ${loginId}::uuid
                 join auth.users l on l.id = u.login_id and l.disabled_at is null
                where w.owner_id = mantle_brain_id() and w.is_admin and w.archived_at is null
                  and coalesce(u.limits -> 'areas' ->> ${area}, '') <> 'false') as a`,
    )) as unknown as { a: boolean }[];
    return rows[0]?.a === true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` in ONE admin-pool transaction whose FIRST lock is the heads of
 * `ids` (workspaces plan U1 and V2): every writer of nodes, chunks, windows,
 * facts and grants goes through here, so no two writers can deadlock and none
 * can miss another's grant change. `update` for a change of grants, a move, a
 * delete or a chunk rewrite; `share` for a new item in a folder (lock the
 * folder). The database checks it (mantle.heads_check: off, warn, on).
 */
export async function withHeads<T>(
  ids: readonly string[],
  mode: 'update' | 'share',
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const list = uuidArrayLiteral(ids, 'withHeads');
  // Nested in a system transaction (arch A2b, plan 20.2): the database
  // decides (mantle_lock_heads_nested, 0277): more heads where it holds
  // some (FOR UPDATE NOWAIT; a busy one fails with 55P03 and the outermost
  // call retries), else the first lock with its rules. Never a second
  // first lock.
  const nested = currentSystemTx() !== null;
  return withSystemTx(async (tx) => {
    if (nested) await tx.execute(sqlTag`select mantle_lock_heads_nested(${list}::uuid[], ${mode})`);
    else await tx.execute(sqlTag`select mantle_lock_heads(${list}::uuid[], ${mode})`);
    return fn(tx);
  });
}

/**
 * withHeads for a whole subtree (plan U2, V1, V3): the heads of `root` and
 * everything under it (a folder), plus `extra` (a move's old and new
 * folder), locked FIRST; later rounds pick up rows that arrived while the
 * first round waited, without waiting. For a folder's grant change and for a
 * move. A busy later round fails with 55P03: wrap in withDeadlockRetry.
 */
export async function withSubtreeHeads<T>(
  root: string,
  extra: readonly string[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(root)) throw new Error('withSubtreeHeads: root must be a uuid');
  const list = uuidArrayLiteral(extra, 'withSubtreeHeads');
  return withSystemTx(async (tx) => {
    // A first lock: nested in a transaction that holds heads, the database
    // refuses it (55000, mantle_lock_heads); lock the subtree in the
    // outermost call (arch A2b, plan 20.2).
    await tx.execute(sqlTag`select mantle_lock_subtree_heads(${root}::uuid, ${list}::uuid[])`);
    return fn(tx);
  });
}

/** The open system transaction (it sees its own rows), else the system
 *  pool: where a heads helper reads which heads to take (arch A2b). */
function systemTxOrPool(): PostgresJsDatabase<typeof schema> {
  return (currentSystemTx()?.tx as PostgresJsDatabase<typeof schema> | undefined) ?? getAdminDb();
}

/** The folders `items` would sit in (an item's path is its folder's path; a
 *  folder's parent is one level up). Read on the admin pool BEFORE the
 *  transaction, so the heads can still be its first lock. */
export async function folderHeadIds(
  ownerId: string,
  items: readonly { type: string; path: string }[],
): Promise<string[]> {
  if (!UUID_RE.test(ownerId)) throw new Error('folderHeadIds: ownerId must be a uuid');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = `${it.type}\u0000${it.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = (await systemTxOrPool().execute(
      sqlTag`select mantle_parent_folder(${ownerId}::uuid, ${it.type}::node_type, ${it.path}::ltree) as id`,
    )) as unknown as { id: string | null }[];
    const id = rows[0]?.id;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Heads for creating nodes (plan U1): the folders they land in, SHARE (many
 * creators may add to one folder at once; a grant change on the folder
 * waits for them, or they for it).
 */
export async function withNodeInsertHeads<T>(
  ownerId: string,
  items: readonly { type: string; path: string }[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  return withHeads(await folderHeadIds(ownerId, items), 'share', fn);
}

/**
 * Heads for moving one node (a path change, plan V3): the node and, for a
 * folder, everything under it, plus its old folder and the folder at
 * `newPath`, in rounds until stable.
 */
export async function withNodeMoveHeads<T>(
  ownerId: string,
  node: { id: string; type: string; path: string },
  newPath: string,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const folders = await folderHeadIds(ownerId, [
    { type: node.type, path: node.path },
    { type: node.type, path: newPath },
  ]);
  return withSubtreeHeads(node.id, folders, fn);
}

/**
 * Heads for deleting nodes (plan V4): each node, everything under a folder,
 * and the folders they sit in, UPDATE. Read before the transaction.
 */
export async function withNodeDeleteHeads<T>(
  ids: readonly string[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const list = uuidArrayLiteral(ids, 'withNodeDeleteHeads');
  const rows = (await systemTxOrPool().execute(
    sqlTag`select distinct x.id from (
             select d.id from nodes n
               join nodes d on d.owner_id = n.owner_id
                and (d.id = n.id or (n.type = 'branch' and d.path <@ n.path))
              where n.id = any(${list}::uuid[])
             union
             select mantle_parent_folder(n.owner_id, n.type, n.path) from nodes n
              where n.id = any(${list}::uuid[])
           ) x where x.id is not null`,
  )) as unknown as { id: string }[];
  return withHeads(
    rows.map((r) => r.id),
    'update',
    fn,
  );
}

/**
 * Heads for a writer that also runs inside a member's personal space: in the
 * brain, `open` takes the heads and runs `fn` in its transaction; inside a
 * personal-space scope (rows outside any workspace grant, on the space
 * role, where heads cannot be taken) `fn` runs on the scope's own
 * transaction. That second path is removed with personal spaces in W6b
 * (workspaces plan); it is the one sanctioned exemption.
 */
export async function headsOrSpace<T>(
  open: (fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>) => Promise<T>,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (currentSpaceScope()) return fn(getDb());
  return open(fn);
}

/**
 * A write of rows the CURRENT personal space owns, on the space's own
 * transaction (withSpace). The space role cannot take heads, and it needs
 * none: the database exempts rows a personal space owns from the heads
 * check, because no workspace reads them (migration 0244 refuses a grant on
 * one). Throws outside a personal-space scope, so it cannot carry a brain
 * write. Removed with personal spaces in W6b (W4 replaces the exemption
 * before it grants personal items).
 */
export async function withSpaceRows<T>(
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (!currentSpaceScope()) {
    throw new Error('withSpaceRows: only inside a personal-space scope (withSpace)');
  }
  return fn(getDb());
}

/**
 * Rows that personal spaces own, written on `q` (an open transaction or the
 * pool) outside a space scope: an admin's purge, a takeover between two
 * spaces, a brain folder rename carried into the members' drafts. Checks
 * first that every id in `spaceIds` is a personal space. The database
 * exempts those rows from the heads check (0244) and still checks any brain
 * row, so a brain write slipped in here is caught there. Removed with
 * personal spaces in W6b.
 */
export async function onSpaceRows<
  Q extends { execute: PostgresJsDatabase<typeof schema>['execute'] },
  T,
>(q: Q, spaceIds: string | readonly string[], fn: (q: Q) => Promise<T>): Promise<T> {
  const ids = typeof spaceIds === 'string' ? [spaceIds] : [...new Set(spaceIds)];
  const list = uuidArrayLiteral(ids, 'onSpaceRows');
  const rows = (await q.execute(
    sqlTag`select count(*)::int as n from spaces
            where id = any(${list}::uuid[]) and kind = 'personal'`,
  )) as unknown as { n: number }[];
  if ((rows[0]?.n ?? 0) !== ids.length) {
    throw new Error('onSpaceRows: every id must be a personal space');
  }
  return fn(q);
}

/**
 * Heads for a writer that changes an item's level or what it embeds (a level
 * set, a save that adds or drops an embed): the item's head (`ids`, for
 * update) FIRST, so the level bridge (0251) finds its writer holding heads
 * and takes the rows that follow from the change (embeds, inherited levels)
 * itself without waiting. The whole transaction is retried when a head was
 * busy (55P03) or a deadlock was broken.
 *
 * Inside a personal-space scope (withSpace) `fn` runs on the space's own
 * transaction (headsOrSpace: no heads there, rule 1 of 0244). Inside an open
 * system transaction (withSystemTx, withHeads) it runs on that transaction:
 * its heads are already first, and the bridge locks the rest.
 */
export async function withWriterHeads<T>(
  ids: readonly string[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (currentSpaceScope() || currentScopeTx()) {
    // A savepoint of the open transaction, as db.transaction is there.
    return getDb().transaction((tx) => fn(tx as unknown as PostgresJsDatabase<typeof schema>));
  }
  return withDeadlockRetry(() => withHeads(ids, 'update', fn));
}

/**
 * Lock more heads later in a heads transaction (plan U2, V1): FOR UPDATE
 * NOWAIT, for rows found only after the first lock (a bundle, the folders an
 * Accept lands in). A busy head fails with 55P03: run the whole transaction
 * in withDeadlockRetry.
 */
export async function lockMoreHeads(
  tx: { execute: PostgresJsDatabase<typeof schema>['execute'] },
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const list = uuidArrayLiteral(ids, 'lockMoreHeads');
  await tx.execute(sqlTag`select mantle_lock_heads_more(${list}::uuid[])`);
}

/** SQLSTATEs a whole transaction may be retried for: a deadlock, a
 *  serialization failure (a head missing in 'on' mode, a growing subtree), a
 *  NOWAIT lock that was busy. */
const RETRYABLE = new Set(['40P01', '40001', '55P03']);

function sqlState(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Run a whole transaction again when it failed for a retryable reason
 * (plan V1: every retry is at the caller, never inside a function). `run`
 * must start its own transaction each time (withHeads, withScope,
 * withSystemTx), so nothing of a failed attempt survives.
 */
export async function withDeadlockRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  // Inside an open system transaction (arch A2b, plan 20.2) a retry cannot
  // start afresh: the error goes to the outermost call, which retries.
  if (currentSystemTx()) return run();
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const code = sqlState(err);
      if (attempt >= attempts || code === null || !RETRYABLE.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 15 * attempt + Math.random() * 40 * attempt));
    }
  }
}

/**
 * The R6 shim (plan R6, S2, T4): run `fn` for whoever `actsFor` names, in a
 * WORKSPACE scope. A login reads the union of its
 * live workspaces (a disabled login: none); an assistant reads its own
 * workspace (none when it sits on no workspace); a public link reads no
 * workspace and carries its served list. Every query inside, after any
 * await, runs on the workspace role in its own short transaction that sets
 * the scope (as a turn scope does), so a long request holds no transaction.
 * Fails closed: an empty scope reads nothing.
 *
 * System work never comes through here: a caller that may run as the
 * system runs `fn` itself (the level argument that said so went in W8c).
 * Inside the same workspace scope it just runs `fn`; inside another one it
 * is refused, unless it narrows a request scope.
 */
export async function withViewer<T>(actsFor: ViewerFor, fn: () => Promise<T>): Promise<T> {
  // Inside the request scope of this very login (W6a): that scope is the
  // one withViewer would build, read once by the session guard. No second
  // lookup per call (the W5b2 member search cost).
  const open = currentWorkspaceScope();
  if (
    'login' in actsFor &&
    !actsFor.app &&
    currentRequestMode() &&
    open?.kind === 'user' &&
    open.loginId === actsFor.login.toLowerCase()
  ) {
    return fn();
  }
  return runInViewerScope(await memoScopeFor(actsFor), fn);
}

/** viewerScopeFor, once per request for the same login (and app) or agent:
 *  workspace and membership changes take effect on the next request. */
function memoScopeFor(actsFor: ViewerFor): Promise<WorkspaceScope> {
  const memo = requestScopeMemo();
  const key =
    'login' in actsFor
      ? `login:${actsFor.login.toLowerCase()}:${actsFor.app ? JSON.stringify(actsFor.app) : ''}`
      : 'agent' in actsFor
        ? `agent:${actsFor.agent ?? ''}`
        : null;
  if (!memo || key === null) return viewerScopeFor(actsFor);
  let p = memo.get(key);
  if (!p) {
    p = viewerScopeFor(actsFor);
    // A failed lookup is not kept: the next call asks again.
    p.catch(() => memo.delete(key!));
    memo.set(key, p);
  }
  return p;
}

/**
 * The login's workspaces and Moderator ones, as SQL columns of a query on
 * auth.users (W6a fix round 1, the bench): the session's one login read
 * carries them, and seedLoginScope keeps them as this request's scope, so
 * the guard needs no second lookup. The same rule as viewerScopeFor: live
 * workspaces only, none for a disabled login. The login is a bound id, not
 * the outer column: drizzle writes a single-table query's columns without
 * their table, and a bare "id" in the subquery would be the workspace's.
 */
export function loginScopeColumns(loginId: string, disabledAt: AnyPgColumn) {
  return {
    scopeWs: sqlTag<string[]>`case when ${disabledAt} is null then coalesce((
        select array_agg(u.workspace_id::text order by u.workspace_id)
          from workspace_users u
          join workspaces w on w.id = u.workspace_id and w.archived_at is null
         where u.login_id = ${loginId}::uuid), '{}') else '{}' end`,
    scopeModWs: sqlTag<string[]>`case when ${disabledAt} is null then coalesce((
        select array_agg(u.workspace_id::text order by u.workspace_id)
          from workspace_users u
          join workspaces w on w.id = u.workspace_id and w.archived_at is null
         where u.login_id = ${loginId}::uuid and u.moderator), '{}') else '{}' end`,
  };
}

/** Keep a login's scope, read with its row (loginScopeColumns), as this
 *  request's: loginScopeFor and withViewer for that login reuse it. No-op
 *  outside a request, or when the request already looked it up. */
export function seedLoginScope(
  loginId: string,
  ws: readonly string[],
  modWs: readonly string[],
): void {
  const memo = requestScopeMemo();
  if (!memo || !UUID_RE.test(loginId)) return;
  const key = `login:${loginId.toLowerCase()}:`;
  if (memo.has(key)) return;
  memo.set(
    key,
    Promise.resolve(
      Object.freeze({
        kind: 'user' as const,
        loginId: loginId.toLowerCase(),
        ws: Object.freeze([...ws]),
        modWs: Object.freeze([...modWs]),
      }),
    ),
  );
}

/**
 * The scope the session guard enters for a signed-in login (W6a): the
 * union of its live workspaces, Moderator where it is one (a disabled
 * login: none). The same scope `withViewer({ login }, …)` builds.
 */
export async function loginScopeFor(loginId: string): Promise<WorkspaceScope> {
  return memoScopeFor({ login: loginId });
}

/**
 * The fallback of a login's create home (docs/workspaces.md, "Where a new
 * item lands"; W6b): for a login outside the Admin workspace (`ownWork`;
 * 'auto' asks the database) its private workspace, made now when
 * `makePrivate` and it has none; with no workspace to make one in,
 * refused. An Admin user has no private fallback (null): the folder's home,
 * else Admin. Only createHomeIntent (create-home.ts, the one create-home
 * intent of arch A3c) calls it; not exported from the package.
 *
 * Admin pool: it names a place, it grants nothing (the database's create
 * checks still run).
 */
export async function createHomeFallback(
  loginId: string,
  o: { ownWork: boolean | 'auto'; makePrivate: boolean },
): Promise<{ privateWs: string | null } | { refused: 'no-workspace'; message: string }> {
  const admin = getAdminDb();
  const ownWork =
    o.ownWork === 'auto'
      ? !(
          (await admin.execute(sqlTag`
            select 1 from workspace_users u
              join workspaces w on w.id = u.workspace_id and w.is_admin and w.archived_at is null
             where u.login_id = ${loginId}::uuid limit 1`)) as unknown as unknown[]
        ).length
      : o.ownWork;
  if (!ownWork) return { privateWs: null };
  if (!o.makePrivate) {
    const own = (await admin.execute(sqlTag`
      select p.workspace_id::text as ws from private_workspaces p
        join workspaces w on w.id = p.workspace_id and w.archived_at is null
       where p.login_id = ${loginId}::uuid`)) as unknown as { ws: string }[];
    return { privateWs: ownPrivate(loginId, own[0]?.ws ?? null) };
  }
  const rows = (await admin.execute(
    sqlTag`select "public"."mantle_ws_private_workspace"(${loginId}::uuid)::text as ws`,
  )) as unknown as { ws: string | null }[];
  const privateWs = ownPrivate(loginId, rows[0]?.ws ?? null);
  if (!privateWs) {
    return { refused: 'no-workspace', message: 'You have no workspace to create in yet.' };
  }
  return { privateWs };
}

/**
 * Each login's private workspace as createHomeFallback last read it on the
 * system pool (arch A2b2b): the login write gateway adds it to a write
 * scope that does not hold it yet (writeScopeWithPrivate). A login's scope
 * is read once per request or turn, often before its first create made the
 * private workspace, and the write role needs its Moderator seat in
 * mantle.mod_ws. Only a pair read here counts, never a create home's word
 * alone.
 *
 * Process-global and never cleared, on purpose (A2b2b fix round 1, L3): one
 * entry per login that made or read its private workspace in this process
 * (logins are few: a brain's people, never per request), each a pair of
 * ids. A stale pair grants nothing: it counts only when the write's own
 * create home, read afresh by createHomeFallback (which rewrites the pair),
 * names the same workspace, and the database still checks the create.
 */
const privateWorkspaces = new Map<string, string>();

/** Note the login's private workspace as read (see privateWorkspaces). */
function ownPrivate(loginId: string, ws: string | null): string | null {
  if (ws) privateWorkspaces.set(loginId.toLowerCase(), ws.toLowerCase());
  return ws;
}

/**
 * The scope a write runs in on the write role: `scope`, with the login's
 * own private workspace added (as a workspace and a Moderator one: it is
 * the login's alone, and it moderates it) when the write's create home
 * lands there and createHomeFallback read that pair. The scope refreshed
 * after the private workspace was made, with no query on the write's path.
 */
function writeScopeWithPrivate(scope: WorkspaceScope, home: CreateHome | null): WorkspaceScope {
  const priv = home?.privateWs?.toLowerCase();
  if (!priv || !scope.loginId) return scope;
  if (privateWorkspaces.get(scope.loginId.toLowerCase()) !== priv) return scope;
  if (scope.modWs.includes(priv) && scope.ws.includes(priv)) return scope;
  return {
    ...scope,
    ws: [...new Set([...scope.ws, priv])],
    modWs: [...new Set([...scope.modWs, priv])],
  };
}

let brainOnWorkspaces = false;

/**
 * Whether this brain is on workspaces: it has an Admin workspace (the
 * workspaces migration ran). A brain the migration skipped (a box with
 * client logins, set up by hand first, plan 21.9) keeps today's rule for an
 * Admin user: reads on the system pool, as before W6a. Read on the system
 * pool; a yes is kept for the life of the process (no box goes back).
 */
export async function brainOnWorkspacesNow(): Promise<boolean> {
  if (brainOnWorkspaces) return true;
  const rows = (await getAdminDb().execute(
    sqlTag`select exists (select 1 from workspaces
                           where owner_id = mantle_brain_id() and is_admin) as on`,
  )) as unknown as { on: boolean }[];
  brainOnWorkspaces = rows[0]?.on === true;
  return brainOnWorkspaces;
}

/** The live workspaces beyond Admin an app run reads through (AppRunFor):
 *  a brain app's holders from its grants. `{ team: true }`, an id that is
 *  not an app, and an app with no live holder beyond Admin read nothing
 *  (they read the built-in Team workspace until 0286 made it a normal one;
 *  no workspace stands in for "team rules" now). Admin pool. */
async function appRunHolders(app: AppRunFor): Promise<string[]> {
  if (!('id' in app)) return [];
  if (!UUID_RE.test(app.id)) throw new Error('withViewer: app must be a uuid');
  const [row] = (await getAdminDb().execute(
    sqlTag`select coalesce(array(
                    select w.id::text from workspaces w
                     where w.id = any(n.read_ws) and ${holderWorkspacesSql(sqlTag`array[w.id]`)}
                     order by w.id), '{}') as live
             from nodes n
            where n.id = ${app.id} and n.type = 'app'`,
  )) as unknown as { live: string[] }[];
  return row ? [...row.live] : [];
}

/** The scope `withViewer` enters for `actsFor`, read on the admin pool. */
export async function viewerScopeFor(actsFor: ViewerFor): Promise<WorkspaceScope> {
  const admin = getAdminDb();
  if ('login' in actsFor) {
    if (!UUID_RE.test(actsFor.login)) throw new Error('withViewer: login must be a uuid');
    const rows = (await admin.execute(
      sqlTag`select coalesce(array_agg(u.workspace_id::text order by u.workspace_id), '{}') as ws,
                    coalesce(array_agg(u.workspace_id::text order by u.workspace_id)
                             filter (where u.moderator), '{}') as mod
               from workspace_users u
               join workspaces w on w.id = u.workspace_id and w.archived_at is null
               join auth.users l on l.id = u.login_id and l.disabled_at is null
              where u.login_id = ${actsFor.login}`,
    )) as unknown as { ws: string[]; mod: string[] }[];
    let ws = rows[0]?.ws ?? [];
    let mod = rows[0]?.mod ?? [];
    if (actsFor.app) {
      // An app run (plan R2, H1): the holders beyond Admin, met with the
      // runner's workspaces; see AppRunFor.
      const held = await appRunHolders(actsFor.app);
      const holder = held.length === 1 ? held[0]! : null;
      ws = holder && ws.includes(holder) ? [holder] : [];
      mod = mod.filter((m) => ws.includes(m));
    }
    return Object.freeze({
      kind: 'user',
      loginId: actsFor.login.toLowerCase(),
      ws: Object.freeze([...ws]),
      modWs: Object.freeze([...mod]),
    });
  }
  if ('agent' in actsFor) {
    const none = Object.freeze({
      kind: 'assistant' as const,
      loginId: null,
      ws: Object.freeze([]),
      modWs: Object.freeze([]),
    });
    if (actsFor.agent === null) return none;
    if (!UUID_RE.test(actsFor.agent)) throw new Error('withViewer: agent must be a uuid');
    const rows = (await admin.execute(
      sqlTag`select a.workspace_id::text as ws from agents a
               join workspaces w on w.id = a.workspace_id and w.archived_at is null
              where a.id = ${actsFor.agent}`,
    )) as unknown as { ws: string }[];
    return Object.freeze({
      kind: 'assistant',
      loginId: null,
      ws: Object.freeze(rows[0]?.ws ? [rows[0].ws] : []),
      modWs: Object.freeze([]),
    });
  }
  const served = actsFor.link.served.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase());
  return Object.freeze({
    kind: 'link',
    loginId: null,
    ws: Object.freeze([]),
    modWs: Object.freeze([]),
    served: Object.freeze([...new Set(served)].sort()),
  });
}

/**
 * Content handle. A Proxy that defers initialisation until the first property
 * access, and picks the pool per access: inside a workspace scope it is the
 * workspace role's pool, so row level security applies.
 */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_t, prop) {
    if (STATEMENT_PROPS.has(prop)) checkActorBound(`db.${String(prop)}`);
    // A request scope (W6a, plan 2.3): writes stay on the system pool with
    // their rule in the statement; reads run in the scope. A transaction is
    // a write in a mutating request, and stays in the scope in a read
    // request (a search step that needs one transaction). A raw execute
    // always runs in the scope (fix round 1, M3): a raw write says so with
    // executeWrite.
    const mode = currentRequestMode();
    const write = prop === 'insert' || prop === 'update' || prop === 'delete';
    if (mode && !currentScopeTx()) {
      if (write || (prop === 'transaction' && mode.writes)) {
        noteRequestSystemWrite(String(prop));
        // Bound to the system handle (W6a fix round 2): drizzle's builders
        // read `this.session`, which on this proxy is the scope's session, so
        // an unbound method ran the write on the workspace role (a page's
        // block-id backfill failed with permission denied). The login write
        // gateway's handle when it may route (A2b2b): it sends a scoped
        // login write to the write role, anything else here as before.
        if (write) return typedWrite(prop, loginWritesMayRoute());
        const handle = systemWriteDb();
        const fn = Reflect.get(handle as object, prop) as (...args: unknown[]) => unknown;
        return fn.bind(handle);
      }
    }
    if (prop === 'select' || prop === 'selectDistinct' || prop === 'execute' || prop === 'query') {
      noteOwnRuleSystemRead(String(prop));
    }
    return Reflect.get(getDb() as object, prop);
  },
});

/**
 * Whether a raw statement writes (W6a): a leading write verb, or a write
 * clause anywhere (a data-modifying CTE, a row lock). No longer routes a
 * request scope's raw statements (fix round 1, M3: a read it took for a
 * write ran unscoped); executeWrite uses it to refuse a statement that does
 * not write.
 */
export function isWriteSql(text: string): boolean {
  const body = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  if (
    /^\s*\(?\s*(insert|update|delete|merge|truncate|lock|refresh|notify|call|do|create|alter|drop)\b/i.test(
      body,
    )
  ) {
    return true;
  }
  return /\b(insert\s+into|delete\s+from|update\s+[\w".]+\s+(as\s+\w+\s+)?set|for\s+(no\s+key\s+)?update|for\s+(key\s+)?share|pg_notify|pg_advisory_x?act_lock|pg_advisory_lock|nextval|setval)\b/i.test(
    body,
  );
}

/** The SQL text of a drizzle query or a string. */
function sqlTextOf(query: unknown): string {
  if (typeof query === 'string') return query;
  const admin = getAdminDb() as unknown as {
    dialect: { sqlToQuery: (q: unknown) => { sql: string } };
  };
  return admin.dialect.sqlToQuery(
    typeof (query as { getSQL?: unknown }).getSQL === 'function'
      ? (query as { getSQL: () => unknown }).getSQL()
      : query,
  ).sql;
}

/** A statement that only reads, sent to executeWrite. */
export class NotAWriteError extends Error {
  constructor() {
    super('executeWrite: the statement does not write; read through db in the caller’s scope.');
    this.name = 'NotAWriteError';
  }
}

/**
 * A raw WRITE, said so (W6a fix round 1, M3). Inside a request scope
 * `db.execute` always runs in the scope, on the workspace role, where a
 * write fails loudly; a raw statement that writes comes here and runs on
 * the system pool, as the typed writes (db.insert, update, delete) do there.
 * Anywhere else it is exactly `db.execute`. Refuses a statement that does
 * not write (isWriteSql), so it is never a door for a read.
 */
export function executeWrite(
  query: Parameters<PostgresJsDatabase<typeof schema>['execute']>[0],
): ReturnType<PostgresJsDatabase<typeof schema>['execute']> {
  if (!isWriteSql(sqlTextOf(query))) throw new NotAWriteError();
  if (currentRequestMode() && !currentScopeTx()) {
    noteRequestSystemWrite('executeWrite');
    return systemWriteDb().execute(query);
  }
  return getDb().execute(query);
}

/**
 * Infrastructure handle: always the admin pool, whatever the viewer. For the
 * writes a limited turn still needs (traces, trace steps, tool-result spills,
 * pending tool calls, share counters, access logs). NEVER for content reads:
 * that would read past row level security. Only an allowlisted set of
 * infrastructure modules may import it, and inside a turn scope only they
 * may use it (assertSystemDbCaller, workspaces W4b fix round 2).
 */
export const systemDb = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_t, prop) {
    if (STATEMENT_PROPS.has(prop)) checkActorBound(`systemDb.${String(prop)}`);
    if (inTurnScope() && systemDbAccessChecked(prop)) assertSystemDbCaller();
    return Reflect.get(getAdminDb() as object, prop);
  },
});

/**
 * Work the runtime role may not do (arch A9): the workspaces switch runs
 * DDL (mantle_ws_migrate_locked, at the first owner and at boot). With
 * MANTLE_DB_RUNTIME_ROLE on it runs on the migrator's URL (DATABASE_URL,
 * the role that runs the migrations) in one transaction of its own, with
 * the actor bound now, on a connection opened for it and closed after.
 * Off, it runs on `db` as before. Only the switch calls it: every other
 * statement of the app runs as the runtime role (runtime-role.ts).
 */
export async function executeAsMigrator<T extends Record<string, unknown>>(
  query: SQL,
): Promise<T[]> {
  if (!runtimeRoleOn()) {
    return [...((await db.execute(query)) as unknown as T[])];
  }
  checkActorBound('executeAsMigrator');
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  const { sql: text, params } = new PgDialect().sqlToQuery(query);
  const conn = postgres(url, { max: 1, prepare: false, onnotice: onPgNotice });
  try {
    const rows = await conn.begin(async (tx) => {
      const actor = actorParams();
      if (actor) await tx.unsafe(`${ACTOR_SQL_TAG} ${setActorSql(actor)}`);
      return [...(await tx.unsafe(text, params as never[]))];
    });
    return rows as unknown as T[];
  } finally {
    await conn.end({ timeout: 5 });
  }
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
  loginWriteDbCache = null;
  writeTxDbCache = null;
  // The next pool reads its database's actor check mode afresh.
  actorModePool = null;
  firstModeRead = null;
  forgetBoxActorCheckMode();
  // A detached write still on its reserved connection finishes first (the
  // pool is no longer globalThis.__mantleSql, so none starts now).
  while (actorPipelines.size > 0) await Promise.allSettled([...actorPipelines]);
  if (sql) await sql.end();
  if (viewers) await Promise.all([...viewers.values()].map((v) => v.sql.end()));
}

export type Db = PostgresJsDatabase<typeof schema>;
export { schema };
