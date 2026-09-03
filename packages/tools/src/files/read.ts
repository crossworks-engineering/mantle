/**
 * Reading the tree: list folders and files, read a file's text, fetch
 * one by id, resolve a folder by path.
 *
 * Split out of builtins-files.ts; bodies moved verbatim.
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
} from '@mantle/files';
import { type BuiltinToolDef } from '../types';
import { str, strOpt, boolOpt as bool } from '../coerce';
import { FILE_ID_PRE } from '../builtins-common';

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
