/**
 * Builtins: file_* and folder_* — the file tree.
 *
 * Split out of builtins.ts on 2026-09-02 (audit, bloat B6) with behaviour
 * unchanged; builtins.ts assembles BUILTIN_TOOLS from these groups.
 *
 * FILE_OPERATOR_TOOLS at the bottom were hand-written MCP tools until tier 3
 * of the same audit. They create and DESTROY tree entries, and no in-app group
 * has ever granted them, so they are `mcpOnly`: one implementation, still only
 * the owner's own client can call them.
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
