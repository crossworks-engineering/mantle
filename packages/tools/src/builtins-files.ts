/**
 * Builtins: file_* and folder_* — the file tree.
 *
 * Split out of builtins.ts on 2026-09-02 (audit, bloat B6) with behaviour
 * unchanged; builtins.ts assembles BUILTIN_TOOLS from these groups.
 */

import { and, asc, eq } from 'drizzle-orm';
import { contentChunks, db, nodes } from '@mantle/db';
import { buildSectionOutline } from '@mantle/search';
import {
  fileById,
  folderByPath,
  listAllFolders,
  listFiles,
  listFolders,
  readFileById,
  renameFileById,
  renameFolderById,
  updateFolderDescription,
  upsertFile,
  ensureFolderPath,
  setIndexingMode,
  moveFileById,
  moveFolderById,
  copyFileById,
  copyFolderById,
} from '@mantle/files';
import { recordIngest } from '@mantle/tracing';
import { type BuiltinToolDef } from './types';
import { str, strOpt, boolOpt as bool } from './coerce';
import { errorMessage } from '@mantle/std';
import { FILE_ID_PRE, FOLDER_ID_PRE } from './builtins-common';

export const folder_list: BuiltinToolDef = {
  slug: 'folder_list',
  readOnly: true,
  name: 'List folders',
  description:
    "List folders (only) in the user's host-mirrored filesystem. Pass `parent` (ltree path, e.g. 'files.work') for that folder's immediate sub-folders; pass `tree: true` for every folder under the root. " +
    "For files inside a folder use `file_list`; for a file's actual content use `file_read`; for searching files by content/topic use `search_nodes` with `type='file'` (or `search_chunks` to pull the relevant passages from inside them).",
  inputSchema: {
    type: 'object',
    properties: {
      parent: {
        type: 'string',
        description:
          "ltree path of the folder whose immediate sub-folders to list, e.g. 'files.work'; defaults to the 'files' root",
      },
      tree: {
        type: 'boolean',
        default: false,
        description: 'return every folder under the root (the whole tree) instead of one level',
      },
    },
  },
  handler: async (input, ctx) => {
    if (bool(input.tree)) {
      const rows = await listAllFolders(ctx.ownerId);
      ctx.step?.setOutput({ count: rows.length });
      return { ok: true, output: rows };
    }
    const parent = strOpt(input.parent) ?? 'files';
    const rows = await listFolders({ ownerId: ctx.ownerId, parentPath: parent });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

export const file_list: BuiltinToolDef = {
  slug: 'file_list',
  readOnly: true,
  name: 'List files in a folder',
  description:
    "List files (only) inside a specific folder. `parent_path` is the ltree path of the folder (e.g. 'files.work.lister-printer'). " +
    "For sub-folders within that folder use `folder_list`; for a file's actual content use `file_read`; for searching files by content/topic across the whole tree use `search_nodes` with `type='file'` (or `search_chunks` to pull the relevant passages from inside them).",
  inputSchema: {
    type: 'object',
    properties: {
      parent_path: {
        type: 'string',
        description:
          "ltree path of the folder whose files to list, e.g. 'files.work.lister-printer' — from `folder_list`",
      },
    },
    required: ['parent_path'],
  },
  handler: async (input, ctx) => {
    const parentPath = str(input.parent_path);
    if (!parentPath) return { ok: false, error: 'parent_path required' };
    const rows = await listFiles({ ownerId: ctx.ownerId, parentPath });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: rows };
  },
};

/** A file's extracted text past this many chars is "large": dumping it whole
 *  overflows the 32KB tool-result ceiling, spills, and gets re-sent every loop
 *  iteration (the dominant token sink). Past it, an INDEXED file returns its
 *  opening + a section outline + a pointer to read_section instead — unless the
 *  caller forces it with full:true, or there are no chunks to navigate by. */
const FILE_LARGE_TEXT_CHARS = 24000;

/** How much of the opening to show when the large-document guard fires. */
const FILE_HEAD_CHARS = 4000;

export const file_read: BuiltinToolDef = {
  slug: 'file_read',
  readOnly: true,
  name: 'Read a file',
  description:
    "Read a file's content by id. For text files (.md / .txt / .json / .yaml) returns the body as a utf-8 string. For binaries the extractor stores the parsed text (PDF / Word / Excel) as `data.text`, returned here so you can read or quote the document's actual contents. Returns `content: null` only when no text could be extracted (e.g. a scanned image with no OCR). " +
    '**For a LARGE indexed document this returns the opening + a section outline, NOT the whole text** — to read a specific part, use `search_chunks` + `read_section`; pass `full: true` only when you truly need every word. Use `node_read` for notes/events/tasks/secrets.',
  preconditions: FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The file's id (UUID) — from `file_list` / `search_nodes`.",
      },
      full: {
        type: 'boolean',
        description:
          'Load the ENTIRE extracted text even when the document is large. Default false: a large, indexed document returns its opening + a section outline + a pointer to read_section (almost always what you want). Set true only when you genuinely need the complete text.',
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required' };
    const full = bool(input.full) === true;
    const meta = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!meta)
      return {
        ok: false,
        error: 'file not found — find the right id with file_list / search_nodes, then re-issue.',
      };

    // Resolve the readable text once. Binary (pdf/docx/xlsx): the raw bytes
    // aren't useful to the LLM, but the extractor persists the parsed text as
    // data.text. Text files: the utf-8 body.
    let text: string | null;
    if (!meta.isText) {
      const [n] = await db
        .select({ data: nodes.data })
        .from(nodes)
        .where(and(eq(nodes.id, meta.id), eq(nodes.ownerId, ctx.ownerId)))
        .limit(1);
      text =
        n && typeof (n.data as Record<string, unknown>)?.text === 'string'
          ? ((n.data as Record<string, unknown>).text as string)
          : null;
    } else {
      const res = await readFileById({ ownerId: ctx.ownerId, fileId });
      if (!res)
        return {
          ok: false,
          error: 'file not found — find the right id with file_list / search_nodes, then re-issue.',
        };
      text = res.bytes.toString('utf8');
    }

    // Large-document guard: a big, already-chunked file would spill into the
    // tool-result store and get re-sent every loop iteration. Return the
    // opening + a section outline + a pointer to read_section instead — unless
    // forced with full:true, or there are no chunks to navigate by (then the
    // full text is the only option, returned as before).
    if (!full && text && text.length > FILE_LARGE_TEXT_CHARS) {
      const chunkRows = await db
        .select({ ordinal: contentChunks.ordinal, heading: contentChunks.headingPath })
        .from(contentChunks)
        .where(and(eq(contentChunks.nodeId, meta.id), eq(contentChunks.ownerId, ctx.ownerId)))
        .orderBy(asc(contentChunks.ordinal));
      if (chunkRows.length > 0) {
        const sections = buildSectionOutline(chunkRows);
        ctx.step?.setOutput({
          large: true,
          totalChars: text.length,
          passages: chunkRows.length,
          sections: sections.length,
        });
        return {
          ok: true,
          output: {
            file: meta,
            content: text.slice(0, FILE_HEAD_CHARS),
            truncated: true,
            total_chars: text.length,
            indexed_passages: chunkRows.length,
            sections: sections.slice(0, 100),
            note:
              `This document is large (${text.length} chars, ${chunkRows.length} indexed passages); only the opening ${FILE_HEAD_CHARS} chars are shown. ` +
              `To read a specific part WITHOUT loading the whole file, use search_chunks to find the passage, then read_section(node_id:"${meta.id}", heading|from_ordinal..to_ordinal) to read that section in full. ` +
              `Call file_read again with full:true ONLY if you genuinely need the entire text.`,
          },
        };
      }
    }

    ctx.step?.setOutput({
      binary: !meta.isText,
      hasExtractedText: !!text,
      textChars: text?.length ?? 0,
    });
    return { ok: true, output: { file: meta, content: text } };
  },
};

export const file_get: BuiltinToolDef = {
  slug: 'file_get',
  readOnly: true,
  name: 'Fetch file metadata',
  description:
    "Fetch a file's metadata (filename, mime type, size, sha) — no bytes. Use to confirm size/type before deciding to read a large/binary file. " +
    'For the actual file content use `file_read`; for listing files in a folder use `file_list`.',
  preconditions: FILE_ID_PRE,
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The file's id (UUID) — from `file_list` / `search_nodes`.",
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required' };
    const row = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!row)
      return {
        ok: false,
        error: 'file not found — find the right id with file_list / search_nodes, then re-issue.',
      };
    return { ok: true, output: row };
  },
};

export const folder_get_by_path: BuiltinToolDef = {
  slug: 'folder_get_by_path',
  readOnly: true,
  name: 'Look up folder by path',
  description:
    "Look up a folder's metadata + description by its ltree path. " +
    "For listing what's IN the folder use `folder_list` (sub-folders) or `file_list` (files).",
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: "the folder's full ltree path, e.g. 'files.work.lister-printer'",
      },
    },
    required: ['path'],
  },
  handler: async (input, ctx) => {
    const path = str(input.path);
    if (!path) return { ok: false, error: 'path required' };
    const row = await folderByPath({ ownerId: ctx.ownerId, path });
    if (!row)
      return {
        ok: false,
        error: 'folder not found — find the right id with folder_list / tree_list, then re-issue.',
      };
    return { ok: true, output: row };
  },
};

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
