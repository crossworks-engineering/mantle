/**
 * Moving and copying files and folders around the tree.
 *
 * Split out of builtins-files.ts; bodies moved verbatim.
 */

import { moveFileById, moveFolderById, copyFileById, copyFolderById } from '@mantle/files';
import { type BuiltinToolDef } from '../types';
import { str } from '../coerce';
import { errorMessage } from '@mantle/std';
import { FILE_ID_PRE, FOLDER_ID_PRE } from '../builtins-common';

export const file_move: BuiltinToolDef = {
  slug: 'file_move',
  name: 'Move a file',
  description:
    'Move ONE file to another folder; the filename travels unchanged (use `file_rename` to change the name). The file keeps its id, shares, and history. If the destination folder indexes differently (name-only vs full), the file is automatically re-indexed to match where it lands. Refuses when the destination already has a file by that name. To duplicate instead of relocate, use `file_copy`.',
  preconditions: FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The file's id (UUID) — from `file_list` / `search_nodes`.",
      },
      dest_path: {
        type: 'string',
        description: "Destination FOLDER ltree path, e.g. 'files.archive.2026'.",
      },
    },
    required: ['file_id', 'dest_path'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    const destPath = str(input.dest_path);
    if (!fileId || !destPath) return { ok: false, error: 'file_id and dest_path required' };
    try {
      const row = await moveFileById({ ownerId: ctx.ownerId, fileId, destPath });
      ctx.step?.setOutput({ fileId, destPath });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const file_copy: BuiltinToolDef = {
  slug: 'file_copy',
  name: 'Copy a file',
  description:
    "Copy ONE file into another folder — a genuinely NEW file with its own id and its own indexing under the destination folder's mode; nothing links it to the original. Pass `new_filename` to copy under a different name (the way past a name clash). To relocate rather than duplicate, use `file_move`.",
  preconditions: FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The source file's id (UUID) — from `file_list` / `search_nodes`.",
      },
      dest_path: {
        type: 'string',
        description: "Destination FOLDER ltree path, e.g. 'files.work.reports'.",
      },
      new_filename: {
        type: 'string',
        description: "Optional name for the copy, e.g. 'report-v2.pdf'; defaults to the source's.",
      },
    },
    required: ['file_id', 'dest_path'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    const destPath = str(input.dest_path);
    const newFilename = str(input.new_filename) || undefined;
    if (!fileId || !destPath) return { ok: false, error: 'file_id and dest_path required' };
    try {
      const row = await copyFileById({ ownerId: ctx.ownerId, fileId, destPath, newFilename });
      ctx.step?.setOutput({ sourceId: fileId, newId: row.id });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const folder_move: BuiltinToolDef = {
  slug: 'folder_move',
  name: 'Move a folder',
  description:
    'Move a folder — its whole subtree included — under another parent folder. The folder keeps its name (use `folder_rename` to change it), every file keeps its id, and files whose new location indexes differently (name-only vs full) are re-indexed automatically; the result reports how many. Refuses to move a folder into its own subtree or onto a name clash.',
  preconditions: FOLDER_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      folder_id: {
        type: 'string',
        format: 'uuid',
        description: "The folder's id (UUID) — from `folder_list` / `folder_get_by_path`.",
      },
      dest_parent_path: {
        type: 'string',
        description: "The NEW PARENT folder's ltree path, e.g. 'files.archive'.",
      },
    },
    required: ['folder_id', 'dest_parent_path'],
  },
  handler: async (input, ctx) => {
    const folderId = str(input.folder_id);
    const destParentPath = str(input.dest_parent_path);
    if (!folderId || !destParentPath)
      return { ok: false, error: 'folder_id and dest_parent_path required' };
    try {
      const { folder, requeued } = await moveFolderById({
        ownerId: ctx.ownerId,
        folderId,
        destParentPath,
      });
      ctx.step?.setOutput({ folderId, destParentPath, requeued });
      return { ok: true, output: { folder, requeued } };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const folder_copy: BuiltinToolDef = {
  slug: 'folder_copy',
  name: 'Copy a folder',
  description:
    'Copy a folder — subtree included — under another parent. Every copy is a NEW file that re-indexes under the destination, so this costs extraction in proportion to the file count and refuses above 200 files (copy subfolders individually, or flag the destination name-only first to make the copy index-free). To relocate without duplicating, use `folder_move`.',
  preconditions: FOLDER_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      folder_id: {
        type: 'string',
        format: 'uuid',
        description: "The source folder's id (UUID) — from `folder_list` / `folder_get_by_path`.",
      },
      dest_parent_path: {
        type: 'string',
        description: "The parent folder to copy INTO, e.g. 'files.backups'.",
      },
    },
    required: ['folder_id', 'dest_parent_path'],
  },
  handler: async (input, ctx) => {
    const folderId = str(input.folder_id);
    const destParentPath = str(input.dest_parent_path);
    if (!folderId || !destParentPath)
      return { ok: false, error: 'folder_id and dest_parent_path required' };
    try {
      const result = await copyFolderById({ ownerId: ctx.ownerId, folderId, destParentPath });
      ctx.step?.setOutput({
        folderId,
        copiedFiles: result.copiedFiles,
        copiedFolders: result.copiedFolders,
      });
      return { ok: true, output: result };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

// ─── telegram ─────────────────────────────────────────────────────────────

// ─── system / triggers ────────────────────────────────────────────────────
