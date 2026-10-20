/**
 * The write role's transaction (the login write gateway): the route a
 * write runs on (LoginWriteRoute), a login's write transaction open in this
 * async context (WriteTx, openWriteTx), its joins and savepoints one after
 * another, the watched client, the bounded begin and reserve on the write
 * pool (WritePoolBusyError), afterOuterCommit and afterOuterRollback. One
 * owner for that state (openWriteTx, the savepoint map, the pool's wait).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type postgres from 'postgres';
import { env } from '@mantle/config';
import { RuntimeFaultError } from '@mantle/std';
import {
  afterCommit,
  afterRollback,
  currentScopeTx,
  newTxHooks,
  runTxHooks,
  systemDbCallerOf,
  type TxHooks,
  type WorkspaceScope,
} from '../viewer';
import { longStack, noteActorMiss, noteTestWriteRoleGap } from '../actor';
import { reserveLease, type Lease } from '../reserved';
import { BusyError, permissionGapOf } from '../pg-error';
import { ACTOR_SQL_TAG } from './check-mode';
import { writePoolSql } from './pools';

type PgSql = ReturnType<typeof postgres>;

/** Where a write runs on the write role: the one SET of its transaction
 *  (scope, actor, create home, the box mode), the actor (a denial's log
 *  line) and the scope. Two writes with the same `setSql` run as the same
 *  actor in the same scope: the second may join the first's open
 *  transaction. */
export type LoginWriteRoute = {
  setSql: string;
  actor: string;
  scope: WorkspaceScope;
};

import { lazyQuery, sendIn, type QueryLike, type QueryMode } from './actor-sql';
export { lazyQuery, sendIn, type QueryMode } from './actor-sql';

// ── Write-role denials (A2b2b fix round 1, H1) ──────────────────────────────

/**
 * A right the write role does not hold, met by a login write: noted every
 * time (a caught one too). Tests record it (vitest.setup.ts fails on every
 * one: plan v3 S3 closed the last gap tables); elsewhere it is a miss row
 * (check 'write-role-gap') with what was denied and the caller. Never for a
 * refusal the database decided (a write check, a row rule).
 */
export function noteWriteRoleDenial(route: LoginWriteRoute, what: string): void {
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

// ── The write-role transaction (A2b2b fix round 1, M1 and M2) ──────────────

/** A login's write transaction open in this async context, on the write
 *  role. */
export type WriteTx = {
  route: LoginWriteRoute;
  /** Its client once its work runs: a write that joins it runs here. */
  t: PgSql | null;
  /** Its work ended (or failed): nothing joins it, and no statement of it
   *  or of a savepoint under it reaches the driver any more. */
  done: boolean;
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

/** The login write transaction level the caller runs in, if any: the one
 *  read of the store outside this module (the store's writes stay here). */
export function currentWriteTx(): WriteTx | undefined {
  return openWriteTx.getStore();
}

/** Run `fn` in write transaction level `tx`: the one write of the store
 *  outside this module (role-runner.ts opens a transaction's top level). */
export function runInWriteTx<T>(tx: WriteTx, fn: () => T): T {
  return openWriteTx.run(tx, fn);
}

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
 * Whether the current code runs inside a transaction that is still open:
 * a login write transaction (a request's db.transaction, M2) whose level
 * has not ended, or a scope's own (withSystemTx, withScope). Work that runs
 * on a connection of its own (the named system step, system-step.ts) would
 * not see that transaction's rows and could wait behind its locks (F4 fix
 * round 3, L5).
 */
export function inOpenTransaction(): boolean {
  const open = openWriteTx.getStore();
  if (open && !levelEnded(open)) return true;
  return currentScopeTx() !== null;
}

/** A write transaction's state (WriteTx), or a savepoint's under `parent`.
 *  `saves`: the transaction's savepoint count when it is a system
 *  transaction's too (withSystemTx on the write role). */
export function newWriteTx(
  route: LoginWriteRoute,
  parent: WriteTx | null,
  saves?: { n: number },
): WriteTx {
  return {
    route,
    t: null,
    done: false,
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
export class JoinedWriteEndedError extends RuntimeFaultError {
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
export function levelEnded(level: WriteTx): boolean {
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
export function joinWriteTx(open: WriteTx, work: (sp: PgSql) => unknown): Promise<unknown> {
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
    const child = newWriteTx(open.route, open);
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
export function joinableWriteTx(route: LoginWriteRoute): WriteTx | null {
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
 *  - a right the role does not hold, as Postgres answers it, is noted
 *    (noteWriteRoleDenial) and stays the caller's error: no write runs
 *    again anywhere (plan v3 S3: the gap rerun went with the gap tables).
 * A savepoint (drizzle's nested transaction) is one of the level's
 * savepoints (joinWriteTx): in line with the joins, a level of its own.
 */
export function watchTx(t: PgSql, tx: WriteTx, level: WriteTx): PgSql {
  const observe = (p: Promise<unknown>): Promise<unknown> =>
    p.catch((err: unknown) => {
      const what = permissionGapOf(err);
      if (what) noteWriteRoleDenial(tx.route, what);
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
    // scope and actor.
    if (levelEnded(level)) return Promise.reject(new JoinedWriteEndedError());
    watchedSends += 1;
    return observe(send());
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

/** How long a write waits for a write-pool connection (openLoginWritePool's size per
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
  if (open && !open.done && env('NODE_ENV') === 'test') {
    throw new Error(
      'login write gateway: a second write-pool connection taken inside an open write transaction (A2b2b M2)',
    );
  }
}

/** sql.begin on the write pool, waiting at most writePoolWaitMs for a
 *  connection. A begin that gets one later rolls back at once. */
export function boundedBegin(
  config: unknown[],
  work: (t: PgSql) => Promise<unknown>,
): Promise<unknown> {
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
export async function boundedReserve(): Promise<Lease> {
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

/**
 * Nested calls in one outer transaction before a warning (A2b1 fix round 2,
 * L2). Each is a savepoint that postgres.js never releases, and a released
 * one would not help: Postgres keeps a subtransaction's id until the top
 * transaction ends. Past 64 subtransactions that wrote, the backend's
 * subtransaction cache overflows and every snapshot on the box pays for it.
 * So no nested write in a loop; the warning finds one.
 */
export const NESTED_SAVEPOINT_WARN = 32;
