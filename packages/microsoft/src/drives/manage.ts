/** Owner-scoped drive management for the settings UI. */
import { and, count, eq } from 'drizzle-orm';
import { db, msAccounts, msDrives, msDriveScopes, type MsDrive } from '@mantle/db';
import { graphGetAll } from '../client';
import { discoverDrives } from './discover';
import { itemPathAfterRoot, ownedDrive } from './scope';
import type { DriveItem } from './types';

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

/** List an account's known drives for display, each with how many scope
 *  selections it has (0 = syncing everything). */
export async function listDrives(accountId: string): Promise<(MsDrive & { scopeCount: number })[]> {
  const rows = await db
    .select({ drive: msDrives, scopeCount: count(msDriveScopes.id) })
    .from(msDrives)
    .leftJoin(msDriveScopes, eq(msDriveScopes.driveDbId, msDrives.id))
    .where(eq(msDrives.accountId, accountId))
    .groupBy(msDrives.id)
    .orderBy(msDrives.name);
  return rows.map((r) => ({ ...r.drive, scopeCount: Number(r.scopeCount) }));
}

/** One entry of a drive-folder listing for the scope picker. */
export interface DriveChild {
  itemId: string;
  name: string;
  isFolder: boolean;
  /** Folder child count (badge in the picker); null for files. */
  childCount: number | null;
  /** File size in bytes; null for folders. */
  size: number | null;
  /** After-`root:` path (`/Reports/2026`); the scope key for folders. */
  path: string | null;
  webUrl: string | null;
}

/**
 * List a folder's children for the scope picker (drive root when `itemId` is
 * omitted). Live Graph call — nothing is persisted. Returns null when the
 * drive isn't owned by `ownerId`.
 */
export async function browseDrive(
  ownerId: string,
  driveDbId: string,
  itemId?: string,
): Promise<DriveChild[] | null> {
  const owned = await ownedDrive(ownerId, driveDbId);
  if (!owned) return null;
  const base = itemId
    ? `/drives/${owned.drive.driveId}/items/${itemId}/children`
    : `/drives/${owned.drive.driveId}/root/children`;
  const { items } = await graphGetAll<DriveItem>(
    owned.account.userId,
    owned.account.id,
    `${base}?$select=id,name,size,folder,file,parentReference,webUrl&$top=200`,
  );
  return items
    .filter((i) => i.name)
    .map((i) => ({
      itemId: i.id,
      name: i.name ?? '',
      isFolder: !!i.folder,
      childCount: i.folder?.childCount ?? null,
      size: i.folder ? null : (i.size ?? null),
      path: itemPathAfterRoot(i),
      webUrl: i.webUrl ?? null,
    }));
}
