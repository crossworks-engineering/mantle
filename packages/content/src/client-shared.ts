/**
 * "Shared with you" (client logins C2): the items a CLIENT login reads. The
 * list and the item are the Library's (member-library.ts), read inside
 * `withViewer('client', …)`: row security on the client role shows client
 * items only, and the Library holds exactly the client level for a client
 * reader (decision 6), so there is no access filter here to get wrong.
 *
 * What this adds is the client's shape of each item: no staff field (no
 * author, no level, no app link; clients see the brand), and a page's doc or
 * a note's text with every reference to an item the client may not read
 * taken out (plan N6, client-redact.ts). Which references those are is ONE
 * query, at the client level, for every id the body names; the same query
 * gives the readable items' current titles, which their chips carry.
 *
 * No summary (audit B1): the extractor writes it from the page's whole text,
 * before any redaction, so it could name what the body calls "Private
 * item". A table is its committed grid only (audit B13, ClientSharedTable).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { currentSpaceScope, currentViewerLevel, db, nodes } from '@mantle/db';
import type { TableDetail } from '@mantle/content-core/table-model';
import type { ClientSharedItem, ClientSharedRow, ClientSharedTable } from '@mantle/client-types';
import {
  cellRefIds,
  clientOwnUrl,
  docRefIds,
  noteRefIds,
  redactClientCell,
  redactClientDoc,
  redactClientNote,
  type ClientRedactOptions,
} from './client-redact';
import { clientRedactOrigins } from './client-origins';
import { getLibraryItem, listLibrary, type LibraryKind, type LibraryRow } from './member-library';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Refuse to run anywhere but a plain client scope: at any other level the
 *  "readable" answer would be someone else's. */
function assertClient(): void {
  if (currentViewerLevel() !== 'client' || currentSpaceScope()) {
    throw new Error("client read outside withViewer('client')");
  }
}

/** The items among `ids` a client may read, with their current titles:
 *  client-level items of this brain (row security agrees; the level is also
 *  in the query). Keys lower-case. */
export async function clientReadable(
  anchorId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  assertClient();
  const wanted = [...new Set(ids.filter((i) => UUID.test(i)).map((i) => i.toLowerCase()))];
  if (!wanted.length) return new Map();
  const rows = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, anchorId), eq(nodes.audience, 'client'), inArray(nodes.id, wanted)),
    );
  return new Map(rows.map((r) => [r.id.toLowerCase(), r.title]));
}

/** The ids among `ids` a client may read (`clientReadable`'s keys). */
export async function clientReadableIds(
  anchorId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  return new Set((await clientReadable(anchorId, ids)).keys());
}

/** The redaction a client read uses, with the readable items' titles. */
function redactOptions(titles: ReadonlyMap<string, string>): ClientRedactOptions {
  return { ownUrl: clientOwnUrl(clientRedactOrigins()), titles };
}

/** A Library row as a client receives it: named fields only. */
function clientRowOf(r: LibraryRow): ClientSharedRow {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    icon: r.icon,
    updatedAt: r.updatedAt,
  };
}

/**
 * A table as a client receives it (audit B13): the committed grid of one tab
 * and what the reader needs to draw it (tabs, the window flag, the row
 * count), nothing else. A column is its id, name and type (no formula, no
 * reference source, no options). A cell that names an item the client may
 * not read reads "Private item".
 */
async function clientTableOf(anchorId: string, t: TableDetail): Promise<ClientSharedTable> {
  const values = t.data.rows.flatMap((r) => Object.values(r.cells).flat());
  const opts = { ownUrl: clientOwnUrl(clientRedactOrigins()) };
  const readable = await clientReadableIds(anchorId, cellRefIds(values, opts));
  return {
    data: {
      columns: t.data.columns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
      rows: t.data.rows.map((r) => ({
        id: r.id,
        cells: Object.fromEntries(
          Object.entries(r.cells).map(([k, v]) => [k, redactClientCell(v, readable, opts)]),
        ),
      })),
      ...(t.data.aggregates ? { aggregates: { ...t.data.aggregates } } : {}),
    },
    ...(t.docClipped ? { docClipped: true } : {}),
    ...(t.tabs
      ? { tabs: t.tabs.map(({ id, name, rows, columns }) => ({ id, name, rows, columns })) }
      : {}),
    tabId: t.tabId ?? null,
    rowCount: t.rowCount,
  };
}

/** "Shared with you", newest first. Client scope only. */
export async function listClientShared(
  anchorId: string,
  opts: { kind?: LibraryKind; q?: string; limit?: number; offset?: number } = {},
): Promise<{ items: ClientSharedRow[]; total: number }> {
  assertClient();
  const res = await listLibrary(anchorId, opts);
  return { items: res.items.map(clientRowOf), total: res.total };
}

/** One shared item with its body, redacted for the client, or null when the
 *  client may not read it. `tabId` picks a table's tab. Client scope only. */
export async function getClientSharedItem(
  anchorId: string,
  id: string,
  opts: { tabId?: string } = {},
): Promise<ClientSharedItem | null> {
  assertClient();
  const item = await getLibraryItem(anchorId, id, opts);
  if (!item) return null;
  const base = clientRowOf(item);
  switch (item.type) {
    case 'page': {
      const scan = { ownUrl: clientOwnUrl(clientRedactOrigins()) };
      const titles = await clientReadable(anchorId, docRefIds(item.doc, scan));
      const doc = redactClientDoc(item.doc, new Set(titles.keys()), redactOptions(titles));
      return { ...base, type: 'page', doc };
    }
    case 'note': {
      const scan = { ownUrl: clientOwnUrl(clientRedactOrigins()) };
      const titles = await clientReadable(anchorId, noteRefIds(item.content, scan));
      const content = redactClientNote(item.content, new Set(titles.keys()), redactOptions(titles));
      return { ...base, type: 'note', content };
    }
    case 'table':
      return { ...base, type: 'table', table: await clientTableOf(anchorId, item.table) };
    case 'draw':
      return { ...base, type: 'draw' };
    case 'file':
      return {
        ...base,
        type: 'file',
        filename: item.filename,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
      };
  }
}
