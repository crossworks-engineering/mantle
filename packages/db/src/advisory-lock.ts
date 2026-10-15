/**
 * Advisory locks (A10 #15): every transaction-scoped advisory lock the
 * product takes goes through here, where eleven sites wrote the SQL by hand.
 *
 * A lock's key is a hash of a key text, and two hash functions are in use:
 * `hashtextextended(text, 0)` (64 bit) at most sites, `hashtext(text)` (32
 * bit) at the older ones. Each site names its own and KEEPS it: the key a
 * lock takes is the hash function's value of the text, so two versions of
 * the code exclude each other during a roll only when both hash the same
 * text with the same function (advisory-lock-keys.test.ts holds every site
 * to the function, hash and text recorded on main). A new lock uses
 * 'hashtextextended'.
 *
 * Not in @mantle/std, as the survey had it: std takes no dependency and is
 * bundled for the browser; a lock needs drizzle's sql and a transaction,
 * both of this package.
 *
 * The folder-share lock (share-lock.ts) keeps its own: its key is a SQL
 * function the triggers share (mantle_share_lock_key), and it is shared.
 */
import { sql, type SQL } from 'drizzle-orm';

/** The hash a lock's key text goes through. */
export type AdvisoryHash = 'hashtext' | 'hashtextextended';

/** What a lock runs on: a transaction (or the pool, for a statement that
 *  is its own transaction). */
export type AdvisoryLockExec = { execute: (q: SQL) => PromiseLike<unknown> };

/** The key of `text` under `hash`, as main wrote it. */
export function advisoryKeySql(text: string, hash: AdvisoryHash): SQL {
  return hash === 'hashtext' ? sql`hashtext(${text})` : sql`hashtextextended(${text}, 0)`;
}

/** Wait for the transaction-scoped advisory lock on `text`; held until the
 *  transaction ends. */
export async function advisoryXactLock(
  tx: AdvisoryLockExec,
  text: string,
  hash: AdvisoryHash,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${advisoryKeySql(text, hash)})`);
}

/** Take the transaction-scoped advisory lock on `text` if it is free:
 *  whether it was taken (another transaction holds it: false, no wait). */
export async function tryAdvisoryXactLock(
  tx: AdvisoryLockExec,
  text: string,
  hash: AdvisoryHash,
): Promise<boolean> {
  const res = (await tx.execute(
    sql`select pg_try_advisory_xact_lock(${advisoryKeySql(text, hash)}) as locked`,
  )) as unknown;
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as {
    locked?: boolean;
  }[];
  return rows[0]?.locked === true;
}
