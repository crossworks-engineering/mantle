/**
 * The folder-share write lock (migration 0207): a writer about to change a
 * folder's share or path takes its owner's share lock EXCLUSIVE at the start
 * of its transaction, before any row lock. The triggers take the same lock
 * (shared when a row is filed, exclusive when a refresh runs), so an unshare
 * and an insert into the same folder wait for each other instead of each
 * missing the other's work; taking it first means the writer's own trigger
 * requests never wait, and two writers never deadlock on their own rows.
 */
import { sql } from 'drizzle-orm';

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

/** How long a writer waits for the share lock (and, for the rest of its
 *  transaction, any row lock) before it gives up with 55P03, which callers
 *  answer as "busy, try again" (isBusy). A queued exclusive request holds up
 *  every later insert for the owner, so the wait is bounded. */
const WAIT = '10s';

/** Exclusive: before a folder's share or path changes (or a shared folder
 *  goes). Held until the transaction ends. The FIRST statement of the
 *  transaction, before any row lock. */
export async function takeShareWriteLock(tx: Exec, ownerId: string): Promise<void> {
  await tx.execute(sql`select set_config('lock_timeout', ${WAIT}, true)`);
  await tx.execute(sql`select mantle_share_write_lock(${ownerId}::uuid)`);
}

/** Shared: the FIRST statement of a transaction that moves existing rows
 *  (an item move updates its row, and Postgres locks the row before the
 *  inherit trigger asks for this lock; a folder writer holding the lock
 *  exclusive then waiting on that row would deadlock: review F2), or that
 *  reads the shares its rows will land under (Accept). Advisory first, then
 *  rows, always. */
export async function takeShareReadLock(tx: Exec, ownerId: string): Promise<void> {
  await tx.execute(sql`select set_config('lock_timeout', ${WAIT}, true)`);
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(mantle_share_lock_key(${ownerId}::uuid))`,
  );
}
