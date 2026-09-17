/**
 * Owner-operator surface (mcpOnly): create and delete folders, upload
 * and delete files. Never granted to an in-brain agent.
 *
 * Split out of builtins-files.ts; bodies moved verbatim.
 */

import {
  createFolder,
  deleteFileById,
  deleteFolder,
  ensureFilesRootBranch,
  extOf,
  MAX_UPLOAD_BYTES,
  MEDIA_EXTS,
  upsertFile,
  setIndexingMode,
} from '@mantle/files';
import { deleteFileWithDerived, describeDerivedCounts } from '@mantle/content';
import { type BuiltinToolDef } from '../types';
import { str, strOpt, boolOpt as bool } from '../coerce';
import { errorMessage } from '@mantle/std';
import { FILE_ID_PRE, FOLDER_ID_PRE } from '../builtins-common';

export const folder_create: BuiltinToolDef = {
  slug: 'folder_create',
  mcpOnly: true,
  name: 'Create a folder',
  description:
    "Create a folder under `parent_path` (ltree, e.g. 'files.work'). Slug must be lowercase + dashes — anything else gets normalised. Description is optional but recommended so future agents know what the folder is for. Creates the directory on disk and the DB row in lockstep. Pass `indexing: 'metadata'` to make it a store-and-share area whose files are indexed by name/type/tags but whose CONTENT is never read into the brain (galleries, temp files, transcription clips).",
  inputSchema: {
    type: 'object',
    properties: {
      parent_path: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: "ltree path of the parent, e.g. 'files.work'",
      },
      slug: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'lowercase-and-dashes name for the new folder',
      },
      description: {
        type: 'string',
        maxLength: 2000,
        description: 'what belongs in this folder',
      },
      indexing: {
        type: 'string',
        enum: ['full', 'metadata'],
        description: "'metadata' stores without reading file CONTENT into the brain",
      },
    },
    required: ['parent_path', 'slug'],
  },
  handler: async (input, ctx) => {
    const parentPath = str(input.parent_path);
    const slug = str(input.slug);
    if (!parentPath || !slug) return { ok: false, error: 'parent_path + slug required' };
    const raw = strOpt(input.indexing);
    if (raw && raw !== 'full' && raw !== 'metadata') {
      return { ok: false, error: "indexing must be 'full' or 'metadata'" };
    }
    const indexing = raw as 'full' | 'metadata' | undefined;
    await ensureFilesRootBranch(ctx.ownerId);
    try {
      const folder = await createFolder({
        ownerId: ctx.ownerId,
        parentPath,
        slug,
        description: strOpt(input.description),
      });
      // Applied AFTER create so the flag write and the descendant sweep share
      // one code path with the settings toggle.
      if (indexing) {
        await setIndexingMode({ ownerId: ctx.ownerId, nodeId: folder.id, mode: indexing });
      }
      return { ok: true, output: indexing ? { ...folder, indexing } : folder };
    } catch (err) {
      return { ok: false, error: `folder_create failed: ${errorMessage(err)}` };
    }
  },
};

export const folder_delete: BuiltinToolDef = {
  slug: 'folder_delete',
  mcpOnly: true,
  preconditions: FOLDER_ID_PRE,
  name: 'Delete a folder',
  description:
    'Delete a folder. Refuses unless the folder is empty — clear its children first. Cannot delete the `files` root.',
  inputSchema: {
    type: 'object',
    properties: {
      folder_id: { type: 'string', format: 'uuid', description: 'the folder node id' },
    },
    required: ['folder_id'],
  },
  handler: async (input, ctx) => {
    const folderId = str(input.folder_id);
    if (!folderId) return { ok: false, error: 'folder_id required' };
    const res = await deleteFolder({ ownerId: ctx.ownerId, folderId });
    if (!res.ok) return { ok: false, error: `folder_delete: ${res.reason}` };
    return { ok: true, output: 'deleted' };
  },
};

export const file_upload: BuiltinToolDef = {
  slug: 'file_upload',
  mcpOnly: true,
  name: 'Create or overwrite a file',
  description:
    "Create or overwrite a file in a folder. Pass either `content_text` (utf-8) or `content_base64` (binary). Filename is lowercased + sanitised. The extractor agent will pick up text files (md/txt/json/yaml) automatically. Pass `indexing: 'metadata'` to store WITHOUT content indexing (findable by name/type/tags only).",
  inputSchema: {
    type: 'object',
    properties: {
      parent_path: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: "ltree path of the destination folder, e.g. 'files.work'",
      },
      filename: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'name including extension; lowercased and sanitised',
      },
      content_text: { type: 'string', description: 'utf-8 body, for text files' },
      content_base64: { type: 'string', description: 'base64 bytes, for binaries' },
      overwrite: {
        type: 'boolean',
        description: 'replace an existing file of the same name instead of failing',
      },
      indexing: {
        type: 'string',
        enum: ['full', 'metadata'],
        description: "'metadata' stores without reading the CONTENT into the brain",
      },
    },
    required: ['parent_path', 'filename'],
  },
  handler: async (input, ctx) => {
    const parentPath = str(input.parent_path);
    const filename = str(input.filename);
    if (!parentPath || !filename) return { ok: false, error: 'parent_path + filename required' };
    const contentText = input.content_text == null ? undefined : String(input.content_text);
    const contentBase64 = input.content_base64 == null ? undefined : String(input.content_base64);
    if (contentText == null && contentBase64 == null) {
      return { ok: false, error: 'file_upload: pass content_text or content_base64' };
    }
    const raw = strOpt(input.indexing);
    if (raw && raw !== 'full' && raw !== 'metadata') {
      return { ok: false, error: "indexing must be 'full' or 'metadata'" };
    }
    const indexing = raw as 'full' | 'metadata' | undefined;
    const bytes =
      contentText != null
        ? Buffer.from(contentText, 'utf8')
        : Buffer.from(contentBase64!, 'base64');
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      const hint = MEDIA_EXTS.has(extOf(filename))
        ? ' — for video, ingest the link instead (video_ingest)'
        : '';
      return {
        ok: false,
        error: `file_upload: too large (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB > ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)${hint}`,
      };
    }
    try {
      const row = await upsertFile({
        ownerId: ctx.ownerId,
        parentPath,
        filename,
        bytes,
        overwrite: bool(input.overwrite),
      });
      // Best-effort ordering: the insert trigger may already have queued
      // extraction, so a full pass CAN race this write. Harmless — the sweep
      // inside setIndexingMode sees applied≠effective and re-queues, and the
      // metadata pass reaps whatever the racing pass wrote.
      if (indexing) {
        await setIndexingMode({ ownerId: ctx.ownerId, nodeId: row.id, mode: indexing });
      }
      return { ok: true, output: indexing ? { ...row, indexing } : row };
    } catch (err) {
      return { ok: false, error: `file_upload failed: ${errorMessage(err)}` };
    }
  },
};

/** The refusal reasons deleteFileById / deleteFileWithDerived share. */
function undeletableReason(
  reason: string | undefined,
  drawings: ReadonlyArray<{ title: string | null }> | undefined,
): string {
  if (reason === 'attachment') {
    return "can't delete — this file is an email attachment; delete it from the email instead";
  }
  if (reason === 'in_drawing') {
    const where = (drawings ?? []).map((d) => d.title).join(', ') || 'a drawing';
    return `can't delete — this image is used in ${where}; remove it from the drawing first`;
  }
  return 'file not found';
}

export const file_delete: BuiltinToolDef = {
  slug: 'file_delete',
  mcpOnly: true,
  preconditions: FILE_ID_PRE,
  name: 'Delete a file',
  description:
    'Delete a file by id. Removes both the DB row and the on-disk file. If ingest derived nodes from the file (extracted images, imported tables, pages, notes), the call reports their counts instead of deleting; confirm with the user, then call again with delete_derived: true to remove them too.',
  inputSchema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', format: 'uuid', description: 'the file node id' },
      delete_derived: {
        type: 'boolean',
        description: 'also remove every node ingest derived from this file',
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required' };
    if (bool(input.delete_derived)) {
      const res = await deleteFileWithDerived(ctx.ownerId, fileId);
      if (!res.ok) return { ok: false, error: undeletableReason(res.reason, res.drawings) };
      const skipped = res.skipped > 0 ? ` (${res.skipped} derived node(s) skipped)` : '';
      return {
        ok: true,
        output: `deleted, along with ${describeDerivedCounts(res.reaped)} derived from it${skipped}`,
      };
    }
    const res = await deleteFileById({ ownerId: ctx.ownerId, fileId });
    if (!res.ok) {
      if (res.reason === 'has_derived' && res.derived) {
        // Not an error: a count-and-confirm preview. Nothing was deleted.
        return {
          ok: true,
          output: `this file produced ${describeDerivedCounts(res.derived)} — nothing was deleted; call again with delete_derived: true to remove the file and everything derived from it`,
        };
      }
      return { ok: false, error: undeletableReason(res.reason, res.drawings) };
    }
    return { ok: true, output: 'deleted' };
  },
};
