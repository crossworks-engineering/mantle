/**
 * The write role's runner: one statement outside a transaction as one
 * pipelined transaction on the write role (BEGIN, the SET, the statement
 * and COMMIT on one reserved connection), the outermost write transaction
 * and its begin, and a transaction or a statement joined to an open one.
 * It takes the route's SET only (route.setSql); whether a write takes the
 * write role at all is write-route.ts's decision. The narrow system role's
 * runner, the same shape on the system pool, is narrow-route.ts (it sits
 * below pools.ts, which this file's role-tx.ts imports).
 */
import type postgres from 'postgres';
import { runTxHooks } from '../viewer';
import { permissionGapOf } from '../pg-error';
import { ACTOR_SQL_TAG } from './check-mode';
import { settingsFirst, workResult } from './actor-sql';
import {
  boundedBegin,
  boundedReserve,
  joinWriteTx,
  newWriteTx,
  noteWriteRoleDenial,
  runInWriteTx,
  sendIn,
  watchTx,
  type LoginWriteRoute,
  type QueryMode,
  type WriteTx,
} from './role-tx';

type PgSql = ReturnType<typeof postgres>;

/**
 * One write outside a transaction on the write role: BEGIN, the settings,
 * the statement and COMMIT pipelined on one reserved connection (one round
 * trip, as a turn scope's read). A failing statement aborts the
 * transaction, the COMMIT then rolls back, and the first error is thrown.
 */
export async function writeRoleStatement(
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
      if (what) noteWriteRoleDenial(route, what);
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
 * writes that join it while `work` runs (runInWriteTx). The hooks of a
 * withSystemTx joined to it run once it commits or rolls back.
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
      runInWriteTx(tx, async () => {
        const client = settingsFirst(watchTx(t, tx, tx), () => setSql);
        tx.t = client;
        try {
          const value = await workResult(work(client));
          // Joins left running (not awaited) finish inside it.
          await tx.joins;
          return value;
        } catch (err) {
          // Ended first (round 3, A): what it left running settles,
          // refused before the driver, before postgres.js sends the
          // ROLLBACK and hands the connection back.
          tx.done = true;
          // Uncapped (round 5, N5): a capped wait let postgres.js send a
          // late `rollback to` on a connection already handed on.
          await tx.joins;
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
export function writeRoleBegin(
  route: LoginWriteRoute,
  args: unknown[],
  saves?: { n: number },
): Promise<unknown> {
  const work = args[args.length - 1] as (t: PgSql) => unknown;
  const tx = newWriteTx(route, null, saves);
  return writeTxOf(tx, route.setSql, (w) => boundedBegin(args.slice(0, -1), w), work);
}

/** A transaction (begin's arguments) joined to an open write transaction
 *  (M2): a savepoint of it, watched as it is (joinWriteTx). */
export function joinedBegin(open: WriteTx, args: unknown[]): Promise<unknown> {
  return joinWriteTx(open, args[args.length - 1] as (t: PgSql) => unknown);
}

/** One statement joined to an open write transaction (M2), in a savepoint
 *  of its own: a statement that fails leaves the transaction as it was, as
 *  on a connection of its own. */
export function joinedStatement(
  open: WriteTx,
  query: string,
  args: unknown[] | undefined,
  mode: QueryMode,
): Promise<unknown> {
  return joinedBegin(open, [
    (sp: PgSql) => sendIn(sp.unsafe(query, (args ?? []) as never[]), mode),
  ]);
}
