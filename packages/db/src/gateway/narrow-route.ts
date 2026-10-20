/**
 * The narrow system route (plan v3.2 section 2.1 point 3): a statement or
 * a transaction of a reason routed 'narrow' runs on the system pool as
 * mantle_system_narrow, the role taken per transaction by
 * set_config('role', ..., true) with the actor's settings (never a session
 * SET), the hold check before the COMMIT. The write role's runner has the
 * same shape (role-runner.ts); this one sits below pools.ts, which builds
 * the system pool's client over it (narrowRouteClient).
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
  noteTestNarrowDenial,
  noteTestNarrowUse,
  writeModeOf,
} from '../actor';
import { reserveLease } from '../reserved';
import { NARROW_ROLE } from '../runtime-role';
import { NARROW_SQL_TAG, firstModeReadNow } from './check-mode';
import {
  lazyQuery,
  runsOutsideTransaction,
  sendIn,
  setActorSql,
  settingsFirst,
  statementBody,
  trackPipeline,
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

/** A statement the narrow route never sends: one Postgres refuses inside a
 *  transaction block (DDL, maintenance), or one that ends or opens a
 *  transaction (it would run past the role's transaction-local SET). */
export class NarrowRouteRefusedError extends RuntimeFaultError {
  constructor(what: string) {
    super(`narrow system route: ${what} is refused on the narrow role`);
    this.name = 'NarrowRouteRefusedError';
  }
}

/** A transaction-control verb at the start of any statement of the text
 *  (read with its literals and comments blanked, sqlCode). */
const TX_CONTROL =
  /(?:^|;)\s*(?:begin|commit|rollback|abort|end|start\s+transaction|prepare\s+transaction|savepoint|release)\b/i;

/** A role change in any form, anywhere in the text: SET [SESSION | LOCAL]
 *  ROLE, RESET ROLE, SET SESSION AUTHORIZATION, RESET ALL. */
const ROLE_CHANGE =
  /\b(?:set\s+(?:session\s+|local\s+)?role|reset\s+(?:role|all|session\s+authorization)|set\s+(?:session\s+)?session\s+authorization)\b/i;

/** A session-level SET or RESET at the start of any statement (outlives
 *  the transaction): SET without LOCAL (SET TRANSACTION and SET
 *  CONSTRAINTS are the transaction's own), and any RESET. */
const SESSION_SET = /(?:^|;)\s*(?:set\s+(?!local\b|transaction\b|constraints\b)|reset\b)/i;

/** set_config with is_local false (a session setting), read on the text
 *  with literals blanked: its third argument is the literal `false`. */
const SESSION_SET_CONFIG = /\bset_config\s*\((?:[^();]|\([^();]*\))*,\s*false\s*\)/i;

/** set_config of the role or the session's authorization, read on the text
 *  with comments blanked and literals kept. */
const ROLE_SET_CONFIG = /\bset_config\s*\(\s*'(?:role|session_authorization)'/i;

/**
 * The text with its comments blanked (`--`, `/* *\/`) and, with
 * `literals`, its string literals, quoted identifiers and dollar-quoted
 * bodies blanked too, so a verb inside a value is never read as one.
 */
export function sqlCode(query: string, literals = true): string {
  let out = '';
  let i = 0;
  const n = query.length;
  while (i < n) {
    const c = query[i]!;
    const next = query[i + 1];
    if (c === '-' && next === '-') {
      const end = query.indexOf('\n', i);
      i = end < 0 ? n : end;
      out += ' ';
    } else if (c === '/' && next === '*') {
      const end = query.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
    } else if (literals && (c === "'" || c === '"')) {
      let j = i + 1;
      for (; j < n; j++) {
        if (query[j] === c) {
          if (query[j + 1] === c) j++;
          else break;
        }
        // An E'' string: a backslash escapes the next character.
        else if (c === "'" && query[j] === '\\' && /[eE]/.test(query[i - 1] ?? '')) j++;
      }
      i = j + 1;
      out += c === "'" ? "''" : '""';
    } else if (literals && c === '$') {
      const tag = /^\$([A-Za-z_][\w]*)?\$/.exec(query.slice(i));
      if (tag) {
        const end = query.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? n : end + tag[0].length;
        out += "''";
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Refuse what the narrow route never sends (NarrowRouteRefusedError), on a
 * single statement and on every statement of a narrow transaction: one
 * Postgres runs only outside a transaction block; a transaction-control
 * statement (it would end the transaction its role is local to, and later
 * statements would run as the pool's own login); a role change; a
 * session-level SET, RESET or set_config (it outlives the transaction).
 */
export function narrowSendable(query: string): void {
  if (runsOutsideTransaction(query)) {
    throw new NarrowRouteRefusedError('a statement outside a transaction');
  }
  const code = sqlCode(statementBody(query, false));
  if (TX_CONTROL.test(code)) {
    throw new NarrowRouteRefusedError('a transaction-control statement');
  }
  if (ROLE_CHANGE.test(code) || ROLE_SET_CONFIG.test(sqlCode(query, false))) {
    throw new NarrowRouteRefusedError('a role change');
  }
  if (SESSION_SET.test(code) || SESSION_SET_CONFIG.test(code)) {
    throw new NarrowRouteRefusedError('a session-level setting');
  }
}

/**
 * The one SET of a narrow transaction (never a session SET): the role,
 * transaction-local, and the actor, its write mode and the box's check mode
 * (set whatever the mode, so the database always knows who wrote: the
 * actor stays system:<reason>). Inlined, checked literals (setActorSql).
 */
async function narrowSettingsSql(): Promise<string> {
  const waitFor = firstModeReadNow();
  if (waitFor) await waitFor;
  const actor = currentActor();
  const role = `set_config('role', '${NARROW_ROLE}', true)`;
  if (!actor) return `${NARROW_SQL_TAG} select ${role}`;
  return `${NARROW_SQL_TAG} ${setActorSql([actorSetting(actor), writeModeOf(actor), actorCheckMode()])}, ${role}`;
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
  // Once per error: a statement's denial is noted where it is met, and
  // again as the transaction's error when nothing caught it.
  if (typeof err === 'object' && err !== null) {
    if (notedDenials.has(err)) return;
    notedDenials.add(err);
  }
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
): Promise<unknown> {
  narrowSendable(query);
  noteNarrowUse();
  const setSql = await narrowSettingsSql();
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

/** The hold check's refusal: division by zero (narrowHeld). */
const HOLD_FAILED = '22012';

/** One statement's query object, kept lazy (a postgres.js query runs when
 *  it is awaited, in the mode `.values()` or `.simple()` picked), with its
 *  error seen by `onError` first. */
type QueryLike = PromiseLike<unknown> & {
  values?: () => PromiseLike<unknown>;
  simple?: () => PromiseLike<unknown>;
};

function watchedQuery(q: QueryLike, onError: (err: unknown) => void) {
  const run = (p: PromiseLike<unknown>) =>
    Promise.resolve(p).then(undefined, (err: unknown) => {
      onError(err);
      throw err;
    });
  let started: Promise<unknown> | null = null;
  const once = () => (started ??= run(q));
  return {
    then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => once().then(ok, bad),
    catch: (bad?: (e: unknown) => unknown) => once().catch(bad),
    finally: (f?: () => void) => once().finally(f),
    values: () => run(q.values ? q.values() : q),
    simple: () => run(q.simple ? q.simple() : q),
  };
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
      if (Array.isArray(first) && 'raw' in first) narrowSendable((first as string[]).join('$1'));
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: unknown) => {
          narrowSendable(query);
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
export async function narrowBegin(base: PgSql, args: unknown[]): Promise<unknown> {
  const work = args[args.length - 1] as (t: PgSql) => unknown;
  noteNarrowUse();
  const setSql = await narrowSettingsSql();
  let firstError: { err: unknown } | null = null;
  const seen = (err: unknown) => {
    firstError ??= { err };
    noteNarrowDenial(err);
  };
  try {
    return await (base.begin as (...a: unknown[]) => Promise<unknown>)(
      ...args.slice(0, -1),
      async (t: PgSql) => {
        const set = settingsFirst(t, () => setSql);
        const value = await work(narrowTxClient(set, seen));
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
    throw err;
  }
}

/**
 * The system pool's client with the narrow route (plan v3.2 S7a): a
 * statement or a transaction sent while `narrowNow()` says so runs on the
 * narrow route (narrowStatement, narrowBegin), on `base`'s connections;
 * everything else is `withActor`'s (the actor client), exactly as before.
 * Decided when the statement is sent, in the caller's context.
 */
export function narrowRouteClient(withActor: PgSql, base: PgSql, narrowNow: () => boolean): PgSql {
  return new Proxy(withActor, {
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: unknown) => {
          if (!narrowNow()) return target.unsafe(query, args as never[], opts as never);
          // Tracked: closeDb waits for it (trackPipeline).
          return lazyQuery((mode) => trackPipeline(narrowStatement(base, query, args, mode)));
        };
      }
      if (prop === 'begin') {
        return (...args: unknown[]) => {
          if (!narrowNow() || typeof args[args.length - 1] !== 'function') {
            return (target.begin as (...a: unknown[]) => unknown)(...args);
          }
          return trackPipeline(narrowBegin(base, args));
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
