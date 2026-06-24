/**
 * Incremental drive sync via Graph delta queries. For an enabled drive we walk
 * `/drives/{id}/root/delta` (or the stored `@odata.deltaLink` for subsequent
 * runs), turning each added/changed file into a `file` node and each tombstone
 * into a removal, then persist the new delta cursor.
 *
 * v1 layout is flat: every file in a drive lands directly under that drive's
 * branch (`<accountBranch>.<driveLabel>`), with the SharePoint folder path left
 * in `web_url`. Mirroring the folder tree into ltree is a later refinement (see
 * docs/microsoft-graph-ingest.md).
 */
import { and, eq } from 'drizzle-orm';
import { db, msDriveItems, msDrives, nodes, type MsAccount, type MsDrive } from '@mantle/db';
import { MAX_UPLOAD_BYTES } from '@mantle/files';
import { getValidAccessToken } from '../token-store';
import { graphFetchRaw, graphGetAll } from '../client';
import { storeRemoteFileAsNode } from './store';
import type { DriveItem } from './types';

export interface DriveSyncResult {
  scanned: number;
  ingested: number;
  removed: number;
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Fetch a driveItem's bytes — prefer the pre-authed download URL, else the
 *  authenticated `/content` endpoint. Returns null on any failure (the item is
 *  skipped, not fatal to the run). */
async function downloadItem(
  ownerId: string,
  accountId: string,
  driveId: string,
  item: DriveItem,
): Promise<Buffer | null> {
  try {
    const preauth = item['@microsoft.graph.downloadUrl'];
    if (preauth) {
      const res = await fetch(preauth);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    }
    const token = await getValidAccessToken(ownerId, accountId);
    if (!token) return null;
    const res = await graphFetchRaw(`${GRAPH_BASE}/drives/${driveId}/items/${item.id}/content`, token);
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Remove the node behind a deleted/removed drive item, if nothing else points
 *  at it. Returns 1 if a mapping was removed. */
async function removeItem(driveDbId: string, itemId: string): Promise<number> {
  const [row] = await db
    .select({ id: msDriveItems.id, nodeId: msDriveItems.nodeId })
    .from(msDriveItems)
    .where(and(eq(msDriveItems.driveDbId, driveDbId), eq(msDriveItems.itemId, itemId)))
    .limit(1);
  if (!row) return 0;
  await db.delete(msDriveItems).where(eq(msDriveItems.id, row.id));

  // Delete the node only if no other drive item references it. If it's also an
  // email attachment, the FK is `restrict` — the delete throws and we leave it.
  const [other] = await db
    .select({ id: msDriveItems.id })
    .from(msDriveItems)
    .where(eq(msDriveItems.nodeId, row.nodeId))
    .limit(1);
  if (!other) {
    try {
      await db.delete(nodes).where(eq(nodes.id, row.nodeId));
    } catch {
      // Referenced elsewhere (restrict) — leave the node in place.
    }
  }
  return 1;
}

export async function syncDrive(account: MsAccount, drive: MsDrive): Promise<DriveSyncResult> {
  const ownerId = account.userId;
  const branchPath = `${account.branchPath}.${drive.branchLabel}`;
  const source = drive.siteName ? 'sharepoint' : 'onedrive';
  const start = drive.deltaLink ?? `/drives/${drive.driveId}/root/delta`;

  const { items, deltaLink } = await graphGetAll<DriveItem>(ownerId, account.id, start);

  let scanned = 0;
  let ingested = 0;
  let removed = 0;

  for (const item of items) {
    if (item.root) continue; // the drive root itself
    scanned++;

    if (item.deleted) {
      removed += await removeItem(drive.id, item.id);
      continue;
    }
    if (item.folder || !item.file) continue; // folders + non-file packages: skipped (flat v1)
    // Skip oversized files — they'd load fully into worker memory. Bounded sync
    // only; raise the cap or stream if large media must be ingested.
    if (typeof item.size === 'number' && item.size > MAX_UPLOAD_BYTES) continue;

    const [seen] = await db
      .select({ id: msDriveItems.id, etag: msDriveItems.etag })
      .from(msDriveItems)
      .where(and(eq(msDriveItems.driveDbId, drive.id), eq(msDriveItems.itemId, item.id)))
      .limit(1);
    // Unchanged since last sync — skip the (re)download.
    if (seen && item.eTag && seen.etag === item.eTag) continue;

    const bytes = await downloadItem(ownerId, account.id, drive.driveId, item);
    if (!bytes) continue;

    const stored = await storeRemoteFileAsNode({
      ownerId,
      path: branchPath,
      filename: item.name ?? 'file',
      mimeType: item.file.mimeType,
      bytes,
      source,
    });
    const lastModified = item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : null;

    if (seen) {
      await db
        .update(msDriveItems)
        .set({
          nodeId: stored.nodeId,
          etag: item.eTag ?? null,
          webUrl: item.webUrl ?? null,
          nodePath: branchPath,
          lastModified,
          updatedAt: new Date(),
        })
        .where(eq(msDriveItems.id, seen.id));
    } else {
      await db
        .insert(msDriveItems)
        .values({
          accountId: account.id,
          driveDbId: drive.id,
          nodeId: stored.nodeId,
          itemId: item.id,
          etag: item.eTag ?? null,
          webUrl: item.webUrl ?? null,
          nodePath: branchPath,
          lastModified,
        })
        .onConflictDoNothing({ target: [msDriveItems.driveDbId, msDriveItems.itemId] });
    }
    ingested++;
  }

  await db
    .update(msDrives)
    .set({ deltaLink: deltaLink ?? drive.deltaLink, lastSyncAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(msDrives.id, drive.id));

  return { scanned, ingested, removed };
}
