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
import { permissionGapOf } from '../pg-error';
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

/** A transaction-control verb anywhere in the statement's text. */
const TX_CONTROL =
  /(?:^|;)\s*(?:begin|commit|rollback|abort|end|start\s+transaction|prepare\s+transaction|savepoint|release)\b/i;

/** Refuse what the narrow route never sends (NarrowRouteRefusedError). */
function narrowSendable(query: string): void {
  if (runsOutsideTransaction(query)) {
    throw new NarrowRouteRefusedError('a statement outside a transaction');
  }
  if (TX_CONTROL.test(statementBody(query, false))) {
    throw new NarrowRouteRefusedError('a transaction-control statement');
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
      if (failed === 3) throw new NarrowRoleLeftError();
      const err = (out[failed] as PromiseRejectedResult).reason;
      noteNarrowDenial(err);
      throw err;
    }
    return (out[2] as PromiseFulfilledResult<unknown>).value;
  } finally {
    lease.release();
  }
}

/**
 * A transaction on the narrow route (begin's arguments, the last one its
 * work): its SET goes with its first statement (settingsFirst), and the
 * hold check runs before the COMMIT, so a transaction that left the role
 * rolls back (NarrowRoleLeftError).
 */
export async function narrowBegin(base: PgSql, args: unknown[]): Promise<unknown> {
  const work = args[args.length - 1] as (t: PgSql) => unknown;
  noteNarrowUse();
  const setSql = await narrowSettingsSql();
  try {
    return await (base.begin as (...a: unknown[]) => Promise<unknown>)(
      ...args.slice(0, -1),
      async (t: PgSql) => {
        const client = settingsFirst(t, () => setSql);
        const value = await work(client);
        try {
          await narrowHeld(client);
        } catch {
          throw new NarrowRoleLeftError();
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
