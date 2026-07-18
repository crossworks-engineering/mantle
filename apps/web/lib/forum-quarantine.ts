/**
 * Quarantine housekeeping for forum uploads — the disk-GC the store can't do
 * alone (it composes @mantle/content row queries with @mantle/files disk ops).
 *
 * Called opportunistically (fire-and-forget) from BOTH sides of the lifecycle:
 * the member upload route (so active members keep it clean) and the owner
 * review surface load (so a brain whose members stopped uploading is still
 * reclaimed while the owner reviews). Neither path blocks on it.
 */
import { deleteStaleStagedForumUploads, listForumUploadStatusesByIds } from '@mantle/content';
import { deleteQuarantineBytes, listQuarantineBlobIds } from '@mantle/files';

/**
 * Reclaim quarantine bytes that no live upload needs:
 *   1. staged rows older than 24h whose post never happened — deleted
 *      atomically (status-guarded), then their bytes unlinked;
 *   2. any byte file on disk whose row is absent (topic/post cascade-deleted
 *      the row) or already reviewed (filed/dismissed — bytes should have been
 *      unlinked at review time; this closes the mark-then-crash window).
 * Idempotent and best-effort — every unlink tolerates already-gone bytes.
 * Returns a small summary for logging.
 */
export async function reconcileForumQuarantine(
  ownerId: string,
): Promise<{ sweptStaged: number; reclaimedOrphans: number }> {
  // 1. Atomic staged sweep (the DELETE serializes against concurrent binds).
  const swept = await deleteStaleStagedForumUploads(ownerId);
  for (const { id } of swept) await deleteQuarantineBytes(ownerId, id);

  // 2. Disk ↔ row reconcile: unlink bytes for anything not staged/pending.
  const onDisk = await listQuarantineBlobIds(ownerId);
  let reclaimedOrphans = 0;
  if (onDisk.length > 0) {
    const statuses = await listForumUploadStatusesByIds(ownerId, onDisk);
    for (const id of onDisk) {
      const status = statuses.get(id);
      if (status === 'staged' || status === 'pending') continue; // live — keep
      await deleteQuarantineBytes(ownerId, id);
      reclaimedOrphans++;
    }
  }
  return { sweptStaged: swept.length, reclaimedOrphans };
}
