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
 *  ROLE or SESSION AUTHORIZATION (the name bare or quoted), RESET ROLE,
 *  RESET SESSION AUTHORIZATION, RESET ALL. Read on the text with its
 *  strings blanked and its quoted identifiers kept (sqlCode). */
const ROLE_CHANGE =
  /\b(?:set\s+(?:session\s+|local\s+)?(?:"?(?:role|session_authorization)"?(?![\w$])|session\s+authorization\b)|reset\s+(?:"?(?:role|session_authorization)"?(?![\w$])|all\b|session\s+authorization\b))/i;

/** A session-level SET or RESET at the start of any statement (outlives
 *  the transaction): SET without LOCAL (SET TRANSACTION and SET
 *  CONSTRAINTS are the transaction's own), and any RESET. */
const SESSION_SET = /(?:^|;)\s*(?:set\s+(?!local\b|transaction\b|constraints\b)|reset\b)/i;

/** A DO block at the start of any statement: its body is code the text
 *  check cannot read (it may leave the role and take it back before the
 *  hold check). */
const DO_BLOCK = /(?:^|;)\s*do\b/i;

/** pg_settings: an UPDATE of it is set_config(name, value, false) by its
 *  rule, so any statement naming it is refused (a read included). */
const PG_SETTINGS = /\bpg_settings\b/i;

/** A call of set_config, the name bare, quoted or schema-qualified. */
const SET_CONFIG_CALL = /(?<![\w$])"?set_config"?\s*\(/gi;

/** The one shape of a set_config argument a narrow statement may name: a
 *  plain literal of a mantle.* setting (no concatenation, no parameter, no
 *  cast, no E'' string). */
const MANTLE_SETTING_LITERAL = /^'mantle\.[a-z0-9_]+(?:\.[a-z0-9_]+)*'$/i;

/**
 * The settings other than mantle.* a narrow statement may set
 * transaction-local by set_config (a SET LOCAL of them is sent as it is),
 * each with its caller: none can change the role.
 */
export const NARROW_LOCAL_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
  lock_timeout: "share-lock.ts and app-broker.ts: a bounded wait for a lock, the transaction's own",
  enable_sort: "search hnsw.ts: the planner's sort off for one vector read, put back after",
});

/**
 * The top-level arguments of the set_config call whose `(` is at `open` in
 * `code` (the text with strings and comments blanked, same length as
 * `text`), cut from `text` (comments blanked, strings kept). Null when the
 * call does not close.
 */
function callArguments(code: string, text: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (c === ')') {
      args.push(text.slice(from, i).trim());
      return args;
    } else if (c === ',' && depth === 0) {
      args.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  return null;
}

/**
 * Whether every set_config call of the text is one a narrow statement may
 * send: three arguments, the first a plain literal naming a mantle.*
 * setting or one of NARROW_LOCAL_SETTINGS, the third the literal true. A
 * role name built by concatenation ('ro' || 'le'), a bound parameter or any
 * other expression as the name, and a session setting (false, or a
 * parameter) are not.
 */
function setConfigCallsSendable(query: string): boolean {
  const text = sqlCode(query, false);
  const code = sqlCode(query, true, false);
  for (const m of code.matchAll(SET_CONFIG_CALL)) {
    const args = callArguments(code, text, m.index + m[0].length - 1);
    if (!args || args.length !== 3) return false;
    const name = args[0]!;
    const local = name.length > 2 ? name.slice(1, -1).toLowerCase() : '';
    const named =
      MANTLE_SETTING_LITERAL.test(name) ||
      (/^'[a-z_]+'$/i.test(name) && Object.hasOwn(NARROW_LOCAL_SETTINGS, local));
    if (!named || args[2]!.toLowerCase() !== 'true') return false;
  }
  return true;
}

/**
 * The text with its comments blanked (`--`, `/* *\/`) and, with
 * `literals`, its string literals and dollar-quoted bodies blanked too (and
 * its quoted identifiers, unless `identifiers` is false), so a verb inside
 * a value is never read as one. The same length as the text: an offset in
 * one is the same place in the other.
 */
export function sqlCode(query: string, literals = true, identifiers = literals): string {
  let out = '';
  let i = 0;
  const n = query.length;
  const blank = (from: number, to: number, keep: string) =>
    to - from >= 2 ? keep + ' '.repeat(to - from - 2) + keep : ' '.repeat(to - from);
  while (i < n) {
    const c = query[i]!;
    const next = query[i + 1];
    if (c === '-' && next === '-') {
      const end = query.indexOf('\n', i);
      const to = end < 0 ? n : end;
      out += ' '.repeat(to - i);
      i = to;
    } else if (c === '/' && next === '*') {
      const end = query.indexOf('*/', i + 2);
      const to = end < 0 ? n : end + 2;
      out += ' '.repeat(to - i);
      i = to;
    } else if ((literals && c === "'") || (identifiers && c === '"')) {
      let j = i + 1;
      for (; j < n; j++) {
        if (query[j] === c) {
          if (query[j + 1] === c) j++;
          else break;
        }
        // An E'' string: a backslash escapes the next character.
        else if (c === "'" && query[j] === '\\' && /[eE]/.test(query[i - 1] ?? '')) j++;
      }
      const to = Math.min(j + 1, n);
      out += blank(i, to, c);
      i = to;
    } else if (literals && c === '$') {
      const tag = /^\$([A-Za-z_][\w]*)?\$/.exec(query.slice(i));
      if (tag) {
        const end = query.indexOf(tag[0], i + tag[0].length);
        const to = end < 0 ? n : end + tag[0].length;
        out += blank(i, to, "'");
        i = to;
      } else {
        out += c;
        i++;
      }
    } else if (c === "'" || c === '"') {
      // Kept: copied whole, so a quote inside never opens a comment.
      let j = i + 1;
      for (; j < n; j++) {
        if (query[j] === c) {
          if (query[j + 1] === c) j++;
          else break;
        } else if (c === "'" && query[j] === '\\' && /[eE]/.test(query[i - 1] ?? '')) j++;
      }
      const to = Math.min(j + 1, n);
      out += query.slice(i, to);
      i = to;
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
 * statements would run as the pool's own login); a role change, by SET,
 * RESET, set_config or pg_settings, whatever builds the name; a DO block
 * (code the text cannot read); a session-level SET, RESET or set_config (it
 * outlives the transaction); and any set_config but a transaction-local one
 * of a literal mantle.* setting (or NARROW_LOCAL_SETTINGS).
 */
export function narrowSendable(query: string): void {
  if (runsOutsideTransaction(query)) {
    throw new NarrowRouteRefusedError('a statement outside a transaction');
  }
  const body = statementBody(query, false);
  const code = sqlCode(body);
  const named = sqlCode(body, true, false);
  if (TX_CONTROL.test(code)) {
    throw new NarrowRouteRefusedError('a transaction-control statement');
  }
  if (ROLE_CHANGE.test(named) || PG_SETTINGS.test(named)) {
    throw new NarrowRouteRefusedError('a role change');
  }
  if (DO_BLOCK.test(code)) {
    throw new NarrowRouteRefusedError('a DO block');
  }
  if (SESSION_SET.test(code)) {
    throw new NarrowRouteRefusedError('a session-level setting');
  }
  if (!setConfigCallsSendable(query)) {
    throw new NarrowRouteRefusedError('a set_config other than a local mantle.* setting');
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
  for (const m of sqlCode(query).matchAll(CALLED_FN)) {
    noteTestNarrowUse(`fn:${m[1]!.toLowerCase()}`);
  }
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
  noteNarrowFunctions(query);
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
      if (Array.isArray(first) && 'raw' in first) {
        const text = (first as string[]).join('$1');
        narrowSendable(text);
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
