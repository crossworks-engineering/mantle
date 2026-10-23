/**
 * The narrow system route (plan v3.2 section 2.1 point 3): a statement or
 * a transaction of a reason routed 'narrow' runs as mantle_system_narrow.
 *
 * Since S7b on the route's own pool, whose connections log in as the
 * narrow role (gateway/pools.ts narrowPoolSql): the role is the session's
 * own, a member of nothing, so no statement can leave it (a reset or a
 * role change lands on the narrow role again). A statement outside a
 * transaction carries the actor as a session-level SET pipelined with it
 * and a RESET behind it (no BEGIN, no COMMIT); a transaction sets the
 * actor with its first statement, and the hold check runs before its
 * COMMIT. Where the role has no login (per-database mode, narrowPoolSql
 * null) the route takes the role per transaction on the system pool, as
 * S7a built it: set_config('role', ..., true) with the actor's settings
 * (never a session SET), the hold check before the COMMIT.
 *
 * The text check (narrow-sendable.ts) runs on both: on the login pool it
 * guards against mistakes (a session setting, a gateway setting, a call
 * whose effect outlives the transaction), never the boundary itself.
 */
import type postgres from 'postgres';
import { env } from '@mantle/config';
import { RuntimeFaultError } from '@mantle/std';
import { permissionGapOf, pgErrorCode } from '../pg-error';
import {
  actorCheckMode,
  actorSetting,
  currentActor,
  noteActorMiss,
  noteNarrowWouldRefuse,
  noteTestNarrowDenial,
  noteTestNarrowUse,
  writeModeOf,
} from '../actor';
import { reserveLease } from '../reserved';
import { NARROW_LOGIN_FIX, NARROW_ROLE } from '../runtime-role';
import { actingLoginNow } from '../viewer';
import { ACTOR_SQL_TAG, NARROW_SQL_TAG, firstModeReadNow } from './check-mode';
import { sqlCode } from '../sql-text';
import { narrowSendable } from './narrow-sendable';
import {
  lazyQuery,
  resetActorSqlFor,
  sendIn,
  setActorSql,
  settingsFirst,
  settingsPipeline,
  trackPipeline,
  workResult,
  type ActorParams,
  type QueryMode,
} from './actor-sql';

type PgSql = ReturnType<typeof postgres>;

/**
 * The hold check, sent before the narrow route's COMMIT (narrowHeld): it
 * fails (division by zero) when the transaction is no longer the narrow
 * role's (a statement set the role back), so the transaction rolls back
 * whole and the caller gets NarrowRoleLeftError. Never sent on another
 * route.
 */
function narrowHeld(t: PgSql) {
  return t.unsafe(
    `${NARROW_SQL_TAG} select 1 / (current_user = '${NARROW_ROLE}')::int as narrow_held`,
  );
}

/** The narrow route's transaction was no longer the narrow role's when it
 *  ended: it rolled back. A bug of the statement, never a caller's input. */
export class NarrowRoleLeftError extends RuntimeFaultError {
  constructor() {
    super(
      'narrow system route: a statement left mantle_system_narrow before COMMIT; the transaction rolled back',
    );
    this.name = 'NarrowRoleLeftError';
  }
}

/**
 * The actor's settings on the narrow route: set whatever the check's mode,
 * so the database always knows who wrote (the actor stays system:<reason>),
 * its write mode (a read-only caller's definers refuse) and the acting
 * login of the exit (actingLoginNow: mantle.acting_login, plan v3.2 S7b). Null
 * with no actor bound.
 */
async function narrowParams(): Promise<ActorParams | null> {
  const waitFor = firstModeReadNow();
  if (waitFor) await waitFor;
  const actor = currentActor();
  if (!actor) return null;
  const acting = actingLoginNow() ?? undefined;
  return [actorSetting(actor), writeModeOf(actor), actorCheckMode(), undefined, acting];
}

/**
 * The one SET of a narrow transaction (never a session SET): the actor's
 * settings (narrowParams), and on the system pool (`takeRole`) the role,
 * transaction-local. Inlined, checked literals (setActorSql). Null: nothing
 * to set (the login pool, no actor).
 */
async function narrowSettingsSql(takeRole: boolean): Promise<string | null> {
  const params = await narrowParams();
  const role = `set_config('role', '${NARROW_ROLE}', true)`;
  if (!params) return takeRole ? `${NARROW_SQL_TAG} select ${role}` : null;
  return `${NARROW_SQL_TAG} ${setActorSql(params)}${takeRole ? `, ${role}` : ''}`;
}

/**
 * A right the narrow role does not hold, met on the narrow route: noted
 * every time, a caught one too (the measurement: route the reason full with
 * its why, or grant narrowly). Tests record it (vitest.setup.ts fails the
 * test, as on a write-role gap); elsewhere it is a miss row (check
 * 'narrow-denied'). The caller's error stays its error.
 */
function noteNarrowDenial(err: unknown): void {
  const what = permissionGapOf(err);
  if (!what) return;
  // Once per error: a statement's denial is noted where it is met, not
  // again as the savepoint's or the transaction's error (the same error, or
  // a wrapper whose cause it is).
  const chain: object[] = [];
  for (let e: unknown = err, i = 0; typeof e === 'object' && e !== null && i < 5; i++) {
    if (notedDenials.has(e)) return;
    chain.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  for (const e of chain) notedDenials.add(e);
  const actor = currentActor();
  const who = actor ? actorSetting(actor) : 'none';
  if (env('NODE_ENV') === 'test') {
    // The refused statement's text too (postgres.js puts it on its error),
    // so the measurement names the writer.
    noteTestNarrowDenial(who, `${what.slice(0, 200)} | ${refusedQueryOf(err)}`);
    return;
  }
  noteActorMiss({ source: 'ts', check: 'narrow-denied', actor: who, detail: what.slice(0, 200) });
}

/** The denials already noted (noteNarrowDenial). */
const notedDenials = new WeakSet<object>();

/** Tests only: the start of the refused statement's text, from the
 *  driver's error or the one it is the cause of. */
function refusedQueryOf(err: unknown): string {
  type Carried = { query?: unknown; parameters?: unknown; cause?: unknown };
  for (let e = err as Carried | undefined, i = 0; e && i < 4; i++) {
    if (typeof e.query === 'string') {
      const params = Array.isArray(e.parameters)
        ? e.parameters.slice(0, 6).map((v) => String(v).slice(0, 40))
        : [];
      return `${e.query.replace(/\s+/g, ' ').slice(0, 240)} [${params.join(', ')}]`;
    }
    e = e.cause as typeof e;
  }
  return '?';
}

/** A call of a function by name in a statement's text (literals blanked). */
const CALLED_FN = /\b(?:"?public"?\s*\.\s*)?"?(mantle_[a-z0-9_]+)"?\s*\(/gi;

/** Tests only: count the mantle_* functions a narrow statement calls by
 *  name, as uses `fn:<name>` (the measurement of the role's EXECUTE). A
 *  function a trigger or a definer calls needs no EXECUTE of the role. */
function noteNarrowFunctions(query: string): void {
  if (env('NODE_ENV') !== 'test') return;
  // Read on the code, where a quoted name keeps its name characters: the
  // app names its definers "public"."mantle_x".
  for (const m of sqlCode(query).code.matchAll(CALLED_FN)) {
    noteTestNarrowUse(`fn:${m[1]!.toLowerCase()}`);
  }
}

/** Which mantle_* functions the narrow role may EXECUTE, by name, read
 *  from the catalog (its grants and PUBLIC's), and when. */
let narrowExec: { at: number; can: ReadonlyMap<string, boolean> } | null = null;
let narrowExecLoad: Promise<ReadonlyMap<string, boolean>> | null = null;
/** How long the catalog's answer is kept (a migrate changes it). */
const NARROW_EXEC_TTL_MS = 10 * 60_000;

/** The catalog's answer, loaded once per TTL on the system pool (no
 *  actor: a catalog read). Empty when the role is not there. */
function narrowExecutable(base: PgSql): Promise<ReadonlyMap<string, boolean>> {
  if (narrowExec && Date.now() - narrowExec.at < NARROW_EXEC_TTL_MS) {
    return Promise.resolve(narrowExec.can);
  }
  narrowExecLoad ??= (async () => {
    try {
      const rows = (await base.unsafe(
        `select p.proname::text as name,
                bool_or(has_function_privilege('${NARROW_ROLE}', p.oid, 'EXECUTE')) as ok
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like 'mantle\\_%'
          group by 1`,
      )) as unknown as { name: string; ok: boolean }[];
      const can = new Map(rows.map((r) => [r.name, r.ok] as const));
      narrowExec = { at: Date.now(), can };
      return can;
    } catch {
      return new Map<string, boolean>();
    } finally {
      narrowExecLoad = null;
    }
  })();
  return narrowExecLoad;
}

/**
 * A statement the narrow route would take, sent off it (the switch off):
 * each mantle_* function it calls by name that the narrow role may not
 * EXECUTE is noted as narrow-would-refuse `fn:<name> EXECUTE`, beside the
 * database's own count of refused writes (0319). Read on the code (the
 * literals blanked), as the switch-on measurement reads it. Never holds
 * the statement back.
 */
function noteWouldRefuseCalls(base: PgSql, query: string): void {
  if (!/mantle_/i.test(query)) return;
  const names = new Set<string>();
  for (const m of sqlCode(query).code.matchAll(CALLED_FN)) names.add(m[1]!.toLowerCase());
  if (names.size === 0) return;
  const actor = currentActor();
  const who = actor ? actorSetting(actor) : 'none';
  void narrowExecutable(base).then((can) => {
    for (const name of names) {
      if (can.get(name) === false) noteNarrowWouldRefuse(who, `fn:${name} EXECUTE`);
    }
  });
}

/** A transaction's client whose statements are read by noteWouldRefuseCalls
 *  (the switch off, on a route that would be narrow), savepoints included. */
function wouldRefuseTx(tx: PgSql, base: PgSql): PgSql {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: unknown) => {
          noteWouldRefuseCalls(base, query);
          return target.unsafe(query, args as never[], opts as never);
        };
      }
      if (prop === 'savepoint') {
        const savepoint = (target as unknown as { savepoint: (...a: unknown[]) => unknown })
          .savepoint;
        return (...args: unknown[]) => {
          const last = args[args.length - 1];
          if (typeof last !== 'function') return savepoint.apply(target, args);
          const inner = last as (t: PgSql) => unknown;
          return savepoint.call(
            target,
            ...args.slice(0, -1),
            (t: PgSql) => inner(wouldRefuseTx(t, base)),
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Tests only: count a statement or transaction sent on the narrow route,
 *  by actor (the measurement's per-reason use). */
function noteNarrowUse(): void {
  if (env('NODE_ENV') !== 'test') return;
  const actor = currentActor();
  noteTestNarrowUse(actor ? actorSetting(actor) : 'none');
}

/**
 * One statement outside a transaction on the narrow route: BEGIN, the SET
 * (narrowSettingsSql), the statement, the hold check (narrowHeld) and
 * COMMIT, pipelined on one reserved connection of the system pool (one
 * round trip). A failing statement aborts the transaction, the COMMIT then
 * rolls back, and the first error is thrown.
 */
export async function narrowStatement(
  base: PgSql,
  query: string,
  args: unknown[] | undefined,
  mode: QueryMode,
  pool: PgSql | null = null,
): Promise<unknown> {
  narrowSendable(query);
  noteNarrowUse();
  noteNarrowFunctions(query);
  if (pool) {
    await systemStartup(base);
    return narrowLoginStatement(pool, query, args, mode);
  }
  const setSql = (await narrowSettingsSql(true))!;
  const lease = await reserveLease(base);
  try {
    const conn = lease.sql;
    const sent: Promise<unknown>[] = [];
    const send = (q: Parameters<typeof sendIn>[0], m: QueryMode) => {
      sent.push(lease.watch(sendIn(q, m)));
    };
    try {
      send(conn.unsafe(`${NARROW_SQL_TAG} begin`), 'rows');
      send(conn.unsafe(setSql), 'rows');
      send(conn.unsafe(query, (args ?? []) as never[]), mode);
      send(narrowHeld(conn), 'rows');
      send(conn.unsafe(`${NARROW_SQL_TAG} commit`), 'rows');
    } catch (err) {
      // A statement that threw while the pipeline was built: what was sent
      // settles (never an unhandled rejection), and the connection, which
      // may hold the open transaction, ends instead of going back.
      await Promise.allSettled(sent);
      if (sent.length > 0) await lease.end();
      throw err;
    }
    const out = await Promise.allSettled(sent);
    const failed = out.findIndex((r) => r.status === 'rejected');
    if (failed >= 0) {
      const err = (out[failed] as PromiseRejectedResult).reason;
      // Only the hold check's own refusal (division by zero) means the role
      // was left; any other error is the caller's, as it is.
      if (failed === 3 && pgErrorCode(err) === HOLD_FAILED) throw new NarrowRoleLeftError();
      noteNarrowDenial(err);
      throw err;
    }
    return (out[2] as PromiseFulfilledResult<unknown>).value;
  } finally {
    lease.release();
  }
}

/** The system pool's session-start settings, once read (systemStartup). */
const systemStartups = new WeakMap<object, Readonly<Record<string, string>>>();
/** A read of them, while one is out. */
const systemStartupReads = new WeakMap<object, Promise<void>>();

/** The settings systemStartup reads: the ones the narrow pool takes from
 *  the system pool (pools.ts NARROW_STARTUP_FROM_SYSTEM) and the server's
 *  version. Kept here, beside the read, as the names pg_settings uses. */
const SYSTEM_STARTUP_NAMES = [
  'TimeZone',
  'DateStyle',
  'IntervalStyle',
  'timezone_abbreviations',
  'standard_conforming_strings',
  'server_version',
];

/** What systemStartup read for `base`, or undefined before (pools.ts
 *  newNarrowPool reads it at each narrow connect). */
export function systemStartupOf(base: object): Readonly<Record<string, string>> | undefined {
  return systemStartups.get(base);
}

/**
 * Before the first narrow connect of a process: the narrow pool's startup
 * parameters take the system pool's session-start settings and its
 * server's version (pools.ts narrowStartup). Read once per system pool,
 * then kept: `reset_val` of pg_settings, the value a session of the system
 * pool starts with (the server's, the database's and the role's settings
 * and the pool's own startup), never one a session or a transaction of it
 * SET since (postgres.js's reported parameters follow every SET of any
 * connection of the pool). Null (no wait, no round trip) once read.
 *
 * A read that fails fails the narrow statement (fail closed): no narrow
 * connect without its pins. The next narrow statement reads again.
 */
export function systemStartup(base: PgSql): Promise<void> | null {
  if (systemStartups.has(base)) return null;
  let read = systemStartupReads.get(base);
  if (!read) {
    read = Promise.resolve(
      base.unsafe(
        `${ACTOR_SQL_TAG} select name, reset_val from pg_catalog.pg_settings where name = any($1::text[])`,
        [SYSTEM_STARTUP_NAMES] as never[],
      ),
    ).then(
      (rows) => {
        const got = Object.fromEntries(
          (rows as unknown as { name: string; reset_val: string }[]).map((r) => [
            r.name,
            r.reset_val,
          ]),
        );
        for (const name of SYSTEM_STARTUP_NAMES) {
          if (!got[name]) throw new NarrowStartupError(new Error(`${name} not read`));
        }
        systemStartups.set(base, Object.freeze(got));
      },
      (err: unknown) => {
        throw new NarrowStartupError(err);
      },
    );
    systemStartupReads.set(base, read);
    const done = () => systemStartupReads.delete(base);
    read.then(done, done);
  }
  return read;
}

/** The system pool's session-start settings could not be read: the narrow
 *  statement fails closed (no narrow connect without its pins). */
export class NarrowStartupError extends RuntimeFaultError {
  constructor(cause: unknown) {
    super("narrow system route: the system pool's session settings could not be read", {
      cause,
    });
    this.name = 'NarrowStartupError';
  }
}

/** The hold check's refusal: division by zero (narrowHeld). */
const HOLD_FAILED = '22012';

/**
 * One statement outside a transaction on the narrow route's own pool
 * (plan v3.2 S7b): the session is the narrow role's, so no BEGIN, no role
 * SET, no hold check and no COMMIT. With an actor bound, the actor
 * client's own pipeline (actor-sql.ts settingsPipeline: a session-level
 * SET of its settings, the statement and a RESET of them on one reserved
 * connection, one round trip, the caller answered before the RESET, one
 * failure answer for both pools). With no actor, the statement alone.
 */
async function narrowLoginStatement(
  pool: PgSql,
  query: string,
  args: unknown[] | undefined,
  mode: QueryMode,
): Promise<unknown> {
  const params = await narrowParams();
  try {
    if (!params) return await sendIn(pool.unsafe(query, (args ?? []) as never[]), mode);
    return await settingsPipeline(
      pool,
      () => `${NARROW_SQL_TAG} ${setActorSql(params, false)}`,
      query,
      args,
      mode,
      resetActorSqlFor(params, NARROW_SQL_TAG),
      // The narrow pool's own wait (reserved.ts NARROW_RESERVE_WAIT_MS).
      { pool: 'narrow' },
    );
  } catch (err) {
    noteNarrowDenial(err);
    throw narrowLoginError(err);
  }
}

/** The server's refusal of a login: the role may not log in (28000), or
 *  the password is not its own (28P01). */
const LOGIN_REFUSED = new Set(['28000', '28P01']);

/** The narrow pool could not log in as the narrow role: migrate did not
 *  give it its login (or its derived password) while the app has the
 *  switch on. The statement fails closed; the message names the fix. */
export class NarrowLoginError extends RuntimeFaultError {
  constructor(cause: unknown) {
    super(
      `narrow system route: the pool cannot log in as ${NARROW_ROLE} (${pgErrorCode(cause)}): ${NARROW_LOGIN_FIX}`,
      { cause },
    );
    this.name = 'NarrowLoginError';
  }
}

/** `err`, or NarrowLoginError when it is the server's refusal of the
 *  narrow pool's login. */
function narrowLoginError(err: unknown): unknown {
  const code = pgErrorCode(err);
  return code && LOGIN_REFUSED.has(code) ? new NarrowLoginError(err) : err;
}

/** One statement's query object, kept lazy (a postgres.js query runs when
 *  it is awaited, in the mode `.values()` or `.simple()` picked), with its
 *  error seen by `onError` first. */
type QueryLike = PromiseLike<unknown> & {
  values?: () => PromiseLike<unknown>;
  simple?: () => PromiseLike<unknown>;
};

/**
 * `q` with its error seen by `onError`, sent exactly when postgres.js would
 * send it: on the first `then` (or `catch`, `finally`), whose call reaches
 * the query's own `then` at once (no promise in between that would start
 * it a microtask late), and never on `.values()` or `.simple()` alone. So
 * the order a narrow transaction's statements are awaited in is the order
 * they go out, on this route as on every other (a SET TRANSACTION awaited
 * first is the transaction's first statement).
 */
function watchedQuery(q: QueryLike, onError: (err: unknown) => void) {
  const watched = (start: () => PromiseLike<unknown>) => {
    let started: Promise<unknown> | null = null;
    const once = () =>
      (started ??= new Promise<unknown>((resolve, reject) => {
        start().then(resolve, (err: unknown) => {
          onError(err);
          reject(err);
        });
      }));
    return {
      then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => once().then(ok, bad),
      catch: (bad?: (e: unknown) => unknown) => once().catch(bad),
      finally: (f?: () => void) => once().finally(f),
    };
  };
  return Object.assign(
    watched(() => q),
    {
      values: () => watched(() => (q.values ? q.values() : q)),
      simple: () => watched(() => (q.simple ? q.simple() : q)),
    },
  );
}

/**
 * A narrow transaction's client: every statement it sends (drizzle's
 * `unsafe`, a tagged template, and those of a savepoint's handle) is
 * refused first when the narrow route never sends it (narrowSendable), and
 * the error of each `unsafe` statement and savepoint is seen by `onError`
 * (a denial a savepoint caught is still noted). A tagged template's result
 * stays postgres.js's own (it may be a fragment of another statement), so
 * its error is seen only when it ends the transaction.
 */
function narrowTxClient(t: PgSql, onError: (err: unknown) => void): PgSql {
  return new Proxy(t, {
    apply(target, thisArg, args: unknown[]) {
      const first = args[0] as { raw?: unknown } | undefined;
      if (Array.isArray(first) && 'raw' in first) {
        const text = (first as string[]).join('$1');
        narrowSendable(text, true);
        noteNarrowFunctions(text);
      }
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: unknown) => {
          narrowSendable(query);
          noteNarrowFunctions(query);
          return watchedQuery(target.unsafe(query, args as never[], opts as never), onError);
        };
      }
      if (prop === 'savepoint') {
        return (...a: unknown[]) => {
          const last = a.length - 1;
          const fn = a[last] as (s: PgSql) => unknown;
          if (typeof fn === 'function') a[last] = (s: PgSql) => fn(narrowTxClient(s, onError));
          const sp = (
            target as unknown as { savepoint: (...x: unknown[]) => PromiseLike<unknown> }
          ).savepoint(...a);
          return Promise.resolve(sp).then(undefined, (err: unknown) => {
            onError(err);
            throw err;
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * A transaction on the narrow route (begin's arguments, the last one its
 * work): its SET goes with its first statement (settingsFirst), each of
 * its statements is checked (narrowTxClient), and the hold check runs
 * before the COMMIT, so a transaction that left the role rolls back
 * (NarrowRoleLeftError). A denial is noted where it is met, a caught one
 * too. When the hold check fails for another reason (the transaction was
 * aborted by a statement whose error the work caught without a savepoint),
 * the caller gets that statement's error, never NarrowRoleLeftError.
 */
export async function narrowBegin(
  base: PgSql,
  args: unknown[],
  pool: PgSql | null = null,
): Promise<unknown> {
  const work = args[args.length - 1] as (t: PgSql) => unknown;
  noteNarrowUse();
  if (pool) await systemStartup(base);
  // On the login pool the role is the session's: the SET carries the
  // actor's settings only (none with no actor).
  const setSql = await narrowSettingsSql(pool === null);
  const on = pool ?? base;
  let firstError: { err: unknown } | null = null;
  const seen = (err: unknown) => {
    firstError ??= { err };
    noteNarrowDenial(err);
  };
  try {
    return await (on.begin as (...a: unknown[]) => Promise<unknown>)(
      ...args.slice(0, -1),
      async (t: PgSql) => {
        const set = setSql === null ? t : settingsFirst(t, () => setSql);
        const value = await workResult(work(narrowTxClient(set, seen)));
        try {
          await narrowHeld(set);
        } catch (err) {
          if (pgErrorCode(err) === HOLD_FAILED) throw new NarrowRoleLeftError();
          throw firstError ? firstError.err : err;
        }
        return value;
      },
    );
  } catch (err) {
    noteNarrowDenial(err);
    throw pool ? narrowLoginError(err) : err;
  }
}

/**
 * The system pool's client with the narrow route (plan v3.2 S7a): a
 * statement or a transaction sent while `narrowNow()` says so runs on the
 * narrow route (narrowStatement, narrowBegin), on `narrowPool()`'s
 * connections (the narrow role's own login, S7b), else on `base`'s;
 * everything else is `withActor`'s (the actor client), exactly as before.
 * Decided when the statement is sent, in the caller's context.
 */
export function narrowRouteClient(
  withActor: PgSql,
  base: PgSql,
  narrowNow: () => boolean,
  narrowPool: () => PgSql | null = () => null,
  wouldNarrow: () => boolean = () => false,
): PgSql {
  return new Proxy(withActor, {
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: unknown) => {
          if (!narrowNow()) {
            // The switch off, on a route that would be narrow: the calls
            // the role could not make are counted (noteWouldRefuseCalls).
            if (wouldNarrow()) noteWouldRefuseCalls(base, query);
            return target.unsafe(query, args as never[], opts as never);
          }
          // Tracked: closeDb waits for it (trackPipeline).
          return lazyQuery((mode) =>
            trackPipeline(
              Promise.resolve().then(() => narrowStatement(base, query, args, mode, narrowPool())),
            ),
          );
        };
      }
      if (prop === 'begin') {
        return (...args: unknown[]) => {
          const last = args[args.length - 1];
          if (!narrowNow() || typeof last !== 'function') {
            if (typeof last === 'function' && wouldNarrow()) {
              const inner = last as (t: PgSql) => unknown;
              return (target.begin as (...a: unknown[]) => unknown)(
                ...args.slice(0, -1),
                (t: PgSql) => inner(wouldRefuseTx(t, base)),
              );
            }
            return (target.begin as (...a: unknown[]) => unknown)(...args);
          }
          return trackPipeline(Promise.resolve().then(() => narrowBegin(base, args, narrowPool())));
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
