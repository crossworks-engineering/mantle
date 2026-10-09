/**
 * The draft WRITE tools of a member's or client's own space (MCP as a login,
 * plan page e5b854dd, Part 3). A member or client that writes over MCP
 * writes DRAFTS into their own personal space, the same as the space routes
 * (POST /api/member/space, /api/member/space-files, .../submit) and nothing
 * more: an admin reviews what they submit. No library write, no new row
 * rules: every write runs inside `withSpace` on the personal-space role.
 *
 * The login is the one the server stamped on the surface (`onBehalfOf`), as
 * for my_items_list; the model never names it. Any other caller finds no one
 * to act for and is refused. These tools are in no tool group: only the
 * login MCP surface offers them, and only while the login's write switch
 * (or its peer's) is on.
 */
import { Readable } from 'node:stream';
import { withSpace } from '@mantle/db';
import {
  SPACE_FILE_MAX_BYTES,
  SpaceItemStateError,
  createMineFile,
  createMineItem,
  getMineItem,
  markdownToDoc,
  spaceUploadHeadroom,
  submitItem,
} from '@mantle/content';
import { memberFilingPath } from '@mantle/content/tree';
import { discardSpooled, spaceSpoolDir, spoolUpload, UploadTooLargeError } from '@mantle/files';
import { errorMessage } from '@mantle/std';
import { onBehalfOf } from './builtins-my-space';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { str, strOpt } from './coerce';

const NO_LOGIN =
  'No one to act for: this tool writes drafts into the personal space of the member or client it works for, so it only runs on their own MCP connection.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A note's and a page's text cap, as the space routes. */
const TEXT_MAX = 200_000;
const TITLE_MAX = 200;

/** A space refusal (quota, frozen, not found) as a plain tool error. */
function refusal(err: unknown): ToolHandlerResult {
  if (err instanceof SpaceItemStateError) return { ok: false, error: err.message };
  if (err instanceof Error && err.message === 'invalid filename') {
    return { ok: false, error: 'Invalid file name.' };
  }
  return { ok: false, error: errorMessage(err) };
}

/** The stored path of a folder the member's own tree shows (members only:
 *  a client's space has no folders). Null = the top level. */
async function filingPath(
  ctx: ToolHandlerContext,
  who: { loginId: string; spaceId: string },
  kind: 'notes' | 'pages' | 'files',
  folderId: string | undefined,
): Promise<string | undefined | { error: string }> {
  if (!folderId) return undefined;
  if (ctx.surface?.kind !== 'team') {
    return { error: 'folder_id is for team members; a client files at the top of their space.' };
  }
  if (!UUID_RE.test(folderId)) return { error: 'folder_id must be a folder id.' };
  try {
    return await memberFilingPath(
      { anchorId: ctx.ownerId, spaceId: who.spaceId, loginId: who.loginId },
      kind,
      folderId,
    );
  } catch {
    return { error: 'No such folder in your space.' };
  }
}

function itemOut(row: { id: string; type: string; title: string; reviewState?: unknown }) {
  return { id: row.id, type: row.type, title: row.title, reviewState: row.reviewState ?? null };
}

export const my_note_create: BuiltinToolDef = {
  slug: 'my_note_create',
  name: 'Create a draft note in my own space',
  description:
    'Create a NOTE in your own personal space: private, a draft. It does not go into the brain until you submit it (`my_item_submit`) and an admin accepts it.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: TITLE_MAX, description: 'The note title.' },
      content: { type: 'string', maxLength: TEXT_MAX, description: 'The note text.' },
      folder_id: { type: 'string', description: 'A notes folder in your space (members only).' },
    },
    required: ['title'],
  },
  redactInputFields: ['content'],
  handler: async (input, ctx) => {
    const who = await onBehalfOf(ctx);
    if (!who) return { ok: false, error: NO_LOGIN };
    const content = strOpt(input.content) ?? '';
    if (content.length > TEXT_MAX) return { ok: false, error: 'content is too long.' };
    const path = await filingPath(ctx, who, 'notes', strOpt(input.folder_id));
    if (path && typeof path === 'object') return { ok: false, error: path.error };
    try {
      const row = await withSpace(who, () =>
        createMineItem(
          who.spaceId,
          { type: 'note', title: str(input.title).trim().slice(0, TITLE_MAX), content },
          {},
          { path },
        ),
      );
      return { ok: true, output: itemOut(row) };
    } catch (err) {
      return refusal(err);
    }
  },
};

export const my_page_create: BuiltinToolDef = {
  slug: 'my_page_create',
  name: 'Create a draft page in my own space',
  description:
    'Create a PAGE in your own personal space from markdown: private, a draft. Submit it with `my_item_submit` for an admin to review.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: TITLE_MAX, description: 'The page title.' },
      markdown: { type: 'string', maxLength: TEXT_MAX, description: 'The page body, markdown.' },
      folder_id: { type: 'string', description: 'A pages folder in your space (members only).' },
    },
    required: ['title'],
  },
  redactInputFields: ['markdown'],
  handler: async (input, ctx) => {
    const who = await onBehalfOf(ctx);
    if (!who) return { ok: false, error: NO_LOGIN };
    const md = strOpt(input.markdown) ?? '';
    if (md.length > TEXT_MAX) return { ok: false, error: 'markdown is too long.' };
    const path = await filingPath(ctx, who, 'pages', strOpt(input.folder_id));
    if (path && typeof path === 'object') return { ok: false, error: path.error };
    try {
      const doc = md.trim() ? (markdownToDoc(md) as Record<string, unknown>) : undefined;
      const row = await withSpace(who, () =>
        createMineItem(
          who.spaceId,
          { type: 'page', title: str(input.title).trim().slice(0, TITLE_MAX), doc },
          {},
          { path },
        ),
      );
      return { ok: true, output: itemOut(row) };
    } catch (err) {
      return refusal(err);
    }
  },
};

export const my_file_upload: BuiltinToolDef = {
  slug: 'my_file_upload',
  name: 'Upload a file into my own space',
  description:
    "Put a FILE into your own personal space: private, a draft. Pass `text` for a text file or `content_base64` for any file. Your space's storage and daily upload limits apply. A name the space already holds is stored as name-2.ext.",
  inputSchema: {
    type: 'object',
    properties: {
      filename: { type: 'string', maxLength: 255, description: "The file name, e.g. 'notes.md'." },
      text: { type: 'string', description: 'The file content as text (UTF-8).' },
      content_base64: { type: 'string', description: 'The file content, base64.' },
      folder_id: { type: 'string', description: 'A files folder in your space (members only).' },
    },
    required: ['filename'],
  },
  redactInputFields: ['text', 'content_base64'],
  handler: async (input, ctx) => {
    const who = await onBehalfOf(ctx);
    if (!who) return { ok: false, error: NO_LOGIN };
    const text = strOpt(input.text);
    const b64 = strOpt(input.content_base64);
    if ((text === undefined) === (b64 === undefined)) {
      return { ok: false, error: 'pass exactly one of `text` or `content_base64`.' };
    }
    // The base64 length bounds the bytes before anything is decoded.
    if (b64 !== undefined && b64.length > Math.ceil((SPACE_FILE_MAX_BYTES * 4) / 3) + 4) {
      return { ok: false, error: `Files can be at most ${SPACE_FILE_MAX_BYTES} bytes.` };
    }
    const bytes = text !== undefined ? Buffer.from(text, 'utf8') : Buffer.from(b64!, 'base64');
    if (bytes.length === 0) return { ok: false, error: 'The file is empty.' };
    const path = await filingPath(ctx, who, 'files', strOpt(input.folder_id));
    if (path && typeof path === 'object') return { ok: false, error: path.error };
    const headroom = await withSpace(who, () => spaceUploadHeadroom(who.spaceId));
    if (headroom <= 0 || bytes.length > headroom) {
      return {
        ok: false,
        error:
          'Not enough room for this file: your space is full or today’s upload limit is used up.',
      };
    }
    let spooled;
    try {
      spooled = await spoolUpload(Readable.from([bytes]), {
        maxBytes: Math.min(headroom, SPACE_FILE_MAX_BYTES),
        dir: spaceSpoolDir(),
      });
    } catch (err) {
      if (err instanceof UploadTooLargeError) return { ok: false, error: `${err.message}.` };
      return refusal(err);
    }
    try {
      const got = await withSpace(who, async () => {
        const id = await createMineFile(who.spaceId, {
          filename: str(input.filename),
          spooled,
          path,
        });
        return getMineItem(who.spaceId, id);
      });
      if (!got) return { ok: false, error: 'The file was stored but cannot be read back.' };
      return { ok: true, output: itemOut(got.row) };
    } catch (err) {
      return refusal(err);
    } finally {
      // No-op once adopted; the safety net for every failure before it.
      await discardSpooled(spooled);
    }
  },
};

export const my_item_submit: BuiltinToolDef = {
  slug: 'my_item_submit',
  name: 'Submit one of my items for review',
  description:
    'Send one of your own items (by id from `my_items_list`) to an admin for review. Its SAVED version is what is reviewed, and it is frozen until the admin accepts or rejects it, or you recall it in the app.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The item id from my_items_list.' } },
    required: ['id'],
  },
  redactInputFields: ['id'],
  handler: async (input, ctx) => {
    const who = await onBehalfOf(ctx);
    if (!who) return { ok: false, error: NO_LOGIN };
    const id = str(input.id).trim();
    if (!UUID_RE.test(id)) return { ok: false, error: 'id must be a full item id.' };
    try {
      const row = await withSpace(who, () => submitItem(who.spaceId, id));
      return { ok: true, output: itemOut(row) };
    } catch (err) {
      return refusal(err);
    }
  },
};

/** The draft writes a member or client gets on MCP with write on. */
export const MY_SPACE_WRITE_TOOLS: BuiltinToolDef[] = [
  my_note_create,
  my_page_create,
  my_file_upload,
  my_item_submit,
];

/** Their slugs: the login MCP surface adds exactly these when write is on. */
export const MY_SPACE_WRITE_TOOL_SLUGS: readonly string[] = MY_SPACE_WRITE_TOOLS.map((d) => d.slug);
