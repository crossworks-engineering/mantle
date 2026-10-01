/**
 * Client tools (client logins C4, plan section 8): the client-responder's
 * reads and its one write.
 *
 * The reads are the client PORTAL's reads, not the brain-wide search tools.
 * What a client sees through the chat is exactly what "Shared with you" shows
 * them (client-shared.ts): items at client level, each body with every
 * reference to an item a client may not read turned into "Private item" and
 * embeds of such items left out, no summary, no staff fields. The brain-wide
 * tools read chunks, facts and summaries that were built from the whole page
 * text, which can name team and admin items in mention and link labels (plan
 * N6, audit B1), so a client agent never holds them.
 *
 * Every tool runs only on a CLIENT surface (the login is stamped by the
 * server, never taken from the model) and inside `withViewer('client')`, so
 * even a mistaken grant on another surface reads at client level or not at
 * all.
 */
import {
  CLIENT_REQUEST_TAG,
  CLIENT_REQUESTS_PER_DAY,
  CLIENT_REQUESTS_PER_TURN,
  TEAM_REQUEST_TAG,
  countClientRequestFilings,
  createTask,
  docToText,
  getClientSharedItem,
  listClientShared,
  recordClientRequestFiling,
  type TaskPriority,
} from '@mantle/content';
import { CLIENT_REQUEST_SOURCE, withViewer } from '@mantle/db';
import { asSystem } from '@mantle/db/viewer';
import type { ClientSharedItem, ClientSharedRow } from '@mantle/client-types';
import { errorMessage, UUID_RE } from '@mantle/std';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';
import { numOpt, str, strOpt } from './coerce';

/** The kinds "Shared with you" lists. */
const CLIENT_KINDS = ['page', 'note', 'table', 'draw', 'file'] as const;
type ClientKind = (typeof CLIENT_KINDS)[number];

/** The most text one open returns; the rest is marked truncated. */
const OPEN_TEXT_MAX = 30_000;
/** Table rows one open renders. */
const OPEN_TABLE_ROWS = 200;
/** Items a search looks through (newest first), and opens at most. */
const SEARCH_SCAN = 200;
const SEARCH_OPEN_MAX = 40;

const NOT_CLIENT =
  "This tool serves the client you are chatting with, so it only runs in a client's own chat.";

/** The client this turn works for, or null: only a client surface counts. */
export function clientOf(ctx: ToolHandlerContext): { loginId: string; name: string | null } | null {
  const s = ctx.surface;
  if (s?.kind !== 'client' || !s.loginId) return null;
  return { loginId: s.loginId, name: s.contactName ?? null };
}

/** A client read, at client level whatever the caller's scope. */
function asClient<T>(fn: () => Promise<T>): Promise<T> {
  return withViewer('client', fn);
}

/** The link a client follows to an item: the portal opens `/n/<id>`. */
const itemLink = (id: string) => `/n/${id}`;

function rowOut(r: ClientSharedRow) {
  return { id: r.id, type: r.type, title: r.title, updatedAt: r.updatedAt, link: itemLink(r.id) };
}

/** The readable text of one shared item, as the client sees it. */
export function clientItemText(item: ClientSharedItem): string {
  switch (item.type) {
    case 'page':
      return docToText(item.doc);
    case 'note':
      return item.content;
    case 'table': {
      const cols = item.table.data.columns;
      const lines = [cols.map((c) => c.name).join(' | ')];
      for (const r of item.table.data.rows.slice(0, OPEN_TABLE_ROWS)) {
        lines.push(cols.map((c) => cellText(r.cells[c.id])).join(' | '));
      }
      if (item.table.data.rows.length > OPEN_TABLE_ROWS) {
        lines.push(`(${item.table.data.rows.length - OPEN_TABLE_ROWS} more rows in the portal)`);
      }
      return lines.join('\n');
    }
    case 'draw':
      return 'A drawing: the client can open it in their portal.';
    case 'file':
      return `A file (${item.filename}${item.mimeType ? `, ${item.mimeType}` : ''}): the client can download it from their portal.`;
  }
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(cellText).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function clip(text: string): { text: string; truncated?: true } {
  return text.length > OPEN_TEXT_MAX
    ? { text: text.slice(0, OPEN_TEXT_MAX), truncated: true }
    : { text };
}

/** The search words: lower-cased, at least two characters, at most 12. */
export function searchTerms(q: string): string[] {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);
  return [...new Set(words)].slice(0, 12);
}

/** A short passage of `text` around the first term it holds. */
export function snippetAround(text: string, terms: readonly string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, 200).trim();
  const start = Math.max(0, at - 80);
  return `${start > 0 ? '…' : ''}${text.slice(start, at + 160).trim()}…`;
}

const kindProp = {
  type: 'string',
  enum: [...CLIENT_KINDS],
  description: 'Only this kind of item.',
} as const;

export const client_shared_list: BuiltinToolDef = {
  slug: 'client_shared_list',
  readOnly: true,
  name: 'List what is shared with the client',
  description:
    'List the items the team has shared with clients (pages, notes, tables, drawings, files), newest first: exactly the client\'s "Shared with you" list. `q` matches words in the title. Open one with `client_shared_open`; find one by its contents with `client_shared_search`.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: kindProp,
      q: { type: 'string', maxLength: 200, description: "Words in the title, e.g. 'inspection'." },
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
    if (!clientOf(ctx)) return { ok: false, error: NOT_CLIENT };
    const kind = strOpt(input.kind);
    if (kind && !(CLIENT_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, error: `unknown kind '${kind}'; use one of ${CLIENT_KINDS.join(', ')}.` };
    }
    const res = await asClient(() =>
      listClientShared(ctx.ownerId, {
        ...(kind ? { kind: kind as ClientKind } : {}),
        ...(strOpt(input.q) ? { q: strOpt(input.q) } : {}),
        limit: Math.min(numOpt(input.limit) ?? 50, 100),
      }),
    );
    ctx.step?.setMeta({ count: res.items.length });
    return { ok: true, output: { items: res.items.map(rowOut), total: res.total } };
  },
};

export const client_shared_search: BuiltinToolDef = {
  slug: 'client_shared_search',
  readOnly: true,
  name: 'Search what is shared with the client',
  description:
    'Find items shared with clients by the words they contain: matches the title and the text the client sees (drawings and files by title and file name only). Returns each matching item with a short passage. Word search, not meaning: try the words the item would use. Open a hit with `client_shared_open`.',
  inputSchema: {
    type: 'object',
    properties: {
      q: { type: 'string', minLength: 2, maxLength: 200, description: "e.g. 'shutdown schedule'" },
      kind: kindProp,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        default: 8,
        description: 'Max hits to return.',
      },
    },
    required: ['q'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    if (!clientOf(ctx)) return { ok: false, error: NOT_CLIENT };
    const terms = searchTerms(str(input.q));
    if (!terms.length) return { ok: false, error: 'give at least one word of two letters or more' };
    const kind = strOpt(input.kind);
    if (kind && !(CLIENT_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, error: `unknown kind '${kind}'; use one of ${CLIENT_KINDS.join(', ')}.` };
    }
    const limit = Math.min(numOpt(input.limit) ?? 8, 20);
    // Matched on what the CLIENT reads (the redacted text), never on the raw
    // page text or the index built from it: a word that only a Private item's
    // title carries must not find the page that mentions it.
    const hits = await asClient(async () => {
      const { items } = await listClientShared(ctx.ownerId, {
        ...(kind ? { kind: kind as ClientKind } : {}),
        limit: SEARCH_SCAN,
      });
      const titleHits = (r: ClientSharedRow) =>
        terms.filter((t) => r.title.toLowerCase().includes(t)).length;
      // Title matches are opened first, then the newest.
      const order = [...items].sort((a, b) => titleHits(b) - titleHits(a));
      const found: { row: ClientSharedRow; score: number; passage: string }[] = [];
      for (const row of order.slice(0, SEARCH_OPEN_MAX)) {
        const item = await getClientSharedItem(ctx.ownerId, row.id);
        if (!item) continue;
        const body =
          item.type === 'file' ? `${item.filename}\n${clientItemText(item)}` : clientItemText(item);
        const text = `${item.title}\n${body}`.toLowerCase();
        const score = terms.filter((t) => text.includes(t)).length;
        if (score > 0) found.push({ row, score, passage: snippetAround(body, terms) });
      }
      return found.sort((a, b) => b.score - a.score).slice(0, limit);
    });
    ctx.step?.setMeta({ hits: hits.length, terms: terms.length });
    return {
      ok: true,
      output: {
        hits: hits.map((h) => ({ ...rowOut(h.row), matched: h.score, passage: h.passage })),
        ...(hits.length ? {} : { note: 'nothing shared with clients matches those words' }),
      },
    };
  },
};

export const client_shared_open: BuiltinToolDef = {
  slug: 'client_shared_open',
  readOnly: true,
  name: 'Open an item shared with the client',
  description:
    "Read one item shared with clients as the client sees it: a page's or note's text, a table's rows, or what a drawing or file is. A reference shown as \"Private item\" is something the client may not see: never guess or reveal what it is. `tab_id` picks a table's tab (the answer lists them).",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The item id, from client_shared_list or _search.' },
      tab_id: { type: 'string', description: "A table's tab id." },
    },
    required: ['id'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    if (!clientOf(ctx)) return { ok: false, error: NOT_CLIENT };
    const id = str(input.id).trim();
    const notFound = {
      ok: false as const,
      error:
        'item not found among the items shared with clients; list them with client_shared_list.',
    };
    if (!UUID_RE.test(id)) return notFound;
    const item = await asClient(() =>
      getClientSharedItem(
        ctx.ownerId,
        id,
        strOpt(input.tab_id) ? { tabId: strOpt(input.tab_id) } : {},
      ),
    );
    if (!item) return notFound;
    const body = clip(clientItemText(item));
    ctx.step?.setMeta({ type: item.type, chars: body.text.length });
    return {
      ok: true,
      output: {
        ...rowOut(item),
        ...(item.type === 'table'
          ? { tabs: item.table.tabs ?? [], tabId: item.table.tabId, rowCount: item.table.rowCount }
          : {}),
        ...body,
      },
    };
  },
};

export const client_request_create: BuiltinToolDef = {
  slug: 'client_request_create',
  name: 'File a client request',
  description:
    'File a REQUEST from the client you are serving for the team: a correction, an update, a document or an answer the shared items do not give. You cannot change anything yourself; this is your only write action. ' +
    "`title` is a short imperative summary ('Send the revised inspection schedule'); `body` restates the request in full: what the client needs, which shared items it concerns (link them), and why. " +
    'After filing, tell the client a person on the team will look at it; do not promise the outcome. ' +
    `Limit: ${CLIENT_REQUESTS_PER_TURN} per message, ${CLIENT_REQUESTS_PER_DAY} a day.`,
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Short imperative summary of the request.',
      },
      body: {
        type: 'string',
        minLength: 1,
        maxLength: 8000,
        description: 'The full request, written so the team can act without reading the chat.',
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: "How urgent the client says it is; defaults to 'normal'.",
      },
    },
    required: ['title', 'body'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const s = ctx.surface;
    if (s?.kind !== 'client' || !s.loginId) return { ok: false, error: NOT_CLIENT };
    const title = str(input.title).trim().slice(0, 200);
    const body = str(input.body).trim().slice(0, 8000);
    if (!title || !body) return { ok: false, error: 'title and body required' };
    // Provenance from the server-stamped surface, never from the model.
    const { loginId, contactName, inboundMessageId } = s;

    // The caps count the filing ledger, not the live tasks (C5 audit fix
    // I12): an admin deleting a request never gives the quota back. Admin
    // level, so asSystem: the client role cannot read it.
    if (inboundMessageId) {
      const thisTurn = await asSystem(() =>
        countClientRequestFilings(ctx.ownerId, { threadMessageId: inboundMessageId }),
      );
      if (thisTurn >= CLIENT_REQUESTS_PER_TURN) {
        return {
          ok: false,
          error:
            `request limit reached: ${CLIENT_REQUESTS_PER_TURN} requests per message. Tell the client ` +
            'the requests so far are with the team, and to send any others in a later message.',
        };
      }
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (
      (await asSystem(() => countClientRequestFilings(ctx.ownerId, { loginId, since }))) >=
      CLIENT_REQUESTS_PER_DAY
    ) {
      return {
        ok: false,
        error:
          `request limit reached: ${CLIENT_REQUESTS_PER_DAY} requests in 24 hours. Tell the client ` +
          'the requests so far are with the team, and to try again tomorrow.',
      };
    }

    try {
      const who = contactName?.trim() || 'a client';
      const priority = strOpt(input.priority);
      // asSystem: the client role never writes; the request is an admin task
      // filed on the client's behalf with server-stamped provenance. A team
      // request in the same queue (the admin's reply reaches the client's
      // thread by login), marked client-sourced: extract-exempt until an admin
      // acts, and a staff turn that reads it cannot lower a level without
      // approval (plan N18).
      const row = await asSystem(() =>
        createTask(ctx.ownerId, {
          title,
          body: `**Client request from ${who}.**\n\n${body}`,
          priority: (['low', 'normal', 'high'].includes(priority ?? '')
            ? priority
            : 'normal') as TaskPriority,
          tags: [TEAM_REQUEST_TAG, CLIENT_REQUEST_TAG],
          extraData: {
            source: CLIENT_REQUEST_SOURCE,
            teamRequest: {
              contactId: null,
              loginId,
              contactName: contactName ?? null,
              requesterRole: 'client',
              threadMessageId: inboundMessageId ?? null,
              attachments: [],
              filedAt: new Date().toISOString(),
            },
          },
        }),
      );
      await asSystem(() =>
        recordClientRequestFiling(ctx.ownerId, {
          loginId,
          threadMessageId: inboundMessageId ?? null,
          taskId: row.id,
        }),
      );
      ctx.step?.setMeta({ taskId: row.id });
      return { ok: true, output: { id: row.id, title: row.title, status: 'with the team' } };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const CLIENT_TOOLS: readonly BuiltinToolDef[] = [
  client_shared_list,
  client_shared_search,
  client_shared_open,
  client_request_create,
];
