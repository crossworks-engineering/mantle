/**
 * Disk operations for the forum-upload QUARANTINE — member-uploaded bytes
 * held outside the files ltree until the owner reviews them (see the
 * forum_uploads table in @mantle/db for the lifecycle).
 *
 * Bytes are keyed `<quarantineRoot>/<ownerId>/<uploadId>` — both segments are
 * server-minted uuids, never user input, and are validated here anyway so a
 * corrupted id can't traverse. Like disk.ts, none of these touch the DB;
 * callers compose them with the forum_uploads row lifecycle in a handler.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { quarantineRoot } from './paths';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Absolute path for one quarantined blob. Throws on a non-uuid segment —
 *  ids are server-minted, so a mismatch is a bug, not a user error. */
export function quarantinePathFor(ownerId: string, uploadId: string): string {
  if (!UUID_RE.test(ownerId) || !UUID_RE.test(uploadId)) {
    throw new Error('quarantine: ids must be uuids');
  }
  return path.join(quarantineRoot(), ownerId.toLowerCase(), uploadId.toLowerCase());
}

/** Persist a quarantined blob (mkdir -p on the owner dir). Overwrites — the
 *  uploadId is freshly minted per stage, so a collision is only ever a retry
 *  of the same write. */
export async function writeQuarantineBytes(
  ownerId: string,
  uploadId: string,
  bytes: Buffer,
): Promise<void> {
  const p = quarantinePathFor(ownerId, uploadId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, bytes);
}

/** Read a quarantined blob, or null when the bytes are gone (swept / filed /
 *  dismissed already — the row's status is the source of truth, this is the
 *  fail-safe for the race). */
export async function readQuarantineBytes(
  ownerId: string,
  uploadId: string,
): Promise<Buffer | null> {
  try {
    return await fs.readFile(quarantinePathFor(ownerId, uploadId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Delete a quarantined blob. Idempotent — missing bytes are fine (sweep and
 *  review can race; whoever loses finds nothing to delete). */
export async function deleteQuarantineBytes(ownerId: string, uploadId: string): Promise<void> {
  try {
    await fs.unlink(quarantinePathFor(ownerId, uploadId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
