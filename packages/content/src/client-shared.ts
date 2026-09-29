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
 * query, at the client level, for every id the body names.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { currentSpaceScope, currentViewerLevel, db, nodes } from '@mantle/db';
import type { ClientSharedItem, ClientSharedRow } from '@mantle/client-types';
import { docRefIds, noteRefIds, redactClientDoc, redactClientNote } from './client-redact';
import { getLibraryItem, listLibrary, type LibraryKind, type LibraryRow } from './member-library';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Refuse to run anywhere but a plain client scope: at any other level the
 *  "readable" answer would be someone else's. */
function assertClient(): void {
  if (currentViewerLevel() !== 'client' || currentSpaceScope()) {
    throw new Error("client read outside withViewer('client')");
  }
}

/** The ids among `ids` a client may read: client-level items of this brain
 *  (row security agrees; the level is also in the query). Lower-case. */
export async function clientReadableIds(
  anchorId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  assertClient();
  const wanted = [...new Set(ids.filter((i) => UUID.test(i)).map((i) => i.toLowerCase()))];
  if (!wanted.length) return new Set();
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, anchorId), eq(nodes.audience, 'client'), inArray(nodes.id, wanted)),
    );
  return new Set(rows.map((r) => r.id.toLowerCase()));
}

/** A Library row as a client receives it: named fields only. */
function clientRowOf(r: LibraryRow): ClientSharedRow {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    icon: r.icon,
    summary: r.summary,
    updatedAt: r.updatedAt,
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
      const readable = await clientReadableIds(anchorId, docRefIds(item.doc));
      return { ...base, type: 'page', doc: redactClientDoc(item.doc, readable) };
    }
    case 'note': {
      const readable = await clientReadableIds(anchorId, noteRefIds(item.content));
      return { ...base, type: 'note', content: redactClientNote(item.content, readable) };
    }
    case 'table':
      // The app a table mirrors is named by its app link: not the client's.
      return { ...base, type: 'table', table: item.table && { ...item.table, appLink: null } };
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
