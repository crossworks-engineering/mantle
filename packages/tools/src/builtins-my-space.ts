/**
 * The "my space" tools (member logins Phase 2, plan v3.1 section 2e): an
 * agent may read a member's PERSONAL items only while it works for that
 * member. The member is the turn's own login, which the server stamps on the
 * team surface (`surface.loginId`); the model can never name it. Anything
 * else (an owner turn, a heartbeat, a run, MCP) has no one to act for and
 * finds nothing: fail closed.
 *
 * Read, never learn: personal items are never chunked, embedded or turned
 * into facts, so these tools list and open, they do not search by meaning.
 * Each call runs in its own short transaction on the personal-space role for
 * that one space (withSpace, human flag off): row security holds the rest.
 */
import { sql } from 'drizzle-orm';
import { db, withSpace } from '@mantle/db';
import {
  SPACE_ITEM_KINDS,
  docToText,
  getMineItem,
  isSpaceItemKind,
  listMine,
  sceneToText,
  tableToText,
} from '@mantle/content';
import { TEXT_EXTS, readSpaceFile } from '@mantle/files';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { numOpt, str, strOpt } from './coerce';

/** The most text one open returns; the rest is marked truncated. */
const OPEN_TEXT_MAX = 30_000;
/** Text files larger than this are listed, not read. */
const TEXT_FILE_MAX_BYTES = 256 * 1024;

const NO_MEMBER =
  "No member to act for: this tool reads the personal items of the member you are chatting with, so it only works in a member's own chat. For brain items use `search_nodes` or `page_get` instead.";

/** The member this turn works for, and their personal space; null = nobody. */
async function onBehalfOf(
  ctx: ToolHandlerContext,
): Promise<{ loginId: string; spaceId: string } | null> {
  const s = ctx.surface;
  if (s?.kind !== 'team' || !s.loginId) return null;
  const rows = (await db.execute(
    sql`select mantle_personal_space(${s.loginId}::uuid) as id`,
  )) as unknown as { id: string | null }[];
  const spaceId = rows[0]?.id;
  return spaceId ? { loginId: s.loginId, spaceId } : null;
}

function clip(text: string): { text: string; truncated?: true } {
  return text.length > OPEN_TEXT_MAX
    ? { text: text.slice(0, OPEN_TEXT_MAX), truncated: true }
    : { text };
}

export const my_items_list: BuiltinToolDef = {
  slug: 'my_items_list',
  name: "List the member's own items",
  description:
    "List the PERSONAL items of the member you are chatting with (pages, notes, drawings, tables, files), private ones included, newest first, with sharing and review state. Only that member's, never anyone else's. Personal items are not in `search_nodes` or the Library tools; read one with `my_item_open`.",
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...SPACE_ITEM_KINDS],
        description: 'Only this kind of item.',
      },
      q: { type: 'string', maxLength: 200, description: "Words in the title, e.g. 'site visit'." },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 50,
        description: 'Max items to return.',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const who = await onBehalfOf(ctx);
    if (!who) return { ok: false, error: NO_MEMBER };
    const kind = strOpt(input.kind);
    if (kind && !isSpaceItemKind(kind)) {
      return {
        ok: false,
        error: `unknown kind '${kind}'; use one of ${SPACE_ITEM_KINDS.join(', ')}.`,
      };
    }
    const res = await withSpace(who, () =>
      listMine(who.spaceId, {
        ...(kind && isSpaceItemKind(kind) ? { kind } : {}),
        ...(strOpt(input.q) ? { q: strOpt(input.q) } : {}),
        limit: Math.min(numOpt(input.limit) ?? 50, 100),
      }),
    );
    ctx.step?.setMeta({ count: res.items.length });
    return {
      ok: true,
      output: {
        items: res.items.map((i) => ({
          id: i.id,
          type: i.type,
          title: i.title,
          sharing: i.sharing,
          reviewState: i.reviewState,
          updatedAt: i.updatedAt,
        })),
        total: res.total,
      },
    };
  },
};

export const my_item_open: BuiltinToolDef = {
  slug: 'my_item_open',
  name: "Open one of the member's own items",
  description:
    "Read one PERSONAL item of the member you are chatting with, by id from `my_items_list`: a page's text (their working copy, unsaved edits included), a note, a drawing's labels, one table tab as markdown, or a small text file; other files return name, type and size only. For brain (Library) items use `page_get` or `table_get` instead.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The item id from my_items_list.' },
      tab: {
        type: 'string',
        description: "A table's tab id (from a previous open); default the first.",
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const who = await onBehalfOf(ctx);
    if (!who) return { ok: false, error: NO_MEMBER };
    const id = str(input.id).trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return {
        ok: false,
        error: `id must be a full item id (got '${id}'); copy it from \`my_items_list\`.`,
      };
    }
    const tab = strOpt(input.tab);
    const got = await withSpace(who, () => getMineItem(who.spaceId, id, tab ? { tabId: tab } : {}));
    if (!got) {
      return {
        ok: false,
        error: `no item ${id} in this member's space; list their items with \`my_items_list\` and use an id from it.`,
      };
    }
    const { row, body } = got;
    const head = {
      id: row.id,
      type: row.type,
      title: row.title,
      sharing: row.sharing,
      reviewState: row.reviewState,
    };
    switch (body.type) {
      case 'page':
        return {
          ok: true,
          output: { ...head, ...clip(docToText(body.page.draft ?? body.page.doc)) },
        };
      case 'note':
        return { ok: true, output: { ...head, ...clip(body.note.content ?? '') } };
      case 'draw':
        return {
          ok: true,
          output: {
            ...head,
            ...clip(body.draw ? sceneToText(body.draw.draft ?? body.draw.scene) : ''),
          },
        };
      case 'table': {
        const t = body.table;
        return {
          ok: true,
          output: {
            ...head,
            tabs: t.tabs ?? [],
            tabId: t.tabId ?? null,
            ...clip(tableToText(t.draft ?? t.data, { title: t.title })),
          },
        };
      }
      case 'file': {
        const f = body.file;
        const meta = {
          ...head,
          filename: f.filename,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
        };
        if (!TEXT_EXTS.has(f.extension) || f.sizeBytes > TEXT_FILE_MAX_BYTES) {
          return { ok: true, output: { ...meta, note: 'Only small text files can be read here.' } };
        }
        const bytes = await readSpaceFile(who.spaceId, f.id);
        return { ok: true, output: { ...meta, ...clip(bytes ? bytes.toString('utf8') : '') } };
      }
    }
  },
};

export const MY_SPACE_TOOLS: BuiltinToolDef[] = [my_items_list, my_item_open];
