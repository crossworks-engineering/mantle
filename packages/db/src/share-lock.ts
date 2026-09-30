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

/** Exclusive: before a folder's share or path changes (or a shared folder
 *  goes). Held until the transaction ends. */
export async function takeShareWriteLock(tx: Exec, ownerId: string): Promise<void> {
  await tx.execute(sql`select mantle_share_write_lock(${ownerId}::uuid)`);
}

/** Shared: before a transaction reads the shares its rows will land under
 *  and then locks folder rows (Accept), so a share change cannot slip in
 *  between, and the order never inverts against a writer. */
export async function takeShareReadLock(tx: Exec, ownerId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(mantle_share_lock_key(${ownerId}::uuid))`,
  );
}
