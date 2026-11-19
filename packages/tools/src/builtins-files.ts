/**
 * Builtins: file_* and folder_*: the file tree. builtins.ts assembles
 * BUILTIN_TOOLS from these groups.
 *
 * FILE_OPERATOR_TOOLS at the bottom create and DESTROY tree entries, and no
 * in-app group grants them, so they are `mcpOnly`: only the owner's own
 * client can call them.
 */

import type { BuiltinToolDef } from './types';
import { folder_list, file_list, file_read, file_get, folder_get_by_path } from './files/read';
import {
  file_create,
  file_rename,
  folder_rename,
  folder_describe,
  file_set_indexing,
  folder_set_indexing,
} from './files/write';
import { file_move, file_copy, folder_move, folder_copy } from './files/organise';
import { folder_create, folder_delete, file_upload, file_delete } from './files/operator';
export { FILE_HISTORY_TOOLS } from './files/history';
import { file_processing } from './files/processing';
import { file_reindex } from './files/reindex';
import { file_stale_list } from './files/stale';
import { file_extract_archive } from './files/extract-archive';
export { folder_list, file_list, file_read, file_get, folder_get_by_path } from './files/read';
export {
  file_create,
  file_rename,
  folder_rename,
  folder_describe,
  file_set_indexing,
  folder_set_indexing,
} from './files/write';
export { file_move, file_copy, folder_move, folder_copy } from './files/organise';
export { folder_create, folder_delete, file_upload, file_delete } from './files/operator';
export { file_processing, fileProcessing } from './files/processing';
export { file_reindex, reindexFiles, reindexIdsOf } from './files/reindex';
export { file_stale_list, fileStaleList } from './files/stale';
export {
  archiveExtractAnswer,
  archiveExtractViewOf,
  extractArchive,
  file_extract_archive,
} from './files/extract-archive';

/** File-tree reads + renames (the writes/moves are FILE_MANAGE_TOOLS, creation FILE_CREATE_TOOLS). */
export const FILE_TOOLS: readonly BuiltinToolDef[] = [
  folder_list,
  file_list,
  file_get,
  file_read,
  file_rename,
  folder_rename,
  folder_describe,
];

/** What the brain did with one file and where its content went (the
 *  Details panel's answer, GET /api/files/files/:id/processing). */
export const FILE_PROCESSING_TOOLS: readonly BuiltinToolDef[] = [file_processing];

/** Read files again through the whole pipeline, and the list of the files
 *  that need it (docs/files.md, "Reindex and stale indexes"). */
export const FILE_REINDEX_TOOLS: readonly BuiltinToolDef[] = [file_reindex, file_stale_list];

/** An archive's "Extract contents", only on a person's ask (docs/files.md,
 *  "Archives"). */
export const FILE_EXTRACT_TOOLS: readonly BuiltinToolDef[] = [file_extract_archive];

/** Create a file from text, and resolve a folder by its path. */
export const FILE_CREATE_TOOLS: readonly BuiltinToolDef[] = [file_create, folder_get_by_path];

export const FILE_MANAGE_TOOLS: readonly BuiltinToolDef[] = [
  file_move,
  file_copy,
  folder_move,
  folder_copy,
  file_set_indexing,
  folder_set_indexing,
];

// ─── owner-operator surface (mcpOnly) ────────────────────────────────────────

/** Create and destroy tree entries — MCP-only, never granted. */
export const FILE_OPERATOR_TOOLS: readonly BuiltinToolDef[] = [
  folder_create,
  folder_delete,
  file_upload,
  file_delete,
];
