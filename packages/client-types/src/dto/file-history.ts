/**
 * File history (docs/files.md, "File history"): what the client reads back
 * from the upload when a name is taken, and from the history routes.
 *
 *  - POST /api/files/files (multipart, no `replace`): a name already in the
 *    folder with the SAME bytes answers 200 `UploadSkippedResponse`
 *    ("Already here"); with other bytes 409 `UploadClashResponse`, so the
 *    client can ask Override / Override all / Skip / Skip all. Override is
 *    the same upload again with `replace=true`.
 *  - GET    /api/files/files/:id/history            FileHistoryResponse
 *  - GET    /api/files/files/:id/history/:sid/download   the bytes
 *  - POST   /api/files/files/:id/history/:sid/restore    FileRestoreResponse
 *  - DELETE /api/files/files/:id/history/:sid            { ok: true }
 *
 * Reading the history and downloading a version: whoever reads the file.
 * Restore and delete of a version: a Moderator of the file's workspace, a
 * Moderator of a workspace that holds it, or an Admin user (never a plain
 * user with Write on): `FileHistoryRights.mayRestore`.
 */

/** Why a version was kept: new bytes replaced it (an upload with replace,
 *  an edit, an export saved again), or a restore did. */
export type FileVersionTrigger = 'replace' | 'pre_restore';

/** One kept version of a file, newest first in a list. */
export type FileVersion = {
  /** The version's id (the `:sid` of its routes). */
  id: string;
  /** v1, v2 ... per file, never reused. */
  seq: number;
  trigger: FileVersionTrigger;
  /** When these bytes stopped being the file's (ISO). */
  createdAt: string;
  sizeBytes: number;
  sha256: string | null;
  /** The file's name when these bytes were its. */
  filename: string | null;
  /** Who replaced them: HISTORY_ACTORS (@mantle/client-types/role-names). */
  actor: string;
  /** A `pre_restore` version: the seq the restore put back. */
  restoredFrom: number | null;
};

/** What the caller may do with the versions. */
export type FileHistoryRights = {
  /** Restore a version, and delete one. */
  mayRestore: boolean;
};

/** GET /api/files/files/:id/history. */
export type FileHistoryResponse = {
  versions: FileVersion[];
  rights: FileHistoryRights;
};

/** POST /api/files/files/:id/history/:sid/restore: the file as it is now
 *  (the restored bytes), and the version restored. The bytes it replaced
 *  are kept as a new `pre_restore` version, so a restore is undone by
 *  restoring that one. */
export type FileRestoreResponse = {
  /** The file row (as GET /api/files/files/:id answers `file`). */
  file: { id: string; sha256: string | null; sizeBytes: number; filename: string };
  restored: FileVersion;
};

/** The file already in the folder under the uploaded name. */
export type UploadExistingFile = {
  id: string;
  sha256: string | null;
  sizeBytes: number;
  name: string;
};

/** 200 from the upload: the same bytes are already there under that name.
 *  Nothing was written. */
export type UploadSkippedResponse = {
  skipped: true;
  reason: 'same-bytes';
  existing: Pick<UploadExistingFile, 'id' | 'sha256'>;
};

/** 409 from the upload: the name is taken by other bytes. */
export type UploadClashResponse = {
  error: string;
  reason: 'name-taken';
  existing: UploadExistingFile;
};
