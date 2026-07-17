/**
 * The per-item decision at the heart of drive sync: for one driveItem in a
 * delta page, decide whether it is ingested, removed, or skipped. Lifted out of
 * `syncDrive`'s loop so the create/update/DELETE branching — the data-affecting
 * part — is unit-testable without a live DB (the loop's I/O around it still is
 * exercised only in integration). Pure and side-effect-free.
 *
 * Order matters and mirrors the original loop exactly:
 *   1. the drive root pseudo-item is skipped outright (not even counted);
 *   2. tombstones remove, BEFORE the folder/file check — a `deleted` item may
 *      not carry a folder/file facet;
 *   3. folders + non-file packages are skipped (flat v1 layout);
 *   4. live files outside the saved scope selection are removed (prunes items
 *      that were ingested before scoping, or moved out of a scoped folder);
 *   5. oversized files are skipped (they'd load fully into worker memory);
 *   6. anything left is a candidate → the caller does the etag/download/upsert.
 */
import { inScope } from './scope';
import type { DriveItem } from './types';
import type { MsDriveScope } from '@mantle/db';

export type DriveItemAction =
  | 'skip-root'
  | 'remove-deleted'
  | 'skip-nonfile'
  | 'remove-out-of-scope'
  | 'skip-oversize'
  | 'consider';

export function classifyDriveItem(
  item: DriveItem,
  scopes: Pick<MsDriveScope, 'itemId' | 'path' | 'isFolder'>[],
  maxBytes: number,
): DriveItemAction {
  if (item.root) return 'skip-root';
  if (item.deleted) return 'remove-deleted';
  if (item.folder || !item.file) return 'skip-nonfile';
  if (!inScope(scopes, item)) return 'remove-out-of-scope';
  if (typeof item.size === 'number' && item.size > maxBytes) return 'skip-oversize';
  return 'consider';
}
