/**
 * The author's snapshot copy of an accepted item is read only for everyone,
 * its author included (docs/actors.md, "Who may do what"). It carries data.snapshot_of (the brain item it copies). Its
 * author may delete it; nobody edits it, moves it out of its private (or
 * Former user) workspace, or shares it. Migration 0267's triggers refuse
 * every such write in the database; the app refuses first with this error
 * (code 42501 and the database's own message, so isScopeWriteRefusal and
 * app.onError answer 403 item-workspace for both).
 */

/** The brain item a snapshot copy copies, or null for any other item. */
export function snapshotCopyOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const v = (data as Record<string, unknown>).snapshot_of;
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Whether an item row (its `data`) is a read-only snapshot copy. */
export function isSnapshotCopy(node: { data?: unknown } | null | undefined): boolean {
  return snapshotCopyOf(node?.data) !== null;
}

export const SNAPSHOT_COPY_READ_ONLY_MESSAGE =
  'not allowed to change this item: it is a read-only snapshot copy';

/** Why a snapshot copy carries no link and no contact share: the
 *  database's own words (0267, shares_snapshot_copy). */
export const SNAPSHOT_COPY_NO_SHARE =
  'not allowed to share this item: it is a read-only snapshot copy in its private workspace';

/** A write to a snapshot copy, refused before it reaches the database. */
export class SnapshotCopyReadOnlyError extends Error {
  readonly code = '42501';
  constructor() {
    super(SNAPSHOT_COPY_READ_ONLY_MESSAGE);
    this.name = 'SnapshotCopyReadOnlyError';
  }
}

/** Throw SnapshotCopyReadOnlyError when `node` is a snapshot copy. */
export function assertNotSnapshotCopy(node: { data?: unknown } | null | undefined): void {
  if (isSnapshotCopy(node)) throw new SnapshotCopyReadOnlyError();
}
