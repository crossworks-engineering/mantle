/**
 * The Sync service's file map (migration 0382; Sync service plan M3): which
 * file node each outside drive item became. The brain's sidecar routes are
 * the only callers (/api/sidecar/files, the service's own token).
 *
 * Runs on the system pool, outside every scope, as service-state.ts.
 */
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { runAsActor, systemActor } from './actor';
import { systemDb } from './gateway/handles';
import { syncItems, type SyncItemRow } from './schema/sync-items';

/** The most rows one page of a drive's map answers. */
export const SYNC_ITEMS_PAGE_MAX = 2000;

const ACTOR = systemActor('sync-items');

export type SyncItem = Pick<SyncItemRow, 'itemId' | 'nodeId' | 'hash' | 'size' | 'modTime'>;

/** One page of a drive's map, by item id, after `after`. */
export async function listSyncItems(
  service: string,
  source: string,
  after: string | null,
  limit = SYNC_ITEMS_PAGE_MAX,
): Promise<SyncItem[]> {
  return systemDb
    .select({
      itemId: syncItems.itemId,
      nodeId: syncItems.nodeId,
      hash: syncItems.hash,
      size: syncItems.size,
      modTime: syncItems.modTime,
    })
    .from(syncItems)
    .where(
      and(
        eq(syncItems.service, service),
        eq(syncItems.source, source),
        after === null ? undefined : gt(syncItems.itemId, after),
      ),
    )
    .orderBy(asc(syncItems.itemId))
    .limit(Math.min(Math.max(1, limit), SYNC_ITEMS_PAGE_MAX));
}

/** The map row of one item, or null. */
export async function getSyncItem(
  service: string,
  source: string,
  itemId: string,
): Promise<SyncItem | null> {
  const [row] = await systemDb
    .select({
      itemId: syncItems.itemId,
      nodeId: syncItems.nodeId,
      hash: syncItems.hash,
      size: syncItems.size,
      modTime: syncItems.modTime,
    })
    .from(syncItems)
    .where(
      and(
        eq(syncItems.service, service),
        eq(syncItems.source, source),
        eq(syncItems.itemId, itemId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Write one item's map row (a new item, or its node and hash after a fetch
 *  or a re-link). */
export async function putSyncItem(service: string, source: string, item: SyncItem): Promise<void> {
  await runAsActor(ACTOR, () =>
    systemDb
      .insert(syncItems)
      .values({ service, source, ...item })
      .onConflictDoUpdate({
        target: [syncItems.service, syncItems.source, syncItems.itemId],
        set: {
          nodeId: item.nodeId,
          hash: item.hash,
          size: item.size,
          modTime: item.modTime,
          updatedAt: sql`now()`,
        },
      }),
  );
}

/** Remove map rows; the node ids they pointed at. */
export async function deleteSyncItems(
  service: string,
  source: string,
  itemIds: string[],
): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const gone = await runAsActor(ACTOR, () =>
    systemDb
      .delete(syncItems)
      .where(
        and(
          eq(syncItems.service, service),
          eq(syncItems.source, source),
          inArray(syncItems.itemId, itemIds),
        ),
      )
      .returning({ nodeId: syncItems.nodeId }),
  );
  return gone.map((g) => g.nodeId);
}

/** Remove every map row of a source (a drive removed): its files stay. */
export async function deleteSyncSource(service: string, source: string): Promise<number> {
  const gone = await runAsActor(ACTOR, () =>
    systemDb
      .delete(syncItems)
      .where(and(eq(syncItems.service, service), eq(syncItems.source, source)))
      .returning({ itemId: syncItems.itemId }),
  );
  return gone.length;
}

/** Whether any map row still points at `nodeId`. */
export async function syncItemsUseNode(nodeId: string): Promise<boolean> {
  const [row] = await systemDb
    .select({ itemId: syncItems.itemId })
    .from(syncItems)
    .where(eq(syncItems.nodeId, nodeId))
    .limit(1);
  return !!row;
}
