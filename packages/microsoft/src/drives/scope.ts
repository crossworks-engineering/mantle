/**
 * Per-drive sync scopes — the "choose what to sync" selections behind the
 * folder/file picker on /settings/microsoft.
 *
 * Path model: Graph's `parentReference.path` looks like
 * `/drives/<id>/root:/Folder/Sub`. We keep only the after-`root:` part, so a
 * stored scope path is `/Folder/Sub` (or `/file.pdf` for a root file) and an
 * item's path is `<parent-after-root>/<name>`. Folder scopes match by prefix,
 * file scopes by item id (stable across renames) or exact path.
 *
 * Graph only supports delta queries from the drive ROOT on OneDrive for
 * Business/SharePoint, so scoping is a client-side filter over the root delta
 * feed — same cursor, no extra API cost. Saving a scope set clears the cursor
 * so the next sync full-walks: newly-in-scope files get ingested, and
 * previously-ingested files now out of scope get pruned during that walk.
 */
import { and, eq } from 'drizzle-orm';
import { db, msAccounts, msDrives, msDriveScopes, type MsDriveScope } from '@mantle/db';
import type { DriveItem } from './types';

/** The after-`root:` part of a Graph parent path (`''` for root children);
 *  null when the path is absent or root-less (e.g. the drive root itself). */
function afterRoot(parentPath: string | undefined): string | null {
  if (!parentPath) return null;
  const i = parentPath.indexOf('root:');
  if (i < 0) return null;
  const raw = parentPath.slice(i + 5);
  // Graph URL-encodes path segments in some responses; stored scopes are
  // decoded, so decode here too (fall back to raw on malformed escapes).
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Full after-root path of an item (e.g. `/Reports/2026/rbi.pdf`), or null
 *  when Graph didn't send a usable parent path. */
export function itemPathAfterRoot(item: Pick<DriveItem, 'name' | 'parentReference'>): string | null {
  const parent = afterRoot(item.parentReference?.path);
  if (parent === null || !item.name) return null;
  return `${parent}/${item.name}`;
}

export type ScopeInput = { itemId: string; path: string; isFolder: boolean; name?: string | null };

/** Does an item fall inside the scope set? An empty set means "everything"
 *  (the un-scoped default). Items with no resolvable path only match file
 *  scopes by id — better to skip an oddball than vacuum out of scope. */
export function inScope(
  scopes: Pick<MsDriveScope, 'itemId' | 'path' | 'isFolder'>[],
  item: Pick<DriveItem, 'id' | 'name' | 'parentReference'>,
): boolean {
  if (scopes.length === 0) return true;
  const path = itemPathAfterRoot(item);
  return scopes.some((s) =>
    s.isFolder
      ? path !== null && (path === s.path || path.startsWith(`${s.path}/`))
      : item.id === s.itemId || (path !== null && path === s.path),
  );
}

export function listScopes(driveDbId: string): Promise<MsDriveScope[]> {
  return db
    .select()
    .from(msDriveScopes)
    .where(eq(msDriveScopes.driveDbId, driveDbId))
    .orderBy(msDriveScopes.path);
}

/** Owner-verified drive lookup shared by scope CRUD + browse. */
export async function ownedDrive(ownerId: string, driveDbId: string) {
  const [row] = await db
    .select({ drive: msDrives, account: msAccounts })
    .from(msDrives)
    .innerJoin(msAccounts, eq(msDrives.accountId, msAccounts.id))
    .where(and(eq(msDrives.id, driveDbId), eq(msAccounts.userId, ownerId)))
    .limit(1);
  return row ?? null;
}

/**
 * Replace a drive's scope set. Clears the delta cursor so the next sync
 * re-walks the whole drive against the new scope (ingesting newly-in-scope
 * files, pruning newly-out-of-scope ones). Returns false if the drive isn't
 * owned by `ownerId`.
 */
export async function setDriveScopes(
  ownerId: string,
  driveDbId: string,
  scopes: ScopeInput[],
): Promise<boolean> {
  const owned = await ownedDrive(ownerId, driveDbId);
  if (!owned) return false;
  await db.transaction(async (tx) => {
    await tx.delete(msDriveScopes).where(eq(msDriveScopes.driveDbId, driveDbId));
    if (scopes.length > 0) {
      await tx.insert(msDriveScopes).values(
        scopes.map((s) => ({
          driveDbId,
          itemId: s.itemId,
          path: s.path,
          isFolder: s.isFolder,
          name: s.name ?? null,
        })),
      );
    }
    await tx
      .update(msDrives)
      .set({ deltaLink: null, updatedAt: new Date() })
      .where(eq(msDrives.id, driveDbId));
  });
  return true;
}
