/**
 * The brain's half of the Sync service's file sync (Sync service plan M3;
 * docs/services.md "Sync"). The sidecar lists a drive (rclone), compares the
 * list with the file map (sync_items, 0382) and hands the brain each new or
 * changed file as a stream. Here the file becomes an ordinary `file` node,
 * as before M4: one node per (owner, sha256), the bytes in the object store,
 * flat under the drive's branch, so the normal ingest reads it.
 *
 * Every function runs inside asSidecar (the system actor worker:sync).
 */
import { promises as fs } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  deleteSyncItems,
  getSyncItem,
  nodes,
  putSyncItem,
  syncItemsUseNode,
  withDeadlockRetry,
  withNodeInsertHeads,
  type NewNode,
} from '@mantle/db';
import { deleteFileWithDerived } from '@mantle/content';
import { ensureBranchPath } from '@mantle/email';
import { extOf, mimeForExt, sanitizeFilename, type SpooledUpload } from '@mantle/files';
import { stageFileObject } from '@mantle/files/broker';

/** The service whose rows these are (one today). */
export const FILE_SERVICE = 'sync';

/** The `data.source` of a file node a drive sync made: 'sync' since M3,
 *  'onedrive' and 'sharepoint' before M4. A drive sync reuses and retires
 *  only these, never a file a person uploaded with the same bytes. */
export const SYNC_FILE_SOURCES = ['sync', 'onedrive', 'sharepoint'] as const;
const SOURCE_LIST = sql.join(
  SYNC_FILE_SOURCES.map((s) => sql`${s}`),
  sql`, `,
);

/** An ltree path a drive's files land at: 2 to 8 labels. */
export const FILE_PATH_RE = /^[a-z0-9_]{1,64}(\.[a-z0-9_]{1,64}){1,7}$/;

export type FileMeta = {
  source: string;
  itemId: string;
  path: string;
  name: string;
  mimeType?: string;
  hash: string | null;
  size: number | null;
  modTime: Date | null;
};

/** The owner's file node holding these exact bytes, made when none does.
 *  Whether it was there already. */
async function fileNodeFor(
  ownerId: string,
  meta: FileMeta,
  spooled: SpooledUpload,
): Promise<{ nodeId: string; deduped: boolean }> {
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.data}->>'sha256' = ${spooled.sha256}`,
        sql`${nodes.data}->>'source' in (${SOURCE_LIST})`,
      ),
    )
    .limit(1);
  if (existing) return { nodeId: existing.id, deduped: true };

  await ensureBranchPath(ownerId, meta.path);
  const mime = meta.mimeType || mimeForExt(extOf(meta.name)) || 'application/octet-stream';
  // The bytes first, under their content address (the files store's
  // broker): the object is the stage, the node's INSERT below the flip.
  // A file here is at most MAX_UPLOAD_BYTES (the route's ceiling).
  await stageFileObject(await fs.readFile(spooled.tempPath), mime);
  const title = sanitizeFilename(meta.name) ?? 'file';
  const [row] = await withDeadlockRetry(() =>
    withNodeInsertHeads(ownerId, [{ type: 'file', path: meta.path }], (tx) =>
      tx
        .insert(nodes)
        .values({
          ownerId,
          type: 'file',
          title,
          path: meta.path,
          // No `data.filename`, as before M4 and as a mail attachment: the
          // node is content-addressed, so two drive files may share a name
          // under one drive branch.
          data: {
            sha256: spooled.sha256,
            mimeType: mime,
            sizeBytes: spooled.size,
            source: 'sync',
          },
        } as NewNode)
        .returning({ id: nodes.id }),
    ),
  );
  if (!row) throw new Error('insert into nodes (file) returned no row');
  return { nodeId: row.id, deduped: false };
}

/** Retire a file node no map row points at any more (a changed file's old
 *  bytes, a file gone from its drive). A node something else holds (a mail
 *  attachment, a drawing) is kept: deleteFileWithDerived refuses it. */
async function retireNode(ownerId: string, nodeId: string): Promise<boolean> {
  if (await syncItemsUseNode(nodeId)) return false;
  const [own] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), sql`${nodes.data}->>'source' in (${SOURCE_LIST})`))
    .limit(1);
  if (!own) return false;
  try {
    return (await deleteFileWithDerived(ownerId, nodeId)).ok;
  } catch {
    return false;
  }
}

/** One fetched file in: its node, its map row, and the node it replaced
 *  retired. */
export async function storeSyncedFile(
  ownerId: string,
  meta: FileMeta,
  spooled: SpooledUpload,
): Promise<{ nodeId: string; deduped: boolean; retired: boolean }> {
  const { nodeId, deduped } = await fileNodeFor(ownerId, meta, spooled);
  const before = await getSyncItem(FILE_SERVICE, meta.source, meta.itemId);
  await putSyncItem(FILE_SERVICE, meta.source, {
    itemId: meta.itemId,
    nodeId,
    hash: meta.hash,
    size: meta.size ?? spooled.size,
    modTime: meta.modTime,
  });
  // After the map update, so the row just moved no longer holds the old node.
  const retired =
    !!before && before.nodeId !== nodeId ? await retireNode(ownerId, before.nodeId) : false;
  return { nodeId, deduped, retired };
}

/** Items the map knows whose file is unchanged: take the listing's hash,
 *  size and time, keep the node. How many rows moved. */
export async function relinkSyncedFiles(
  source: string,
  items: { itemId: string; hash: string | null; size: number | null; modTime: Date | null }[],
): Promise<number> {
  let n = 0;
  for (const it of items) {
    const row = await getSyncItem(FILE_SERVICE, source, it.itemId);
    if (!row) continue;
    await putSyncItem(FILE_SERVICE, source, { ...it, nodeId: row.nodeId });
    n++;
  }
  return n;
}

/** Items gone from their drive (or out of its selection): their map rows,
 *  and each node no other row holds. How many rows and nodes went. */
export async function removeSyncedFiles(
  ownerId: string,
  source: string,
  itemIds: string[],
): Promise<{ removed: number; retired: number }> {
  const nodeIds = await deleteSyncItems(FILE_SERVICE, source, itemIds);
  let retired = 0;
  for (const id of new Set(nodeIds)) if (await retireNode(ownerId, id)) retired++;
  return { removed: nodeIds.length, retired };
}
