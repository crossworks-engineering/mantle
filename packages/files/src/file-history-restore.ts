/**
 * Restore a kept version of a file (docs/files.md, "File history"): its bytes
 * become the file's again, through the one overwrite (upsertFile), so the
 * bytes they replace are kept as a `pre_restore` version (a restore is undone
 * by restoring that one), the file is read again as for any new bytes, and
 * every gate of an overwrite holds. Who may: a Moderator of the file
 * (assertMayModerateFile: manage, or a Moderator of a workspace that holds
 * it), asked first, before anything is read or copied.
 *
 * The version's file is copied (never linked) into the upload spool, hashed
 * on the way: the history keeps its own bytes whatever later happens to the
 * file in the tree, and bytes that no longer match their row are refused.
 *
 * Server-only (node:fs).
 */
import { createReadStream, existsSync } from 'node:fs';
import { ConflictError } from '@mantle/std';
import { discardSpooled, spoolUpload } from './disk';
import { assertMayModerateFile, fileVersion, type FileVersion } from './file-history';
import { upsertFile } from './ops/files';
import { fileById } from './ops/queries';
import type { FileRow } from './ops/shared';

/** The largest version a restore copies: any version (its bytes were a file
 *  once). The spool's own cap is for uploads, not for this. */
const NO_CAP = Number.MAX_SAFE_INTEGER;

/**
 * Put version `versionId` of file `fileId` back. Null when the file or the
 * version is not there for the caller's scope. Refused (the edit check's
 * 403) for a caller who reads the file but does not moderate it, and (409)
 * when the version's bytes are gone or do not match their row.
 */
export async function restoreFileVersion(
  ownerId: string,
  fileId: string,
  versionId: string,
): Promise<{ file: FileRow; restored: FileVersion } | null> {
  await assertMayModerateFile(fileId);
  const file = await fileById({ ownerId, fileId });
  if (!file) return null;
  const v = await fileVersion(ownerId, fileId, versionId);
  if (!v) return null;
  if (!v.abs || !existsSync(v.abs)) {
    throw new ConflictError(`v${v.seq} of this file is missing on the server`);
  }
  const spooled = await spoolUpload(createReadStream(v.abs), { maxBytes: NO_CAP });
  try {
    if (v.sha256 && spooled.sha256 !== v.sha256) {
      throw new ConflictError(`v${v.seq} of this file does not match its record on the server`);
    }
    const row = await upsertFile({
      ownerId,
      parentPath: file.parentPath,
      filename: file.filename,
      spooled,
      overwrite: true,
      restoreOf: { seq: v.seq },
    });
    const { abs: _abs, ...restored } = v;
    return { file: row, restored };
  } finally {
    await discardSpooled(spooled);
  }
}
