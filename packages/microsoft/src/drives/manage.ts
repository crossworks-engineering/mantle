/** Owner-scoped drive management for the settings UI. */
import { and, eq } from 'drizzle-orm';
import { db, msAccounts, msDrives, type MsDrive } from '@mantle/db';
import { discoverDrives } from './discover';

/** Re-enumerate an account's drives. Returns the count, or null if the account
 *  isn't owned by `ownerId`. */
export async function discoverForAccount(ownerId: string, accountId: string): Promise<number | null> {
  const [account] = await db
    .select()
    .from(msAccounts)
    .where(and(eq(msAccounts.id, accountId), eq(msAccounts.userId, ownerId)))
    .limit(1);
  if (!account) return null;
  return discoverDrives(account);
}

/** Toggle a drive on/off for sync. Verifies the drive belongs to an account the
 *  user owns. The scheduler picks up newly-enabled drives on its next tick. */
export async function setDriveEnabled(ownerId: string, driveDbId: string, enabled: boolean): Promise<boolean> {
  const [row] = await db
    .select({ id: msDrives.id })
    .from(msDrives)
    .innerJoin(msAccounts, eq(msDrives.accountId, msAccounts.id))
    .where(and(eq(msDrives.id, driveDbId), eq(msAccounts.userId, ownerId)))
    .limit(1);
  if (!row) return false;
  await db.update(msDrives).set({ enabled, updatedAt: new Date() }).where(eq(msDrives.id, driveDbId));
  return true;
}

/** List an account's known drives (most recently synced first) for display. */
export function listDrives(accountId: string): Promise<MsDrive[]> {
  return db.select().from(msDrives).where(eq(msDrives.accountId, accountId)).orderBy(msDrives.name);
}
