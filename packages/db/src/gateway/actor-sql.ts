/**
 * The actor on the system pool's statements: the SET that names it, which
 * statements carry it (a write, or any statement of workspace system work),
 * and the client that sends it with a transaction's first statement or
 * pipelined around a write outside one. One owner for the pipelined writes
 * in flight.
 */
import type postgres from 'postgres';
import { reserveLease, type Lease, type ReserveWait } from '../reserved';
import { sqlCode } from '../sql-text';
import { UUID_RE } from '@mantle/std';
import {
  actorCheckMode,
  actorSetting,
  currentActor,
  fullRouteSpotNow,
  writeModeOf,
} from '../actor';
import {
  actingLoginAtSpot,
  actingLoginNow,
  isWorkspaceSystemActor,
  requestExitActingLogin,
} from '../viewer';
import { firstModeReadNow } from './check-mode';

type PgSql = ReturnType<typeof postgres>;

export type QueryMode = 'rows' | 'values' | 'simple';

/** A postgres.js-like pending query over `run`: sent once, on the first
 *  `then`, `values` or `simple` (drizzle awaits it or calls `.values()`). */
export function lazyQuery(run: (mode: QueryMode) => Promise<unknown>) {
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
export type QueryLike = PromiseLike<unknown> & { values(): unknown; simple(): unknown };

/** `q` in `mode`, sent now: its `.then` is called before this returns, so
 *  statements sent one after another go out in that order (postgres.js
 *  queues a query when its `.then` is called). */
export function sendIn(q: QueryLike, mode: QueryMode): Promise<unknown> {
  const m = (
    mode === 'values' ? q.values() : mode === 'simple' ? q.simple() : q
  ) as PromiseLike<unknown>;
  return new Promise<unknown>((resolve, reject) => {
    m.then(resolve, reject);
  });
}

/**
 * What a begin's work returned, as postgres.js reads it: an array (of
 * pending statements, `begin(t => [t\`...\`, t\`...\`])`) is sent and
 * awaited together, in its order, before the COMMIT, and the transaction
 * answers their results. A wrapper whose callback is async hides the array
 * from postgres.js (it sees a promise), so every gateway wrapper of begin
 * or of a savepoint reads its work's value here.
 */
export function workResult(value: unknown): unknown {
  return Array.isArray(value) ? Promise.all(value) : value;
}

/** The pipelined statements in flight (actorClient), for closeDb. */
const actorPipelines = new Set<Promise<unknown>>();

/** The actor of the transaction (packages/db only: the
 *  actor-setters-in-db-only lint). Plain set_config, as mantle_set_actor
 *  does without its checks: it works on every role and on a database
 *  before 0275 (an operator or a test role), and actor.ts already checked
 *  the value.
 *
 *  The values are inlined as quoted literals, not sent as parameters: with
 *  prepare off, postgres.js sends a statement that has
 *  parameters in two steps (describe, wait for the answer, then execute),
 *  and nothing queued behind it goes out until the first step is answered.
 *  A statement with no parameters goes out in one step, so the next one is
 *  sent with it: the SET adds no round trip.
 *
 *  Each value is checked against its shape first and refused otherwise
 *  (defence in depth for the inlined literals): actor.ts builds them,
 *  so a refusal here is a bug, never a caller's input. Exported for
 *  actor-client.test.ts only (not in index.ts). */
export function setActorSql(
  [actor, writeMode, mode, route, acting]: ActorParams,
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
  if (route !== undefined && route !== 'full') {
    throw new Error('actor setting: route');
  }
  if (acting !== undefined && !UUID_RE.test(acting)) throw new Error('actor setting: acting login');
  return (
    `select set_config('mantle.actor', ${lit(actor)}, ${local}), ` +
    `set_config('mantle.write_mode', ${lit(writeMode)}, ${local}), ` +
    `set_config('mantle.actor_check', ${lit(mode)}, ${local})` +
    (route ? `, set_config('mantle.route', ${lit(route)}, ${local})` : '') +
    (acting ? `, set_config('mantle.acting_login', ${lit(acting)}, ${local})` : '')
  );
}

/** The actor's settings (setActorSql): its value, write mode, the box's
 *  check mode, 'full' at a declared full-route spot (fullRouteSpotNow), and
 *  the acting login of the exit it runs in (actingLoginNow:
 *  mantle.acting_login, which only the gateway's own SET may name). */
export type ActorParams = readonly [
  string,
  string,
  string,
  ('full' | undefined)?,
  (string | undefined)?,
];

/** Takes back a session-level setActorSql(…, false): a real RESET, so each
 *  setting is the database's default again (the box mode for
 *  mantle.actor_check). Sent with the simple protocol (three statements). */
export const RESET_ACTOR_SQL =
  '/* mantle:actor */ reset mantle.actor; reset mantle.write_mode; reset mantle.actor_check';

/** RESET_ACTOR_SQL for a SET that also carried the full-route spot's
 *  setting or an acting login (resetActorSqlFor). */
export function resetActorSqlFor(params: ActorParams, tag = ''): string {
  return (
    (tag ? RESET_ACTOR_SQL.replace('/* mantle:actor */', tag) : RESET_ACTOR_SQL) +
    (params[3] ? '; reset mantle.route' : '') +
    (params[4] ? '; reset mantle.acting_login' : '')
  );
}

/** The shape of a mantle.actor value (actorSetting's output): no quote, no
 *  space, no NUL. Wider than mantle_set_actor's own pattern on purpose:
 *  that one names the kinds, this one only keeps the literal safe. */
const ACTOR_VALUE_RE = /^[a-z0-9:._/@-]{1,200}$/i;

/** Statements Postgres refuses inside a transaction block: they run as they
 *  are, with no actor set (DDL and maintenance; no item trigger fires). */
const NO_TX_SQL =
  /^(vacuum|cluster|checkpoint|discard\s+all|call|reindex\s+(\([^)]*\)\s*)?(database|schema|system)\b|reindex\b[^;]*\bconcurrently|(create|drop)\s+(unique\s+)?index\s+concurrently|(create|drop)\s+(database|tablespace)|alter\s+system)\b/i;

/** A SET statement but SET TRANSACTION, at the start of a statement's code. */
const LEADING_SET =
  /^set(?![A-Za-z0-9_$\u0080-\uffff])(?!\s*transaction(?![A-Za-z0-9_$\u0080-\uffff]))/i;

/** `query` without its leading comments and whitespace, and with
 *  `setsToo`, its leading SET statements (each ended by a `;`). Read on the
 *  text's code (sql-text.ts sqlCode, as Postgres's lexer reads it: nested
 *  block comments, a `--` comment a `\r` ends, a `;` in a string or a
 *  quoted name is no end), so what is cut is exactly what Postgres skips. */
export function statementBody(query: string, setsToo: boolean): string {
  const { code } = sqlCode(query);
  let at = 0;
  for (;;) {
    while (at < code.length && /\s/.test(code[at]!)) at += 1;
    if (!setsToo || !LEADING_SET.test(code.slice(at))) return query.slice(at);
    const end = code.indexOf(';', at);
    if (end < 0) return query.slice(at);
    at = end + 1;
  }
}

/**
 * Whether `query` must run outside a transaction block:
 * matched after its leading comments, whitespace and SET statements.
 */
export function runsOutsideTransaction(query: string): boolean {
  return NO_TX_SQL.test(statementBody(query, true));
}

/** A statement that only reads: SELECT, VALUES, TABLE, SHOW, an EXPLAIN
 *  without ANALYZE (or ANALYSE), and a WITH that names no write verb. */
const READ_VERB = /^(select|values|table|show)\b/i;
const EXPLAIN_NO_ANALYZE = /^explain\b(?![^;]*\banaly[sz]e\b)/i;
/** A write verb anywhere in a WITH: a false match only
 *  costs the wrap, a missed one would send a write with no actor. */
const WITH_WRITES = /\b(insert|update|delete|merge)\b/i;
/** A `;` with more text after it: more than one statement, unknown. */
const MORE_STATEMENTS = /;\s*\S/;

/**
 * Whether the system pool sends `query` with the actor set: writes only. INSERT, UPDATE, DELETE, MERGE, TRUNCATE,
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

/** A write (needsActorWrap), or any statement of workspace system work: its
 *  definers read mantle.actor, a bare call outside a transaction too. */
function wrapsStatement(query: string): boolean {
  return needsActorWrap(query) || isWorkspaceSystemActor(currentActor());
}

/** The mantle_set_actor parameters for the current actor, or null: no actor
 *  bound, or the check is off (then nothing changes). */
export function actorParams(): ActorParams | null {
  const mode = actorCheckMode();
  const actor = currentActor();
  if (!actor) return null;
  // Workspace system work sets its actor with the check off
  // too: the workspace definers read mantle.actor to know it
  // (mantle_ws_system_work, 0307), whatever the check's mode. Its mode goes
  // as 'off', the box's own, so no check reads it.
  // A request exit's system actor too: it carries the login it acts for,
  // which a definer acting for a login with no scope reads, whatever the
  // mode. And work at the acting-login spot: its definers refuse a missing
  // acting login (0322), and a turn's exit is no request exit, so with the
  // check off nothing else would send its acting login. So does work at the
  // login-credential spot on a narrow exit (the Admin membership definers
  // with no scope, 0330): its entry is the spot's, no request exit. Only
  // those two spots' statements gain the SET in off; every other path sends
  // exactly what it sent.
  if (
    mode === 'off' &&
    !isWorkspaceSystemActor(actor) &&
    requestExitActingLogin() === null &&
    actingLoginAtSpot() === null
  ) {
    return null;
  }
  const acting = actingLoginNow() ?? undefined;
  return [
    actorSetting(actor),
    writeModeOf(actor),
    mode,
    fullRouteSpotNow() ? 'full' : undefined,
    acting,
  ] as const;
}

/** SET TRANSACTION (drizzle's transaction config): Postgres takes it only
 *  as the transaction's first statement, so the actor follows it. */
const SET_TRANSACTION_SQL = /^\s*set\s+transaction\b/i;

/**
 * A transaction's client that sets the actor with its first statement:
 * after a SET TRANSACTION (drizzle's isolation level, access
 * mode, deferrable), which Postgres refuses after any query. Covers
 * drizzle's path (`unsafe`), a savepoint opened first, and a tagged-template
 * statement (which then returns a plain promise).
 *
 * The SET is sent unawaited, right before that first statement, on the
 * transaction's one connection: postgres.js sends both in one write, so
 * warn adds no round trip to a transaction. A SET that fails is the error reported, not the
 * statement's follow-on "current transaction is aborted". Exported for
 * actor-client.test.ts only (not in index.ts).
 */
export function actorInTransaction(t: PgSql, params: ActorParams): PgSql {
  return settingsFirst(t, () => setActorSql(params));
}

/**
 * A transaction's client that sends `setSql()` (a statement with no
 * parameters that only sets transaction-local settings) unawaited, right
 * before its first statement: actorInTransaction's actor, and the write
 * role's scope and actor (the login write gateway). See
 * actorInTransaction.
 */
export function settingsFirst(t: PgSql, setSql: () => string): PgSql {
  /** The SET's outcome once sent: null, or its error. Never rejects. */
  let set: Promise<unknown> | null = null;
  /** The SET answered without an error: later statements run plain. Until
   *  then each one waits for the SET's answer too, so a statement sent in
   *  parallel with the first reports the SET's own error, not the follow-on
   *  "current transaction is aborted". */
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
      // Sent when awaited, as postgres.js sends its own (never when built):
      // the order statements are awaited in is the order on the wire.
      return lazy(call);
    },
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: unknown) => {
          if (setOk) return target.unsafe(query, args as never[], opts as never);
          if (!set && SET_TRANSACTION_SQL.test(query)) {
            return target.unsafe(query, args as never[], opts as never);
          }
          const q = () => target.unsafe(query, args as never[], opts as never);
          // `.values()` and `.simple()` pick a mode and send nothing, as
          // postgres.js's own: a statement goes out when it is awaited, so
          // the order statements are awaited in is the order on the wire
          // (a SET TRANSACTION awaited first stays first).
          return Object.assign(lazy(q), {
            values: () => lazy(() => q().values()),
            simple: () => lazy(() => q().simple()),
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
 * One statement outside a transaction with session settings around it: the
 * one pipeline of the system pool's actor client (a write as the actor)
 * and of the narrow login pool (every narrow statement with an actor,
 * narrow-route.ts). On one reserved connection of `pool`: `setSql()` (a
 * session-level SET with no parameters, so it goes out in the statement's
 * first send), the statement, and `resetSql` behind it, pipelined: one
 * round trip, no BEGIN and no COMMIT (the statement commits by itself).
 *
 * One failure answer, on both:
 *  - the statement ran: its own result, whatever the SET did. A SET that
 *    failed beside a statement that ran is not the caller's error (the
 *    statement committed, and a retry would run it twice): the statement
 *    ran with none of the settings, so the database met it as a statement
 *    with no actor (the actor check refuses a content write in on and logs
 *    a miss in warn; on the narrow login the role's rights hold whatever
 *    the settings), and the connection ends;
 *  - the statement failed: the SET's error when the SET failed too (it is
 *    the cause), else the statement's own;
 *  - nothing sent (`setSql` threw: a value it refuses, before any
 *    connection is taken; or no connection): that error.
 *
 * The reserve waits as `wait` says (reserved.ts reserveLease: the system
 * pool's long wait unless the caller names the narrow pool's).
 *
 * The caller has its answer before the RESET is answered. The connection
 * goes back to the pool only once the RESET has answered, so no other
 * statement ever sees these settings; one whose SET or RESET failed ends
 * instead (lease.end: never handed back, nothing sent if it died). closeDb
 * waits for the whole pipeline (actorPipelinesDone): postgres.js never
 * finishes ending a pool whose reserved connection comes back late.
 */
export function settingsPipeline(
  pool: PgSql,
  setSql: () => string,
  query: string,
  args: unknown[] | undefined,
  mode: QueryMode,
  resetSql: string,
  wait: ReserveWait = {},
): Promise<unknown> {
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
  const life = (async () => {
    let set: string;
    let lease: Lease;
    try {
      set = setSql();
      lease = await reserveLease(pool, wait);
    } catch (err) {
      answer(Promise.reject(err));
      return;
    }
    // True once the SET is built: postgres.js sends it a moment later.
    // Ending a connection the SET never reached errs on the safe side.
    let sent = false;
    try {
      const conn = lease.sql;
      const setDone = lease.watch(conn.unsafe(set)).then(
        () => null,
        (err: unknown) => ({ err }),
      );
      sent = true;
      const q = conn.unsafe(query, (args ?? []) as never[]);
      const main = lease.watch(mode === 'values' ? q.values() : mode === 'simple' ? q.simple() : q);
      const reset = lease.watch(conn.unsafe(resetSql).simple());
      answer(
        Promise.allSettled([setDone, main]).then(([, m]) => {
          if (m.status === 'fulfilled') return m.value;
          return setDone.then((setErr) => {
            throw setErr ? setErr.err : m.reason;
          });
        }),
      );
      await reset;
      // A SET that failed: the connection may hold part of the settings.
      if (await setDone) await lease.end();
    } catch (err) {
      // Anything that throws here (a failed RESET, or a throw while the
      // statements are built) fails the caller if it has no answer yet,
      // and a connection that may hold the settings ends.
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
}

/**
 * The system pool's postgres.js client with the actor:
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
    if (params && !runsOutsideTransaction(query) && wrapsStatement(query)) {
      // A write outside a transaction, as the actor: the
      // caller waits exactly as long as with the check off.
      return settingsPipeline(
        base,
        () => setActorSql(params, false),
        query,
        args,
        mode,
        resetActorSqlFor(params),
      );
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
          const waitFor = firstModeReadNow();
          const wait = !actorParams() && waitFor !== null && currentActor() !== null;
          if (
            (!wait && !actorParams()) ||
            runsOutsideTransaction(query) ||
            !wrapsStatement(query)
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
            const waitFor = firstModeReadNow();
            if (waitFor && currentActor() && !actorParams()) await waitFor;
            const params = actorParams();
            return workResult(fn(params ? actorInTransaction(t, params) : t));
          };
          return (target.begin as (...a: unknown[]) => unknown)(...args.slice(0, -1), wrapped);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** closeDb: a detached write still on its reserved connection finishes
 *  first. */
/** Keep `work` until it settles, so closeDb waits for it (actorPipelinesDone):
 *  the narrow route's statements and transactions hold a connection of the
 *  system pool too (gateway/narrow-route.ts), and a pool whose connection
 *  comes back after its end began never finishes ending. */
export function trackPipeline<T>(work: Promise<T>): Promise<T> {
  actorPipelines.add(work);
  const done = () => actorPipelines.delete(work);
  work.then(done, done);
  return work;
}

export async function actorPipelinesDone(): Promise<void> {
  while (actorPipelines.size > 0) await Promise.allSettled([...actorPipelines]);
}
