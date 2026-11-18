/**
 * File history (docs/files.md, "File history"): the versions a file keeps
 * when new bytes replace it. The store is @mantle/files file-history.ts.
 * Listing is for whoever reads the file. Restore and delete of a version are
 * a Moderator's (a Moderator of the file's workspace, of a workspace that
 * holds it, or an Admin), as by hand: the library asks it in the caller's
 * scope, the same check the routes ask. Restore and delete are
 * confirm-gated for an in-brain agent, as a table's are.
 */
import {
  deleteFileVersion,
  listFileVersions,
  mayModerateFile,
  restoreFileVersion,
} from '@mantle/files';
import { errorMessage } from '@mantle/std';
import type { BuiltinToolDef } from '../types';
import { str } from '../coerce';
import { notFound } from '../errors';
import { FILE_ID_PRE } from '../builtins-common';
import { CS } from '../client-sourced-rule';

const FILE_ID = {
  type: 'string',
  format: 'uuid',
  description: "The file's id (UUID) - from `file_list` / `search_nodes`.",
};
const VERSION_ID = {
  type: 'string',
  format: 'uuid',
  description: 'The version id, from `file_history_list`.',
};

/** The cells cannot stand up a kept version: it needs bytes an overwrite
 *  kept on disk. The rights are held by the route cells of
 *  /api/files/files/:id/history/:sid and file-history.db.test.ts. */
const NO_VERSION_IN_CELLS =
  'a kept version needs bytes an overwrite kept on disk, which the cells do not make; the route cells (POST and DELETE /api/files/files/:id/history/:sid) and file-history.db.test.ts hold its rights (a Moderator, never a plain user with Write on)';

export const file_history_list: BuiltinToolDef = {
  slug: 'file_history_list',
  policy: {
    matrix: { action: 'read', param: 'file_id', kinds: ['file'] },
    effect: 'read',
    spends: 'none',
    scope: 'any',
    keyArea: 'files',
  },
  preconditions: FILE_ID_PRE,
  name: "List a file's versions",
  description:
    'List the versions a file kept, newest first: each time new bytes replaced it (an upload with replace, an edit, an export saved again) the bytes they replaced were kept (`replace`), and a restore keeps the bytes it replaced (`pre_restore`). Each has its id, seq (v1, v2 ...), when, who, its size, sha256 and the name the file had. `mayRestore` says whether you may restore or delete one. Use it to find the version to pass to `file_history_restore`.',
  inputSchema: {
    type: 'object',
    properties: { file_id: FILE_ID },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    if (!fileId) return { ok: false, error: 'file_id is required' };
    try {
      const [versions, may] = await Promise.all([
        listFileVersions(ctx.ownerId, fileId),
        mayModerateFile(fileId),
      ]);
      if (may === null) return notFound('file', fileId, 'file_list / search_nodes');
      ctx.step?.setOutput({ fileId, count: versions.length });
      return { ok: true, output: { file_id: fileId, versions, mayRestore: may } };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const file_history_restore: BuiltinToolDef = {
  slug: 'file_history_restore',
  policy: {
    matrix: { none: NO_VERSION_IN_CELLS },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'file_id' }],
    peerRisky: true,
    keyArea: 'files',
    clientSourced: CS.onNodes('file_id'),
  },
  requiresConfirm: true,
  preconditions: FILE_ID_PRE,
  name: 'Restore a version of a file',
  description:
    "Put a version from `file_history_list` back: its bytes become the file's again (same file id, so links hold), and the file is read again. The bytes it replaces are kept as a new version, so a restore is undone by restoring that one. For a Moderator of the file's workspace, of a workspace that holds it, or an Admin. Confirm with the user first.",
  inputSchema: {
    type: 'object',
    properties: { file_id: FILE_ID, version_id: VERSION_ID },
    required: ['file_id', 'version_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    const versionId = str(input.version_id).trim();
    if (!fileId || !versionId) return { ok: false, error: 'file_id and version_id are required' };
    try {
      const res = await restoreFileVersion(ctx.ownerId, fileId, versionId);
      if (!res) {
        return {
          ok: false,
          error: `file ${fileId} or version ${versionId} not found: list the versions with file_history_list`,
        };
      }
      ctx.step?.setOutput({ fileId, restored: res.restored.seq });
      return {
        ok: true,
        output: {
          file_id: fileId,
          restored: res.restored,
          sha256: res.file.sha256,
          size_bytes: res.file.sizeBytes,
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const file_history_delete: BuiltinToolDef = {
  slug: 'file_history_delete',
  policy: {
    riskClass: 'delete', // removes a kept version
    destructive: true, // that version cannot be restored after
    matrix: { none: NO_VERSION_IN_CELLS },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'file_id' }],
    peerRisky: true,
    keyArea: 'files',
    clientSourced: CS.onNodes('file_id'),
  },
  requiresConfirm: true,
  preconditions: FILE_ID_PRE,
  name: 'Delete a version of a file',
  description:
    "Delete one version from a file's history (`file_history_list`) and its kept bytes, to free space. That version cannot be restored after. The file itself is not touched. For a Moderator of the file's workspace, of a workspace that holds it, or an Admin. Confirm with the user first.",
  inputSchema: {
    type: 'object',
    properties: { file_id: FILE_ID, version_id: VERSION_ID },
    required: ['file_id', 'version_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    const versionId = str(input.version_id).trim();
    if (!fileId || !versionId) return { ok: false, error: 'file_id and version_id are required' };
    try {
      const gone = await deleteFileVersion(ctx.ownerId, fileId, versionId);
      if (!gone) {
        return {
          ok: false,
          error: `version ${versionId} is not on file ${fileId}'s history: list them with file_history_list`,
        };
      }
      ctx.step?.setOutput({ fileId, deleted: versionId });
      return { ok: true, output: { file_id: fileId, deleted: versionId } };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

/** A file's history: list, restore, delete a version. */
export const FILE_HISTORY_TOOLS: readonly BuiltinToolDef[] = [
  file_history_list,
  file_history_restore,
  file_history_delete,
];
