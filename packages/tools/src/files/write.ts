/**
 * Authoring and naming: create a file from text, rename either kind,
 * describe a folder, set indexing mode.
 *
 * Split out of builtins-files.ts; bodies moved verbatim.
 */

import {
  fileById,
  renameFileById,
  renameFolderById,
  updateFolderDescription,
  upsertFile,
  ensureFolderPath,
  setIndexingMode,
} from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { type BuiltinToolDef } from '../types';
import { str, boolOpt as bool } from '../coerce';
import { errorMessage } from '@mantle/std';
import { FILE_ID_PRE, FOLDER_ID_PRE } from '../builtins-common';

export const file_create: BuiltinToolDef = {
  slug: 'file_create',
  name: 'Create / overwrite a file',
  description:
    'Create or overwrite a **named text file** in a specific folder (e.g. `notes.md`, `config.json`, `recipe.txt`). Use when the user asks for a file with a particular name/extension in a particular place. Filename is lowercased and sanitised automatically. ' +
    'For a plain note that goes into /notes (no filename/folder needed, auto-indexed) use `note_create`. For credentials/passwords use `secret_create`. For a rich-text doc (TipTap) use `page_create`.',
  requiresConfirm: false, // text-only writes are usually safe; user can flip per agent
  inputSchema: {
    type: 'object',
    properties: {
      parent_path: { type: 'string', description: 'ltree path of the parent folder' },
      filename: { type: 'string', description: 'with extension, e.g. notes.md' },
      content: {
        type: 'string',
        description: "the file's full text — becomes the entire body (replaces, never appends)",
      },
      overwrite: {
        type: 'boolean',
        default: false,
        description:
          'replace the existing file of the same name; default false errors on a name collision',
      },
    },
    required: ['parent_path', 'filename', 'content'],
  },
  handler: async (input, ctx) => {
    const parentPath = str(input.parent_path);
    const filename = str(input.filename);
    const content = str(input.content);
    if (!parentPath || !filename) {
      return { ok: false, error: 'parent_path + filename required' };
    }
    try {
      // Bring the folder into existence rather than refusing the write. A skill
      // can name a folder the brain has never had (the Draftsman's
      // `files/diagrams` was one), and refusing sent the agent off to file the
      // artifact somewhere the instructions never meant. Capped and confined to
      // `files` inside the helper, so a malformed path is still an error.
      await ensureFolderPath({ ownerId: ctx.ownerId, path: parentPath });
      const row = await upsertFile({
        ownerId: ctx.ownerId,
        parentPath,
        filename,
        bytes: Buffer.from(content, 'utf8'),
        overwrite: bool(input.overwrite),
      });
      ctx.step?.setOutput({ fileId: row.id });
      // Saskia-driven file create is itself a data entry event.
      // The biography view for the new file picks this up so the
      // operator can see "Saskia created this in response to a
      // user request" rather than "appeared from nowhere."
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: row.id,
        summary: `File created by tool: ${row.filename}`,
        payload: {
          parentPath,
          filename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          via: 'file_create_tool',
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: content,
      });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const file_rename: BuiltinToolDef = {
  slug: 'file_rename',
  name: 'Rename a file',
  description:
    "Rename a file in place — its folder and extension are kept, only the basename changes. `new_stem` is the new name WITHOUT the extension (e.g. rename `huntsman-report.xlsx` → stem `customerx-report`). Find the file id with `file_list` / `search_nodes` first. To change a file's CONTENTS use `file_create` with overwrite=true; to rename a FOLDER use `folder_rename`.",
  preconditions: FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The file's id (UUID) — from `file_list` / `search_nodes`.",
      },
      new_stem: { type: 'string', description: 'new basename, no extension' },
    },
    required: ['file_id', 'new_stem'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    const newStem = str(input.new_stem);
    if (!fileId || !newStem) return { ok: false, error: 'file_id + new_stem required' };
    try {
      const row = await renameFileById({ ownerId: ctx.ownerId, fileId, newStem });
      if (!row)
        return {
          ok: false,
          error: 'file not found — find the right id with file_list / search_nodes, then re-issue.',
        };
      ctx.step?.setOutput({ fileId: row.id, filename: row.filename });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const folder_rename: BuiltinToolDef = {
  slug: 'folder_rename',
  name: 'Rename a folder',
  description:
    "Rename a folder in place. `new_name` is lowercased and sanitised automatically. Every file and sub-folder inside moves with it (their paths update), so this is safe for a folder full of content. Find the folder id with `folder_list` / `folder_get_by_path` first. The root `files` folder can't be renamed. To change a folder's DESCRIPTION use `folder_describe`.",
  preconditions: FOLDER_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      folder_id: {
        type: 'string',
        format: 'uuid',
        description: "The folder's id (UUID) — from `folder_list` / `folder_get_by_path`.",
      },
      new_name: {
        type: 'string',
        description:
          "new display name, e.g. 'lister contracts' — lowercased and slugified automatically",
      },
    },
    required: ['folder_id', 'new_name'],
  },
  handler: async (input, ctx) => {
    const folderId = str(input.folder_id);
    const newName = str(input.new_name);
    if (!folderId || !newName) return { ok: false, error: 'folder_id + new_name required' };
    try {
      const row = await renameFolderById({ ownerId: ctx.ownerId, folderId, newSlug: newName });
      if (!row)
        return {
          ok: false,
          error:
            'folder not found — find the right id with folder_list / tree_list, then re-issue.',
        };
      ctx.step?.setOutput({ folderId: row.id, path: row.path });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const folder_describe: BuiltinToolDef = {
  slug: 'folder_describe',
  name: 'Update a folder description',
  description:
    "Set or update a folder's free-text description (what the folder is for). Find the folder id with `folder_list` / `folder_get_by_path` first. This does NOT rename the folder — use `folder_rename` for that.",
  preconditions: FOLDER_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      folder_id: {
        type: 'string',
        format: 'uuid',
        description: "The folder's id (UUID) — from `folder_list` / `folder_get_by_path`.",
      },
      description: {
        type: 'string',
        description:
          "what the folder is for, e.g. 'Signed Lister contracts and quotes' — replaces any existing description",
      },
    },
    required: ['folder_id', 'description'],
  },
  handler: async (input, ctx) => {
    const folderId = str(input.folder_id);
    const description = str(input.description);
    if (!folderId) return { ok: false, error: 'folder_id required' };
    try {
      const row = await updateFolderDescription({ ownerId: ctx.ownerId, folderId, description });
      if (!row)
        return {
          ok: false,
          error:
            'folder not found — find the right id with folder_list / tree_list, then re-issue.',
        };
      ctx.step?.setOutput({ folderId: row.id });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

const INDEXING_MODE_SCHEMA = {
  type: 'string',
  enum: ['full', 'metadata', 'inherit'],
  description:
    "'metadata' = index name/type/tags only, never the content; 'full' = normal content indexing; 'inherit' = clear the own flag and follow the folder chain",
};

export const file_set_indexing: BuiltinToolDef = {
  slug: 'file_set_indexing',
  name: 'Set file indexing mode',
  description:
    "Control whether ONE file's CONTENT is indexed into the brain. 'metadata' keeps the file fully stored, shareable and findable by name/type/tags, but its content is never read: no passages, no facts — search_chunks and content questions will not see inside it. 'full' restores normal indexing (re-extraction is queued and takes a moment). 'inherit' clears the file's own flag so the folder chain decides. For a whole folder use `folder_set_indexing`; this is the per-file override.",
  preconditions: FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The file's id (UUID) — from `file_list` / `search_nodes`.",
      },
      mode: INDEXING_MODE_SCHEMA,
    },
    required: ['file_id', 'mode'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    const mode = str(input.mode) as 'full' | 'metadata' | 'inherit';
    if (!fileId) return { ok: false, error: 'file_id required' };
    try {
      const { requeued } = await setIndexingMode({ ownerId: ctx.ownerId, nodeId: fileId, mode });
      const row = await fileById({ ownerId: ctx.ownerId, fileId });
      ctx.step?.setOutput({ fileId, mode, requeued });
      return {
        ok: true,
        output: {
          file: row,
          requeued,
          note:
            requeued > 0
              ? 're-indexing queued — the change takes effect when the extractor next runs'
              : 'no re-indexing needed (the file was already indexed under this mode)',
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const folder_set_indexing: BuiltinToolDef = {
  slug: 'folder_set_indexing',
  name: 'Set folder indexing mode',
  description:
    "Control whether the CONTENT of every file under a folder is indexed into the brain. 'metadata' turns the subtree into a store-and-share area (a photo gallery, temp files, transcription clips): files stay fully stored and findable by name/type/tags, but their content is never read into search or the knowledge graph. 'full' restores content indexing for the subtree — NOTE this re-runs real extraction over every affected file, which costs LLM calls in proportion to the file count. 'inherit' clears the folder's own flag. Individual files can override either way with `file_set_indexing`. Returns how many files were queued for re-indexing.",
  preconditions: FOLDER_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      folder_id: {
        type: 'string',
        format: 'uuid',
        description: "The folder's id (UUID) — from `folder_list` / `folder_get_by_path`.",
      },
      mode: INDEXING_MODE_SCHEMA,
    },
    required: ['folder_id', 'mode'],
  },
  handler: async (input, ctx) => {
    const folderId = str(input.folder_id);
    const mode = str(input.mode) as 'full' | 'metadata' | 'inherit';
    if (!folderId) return { ok: false, error: 'folder_id required' };
    try {
      const { node, requeued } = await setIndexingMode({
        ownerId: ctx.ownerId,
        nodeId: folderId,
        mode,
      });
      ctx.step?.setOutput({ folderId, mode, requeued });
      return {
        ok: true,
        output: {
          folder: { id: node.id, path: node.path, title: node.title },
          mode,
          requeued,
          note:
            requeued > 0
              ? `${requeued} file(s) queued for re-indexing under the new mode`
              : 'no files needed re-indexing',
        },
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};
