/**
 * Files and folders. The bridged groups run the in-app handlers; the
 * hand-written verbs stay hand-written because their MCP argument names
 * differ from the builtin's (id vs file_id, path vs folder id) and renaming
 * them would break shipped connectors.
 *
 * Lifted out of registerMantleTools; bodies moved verbatim.
 */

import { z } from 'zod';
import {
  fileById,
  folderByPath,
  readFileById,
  renameFileById,
  renameFolderById,
  updateFolderDescription,
} from '@mantle/files';
import { FILE_MANAGE_TOOLS, FILE_OPERATOR_TOOLS } from '@mantle/tools';
import { errorMessage } from '@mantle/std';
import type { McpRegisterContext } from './context';

export function registerFileTools(ctx: McpRegisterContext): void {
  const { server, ownerId, jsonReply, registerBuiltinTools } = ctx;

  // ─── files / folders ──────────────────────────────────────────────────────

  // Create and destroy: bridged from `mcpOnly` builtins since tier 3 of the
  // 2026-09-02 audit. No in-app tool group grants these, so promoting them
  // shared the implementation without widening what any agent can reach.
  registerBuiltinTools(FILE_OPERATOR_TOOLS);

  server.tool(
    'folder_describe',
    "Set or clear a folder's description. Useful for agents that just created a folder and want to document what goes in it.",
    {
      folder_id: z.string().uuid().optional(),
      path: z.string().optional(),
      description: z.string().max(2000),
    },
    async ({ folder_id, path, description }) => {
      let id = folder_id ?? null;
      if (!id && path) {
        const found = await folderByPath({ ownerId: ownerId, path });
        id = found?.id ?? null;
      }
      if (!id) {
        return {
          content: [{ type: 'text', text: 'folder_describe: pass folder_id or path' }],
          isError: true,
        };
      }
      const updated = await updateFolderDescription({
        ownerId: ownerId,
        folderId: id,
        description,
      });
      if (!updated) {
        return { content: [{ type: 'text', text: 'folder not found' }], isError: true };
      }
      return jsonReply(updated);
    },
  );

  server.tool(
    'folder_rename',
    'Rename a folder in place. `new_name` is lowercased + sanitised. Every file and sub-folder inside moves with it (their paths update). Pass `folder_id` or `path`. Cannot rename the `files` root.',
    {
      folder_id: z.string().uuid().optional(),
      path: z.string().optional(),
      new_name: z.string().min(1).max(64),
    },
    async ({ folder_id, path, new_name }) => {
      let id = folder_id ?? null;
      if (!id && path) {
        const found = await folderByPath({ ownerId: ownerId, path });
        id = found?.id ?? null;
      }
      if (!id) {
        return {
          content: [{ type: 'text', text: 'folder_rename: pass folder_id or path' }],
          isError: true,
        };
      }
      try {
        const updated = await renameFolderById({
          ownerId: ownerId,
          folderId: id,
          newSlug: new_name,
        });
        if (!updated) {
          return { content: [{ type: 'text', text: 'folder not found' }], isError: true };
        }
        return jsonReply(updated);
      } catch (err) {
        const msg = errorMessage(err);
        return { content: [{ type: 'text', text: `folder_rename failed: ${msg}` }], isError: true };
      }
    },
  );

  // File-manager verbs + the indexing switch: BRIDGED from @mantle/tools so
  // MCP runs the same implementation as in-app agents (same teaching errors,
  // same indexing reconciliation) — hand-written twins rot, see
  // no-duplicate-tools.test.ts.
  registerBuiltinTools(FILE_MANAGE_TOOLS);

  server.tool(
    'file_read',
    'Read a file by id. For text files returns the content as a utf-8 string; for binaries returns base64-encoded bytes (only call this on small files).',
    { file_id: z.string().uuid() },
    async ({ file_id }) => {
      const res = await readFileById({ ownerId: ownerId, fileId: file_id });
      if (!res) {
        return { content: [{ type: 'text', text: 'file not found' }], isError: true };
      }
      const isText = res.row.isText;
      const out = {
        file: res.row,
        ...(isText
          ? { content_text: res.bytes.toString('utf8') }
          : { content_base64: res.bytes.toString('base64') }),
      };
      return jsonReply(out);
    },
  );

  server.tool(
    'file_get',
    "Fetch a file's metadata by id without loading bytes. Useful for resolving a uuid surfaced by search before deciding what to do with it.",
    { file_id: z.string().uuid() },
    async ({ file_id }) => {
      const row = await fileById({ ownerId: ownerId, fileId: file_id });
      if (!row) {
        return { content: [{ type: 'text', text: 'file not found' }], isError: true };
      }
      return jsonReply(row);
    },
  );

  server.tool(
    'file_rename',
    'Rename a file in place — its folder and extension are kept, only the basename changes. `new_stem` is the new name WITHOUT the extension (e.g. `huntsman-report` → `customerx-report`).',
    { file_id: z.string().uuid(), new_stem: z.string().min(1).max(200) },
    async ({ file_id, new_stem }) => {
      try {
        const row = await renameFileById({ ownerId: ownerId, fileId: file_id, newStem: new_stem });
        if (!row) {
          return { content: [{ type: 'text', text: 'file not found' }], isError: true };
        }
        return jsonReply(row);
      } catch (err) {
        const msg = errorMessage(err);
        return { content: [{ type: 'text', text: `file_rename failed: ${msg}` }], isError: true };
      }
    },
  );
}
