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
import { deleteFileWithDerived } from '@mantle/content';
import { getValidAccessToken } from '../token-store';
import { graphFetchRaw, graphGetAll } from '../client';
import { listScopes } from './scope';
import { classifyDriveItem } from './classify';
import { storeRemoteFileAsNode } from './store';
import type { DriveItem } from './types';

export interface DriveSyncResult {
  scanned: number;
  ingested: number;
  removed: number;
  /** Predecessor nodes retired because a re-sync replaced them. */
  superseded: number;
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
    const res = await graphFetchRaw(
      `${GRAPH_BASE}/drives/${driveId}/items/${item.id}/content`,
      token,
    );
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

/**
 * Retire the node a re-sync just replaced. `storeRemoteFileAsNode` dedupes on
 * sha256, so CHANGED bytes always insert a fresh node — and before this, the
 * update branch below repointed the mapping and walked away, stranding the
 * predecessor forever. The auto-table pass compounds it: its dedupe is keyed on
 * `data.sourceFileId`, so a new file node is never recognised as the same
 * document and earns a second table. One weekly-edited workbook was observed
 * having accreted 47 file nodes and 47 identically-named tables this way.
 *
 * Two guards, both mirroring `removeItem`: never touch a node the sha256 dedupe
 * just handed back unchanged (bytes reverted to an earlier version), and never
 * touch one another drive item still maps to. Best-effort — `deleteFileWithDerived`
 * reports refusals (email attachment, in-use drawing) rather than throwing, and a
 * node left behind stays visible to the integrity audit, which beats aborting a
 * whole sync run over cleanup.
 *
 * Call order matters: this runs AFTER the mapping update, so the row we just
 * repointed no longer counts as another referrer.
 *
 * @internal Exported for `sync.retire.test.ts` only — the two guards below are
 * the difference between cleanup and data loss, so they get direct coverage.
 * Not re-exported from the package index.
 */
export async function retireSupersededNode(
  ownerId: string,
  oldNodeId: string,
  newNodeId: string,
): Promise<number> {
  if (oldNodeId === newNodeId) return 0;
  const [other] = await db
    .select({ id: msDriveItems.id })
    .from(msDriveItems)
    .where(eq(msDriveItems.nodeId, oldNodeId))
    .limit(1);
  if (other) return 0;
  try {
    const res = await deleteFileWithDerived(ownerId, oldNodeId);
    return res.ok ? 1 : 0;
  } catch {
    return 0;
  }
}

export async function syncDrive(account: MsAccount, drive: MsDrive): Promise<DriveSyncResult> {
  const ownerId = account.userId;
  const branchPath = `${account.branchPath}.${drive.branchLabel}`;
  const source = drive.siteName ? 'sharepoint' : 'onedrive';
  const start = drive.deltaLink ?? `/drives/${drive.driveId}/root/delta`;

  const { items, deltaLink } = await graphGetAll<DriveItem>(ownerId, account.id, start);
  const scopes = await listScopes(drive.id);

  let scanned = 0;
  let ingested = 0;
  let removed = 0;
  let superseded = 0;

  for (const item of items) {
    // The per-item verdict (skip / remove / ingest) lives in classifyDriveItem
    // so it's unit-tested away from the DB. Comments there explain each branch:
    // tombstones + out-of-scope files are pruned; scope changes clear delta_link
    // so a full re-walk applies scoping to every live item, not just changed ones.
    const action = classifyDriveItem(item, scopes, MAX_UPLOAD_BYTES);
    if (action === 'skip-root') continue; // the drive root itself (not counted)
    scanned++;

    if (action === 'remove-deleted' || action === 'remove-out-of-scope') {
      removed += await removeItem(drive.id, item.id);
      continue;
    }
    if (action === 'skip-nonfile' || action === 'skip-oversize') continue;

    const [seen] = await db
      .select({ id: msDriveItems.id, etag: msDriveItems.etag, nodeId: msDriveItems.nodeId })
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
      // action === 'consider' guarantees a file facet (see classifyDriveItem);
      // the optional chain keeps the compiler happy without re-checking.
      mimeType: item.file?.mimeType,
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
      superseded += await retireSupersededNode(ownerId, seen.nodeId, stored.nodeId);
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
    .set({
      deltaLink: deltaLink ?? drive.deltaLink,
      lastSyncAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(msDrives.id, drive.id));

  return { scanned, ingested, removed, superseded };
}
