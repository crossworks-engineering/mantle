/**
 * The member Library (member logins, Phase 1): the brain items a member login
 * may read. There is no ACCESS filter here on purpose. The routes read as the
 * login (`withViewer({ login }, …)`, workspaces W5b2): row security on
 * the workspace role shows the items the login's workspaces hold (their
 * grants), published content only (draft columns are never granted). A row
 * this code cannot see is simply absent, so a member can never reach an
 * admin item by id. A client's "Shared with you" reads the same way
 * (client-shared.ts).
 *
 * No level is read (workspaces W5c): a row carries no level badge, and no
 * level narrows the list. A level-role scope (a test) reads what that role's
 * row security shows.
 *
 * Read-only in Phase 1. Writing and personal spaces come in Phase 2.
 */
import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { db, nodes, currentScope } from '@mantle/db';
import { getNote } from './notes';
import { getPage } from './pages/read';
import { getTable } from './tables/read';
import {
  MEMBER_ITEM_KINDS as LIBRARY_KINDS,
  isMemberItemKind as isLibraryKind,
  type MemberItemKind as LibraryKind,
} from '@mantle/client-types/member-kinds';

/** What the Library lists: the member item kinds, the one list shared with
 *  personal spaces and the client (audit M2). Folders, apps and formulas
 *  come later. */
export {
  MEMBER_ITEM_KINDS as LIBRARY_KINDS,
  isMemberItemKind as isLibraryKind,
  type MemberItemKind as LibraryKind,
} from '@mantle/client-types/member-kinds';

export type LibraryRow = {
  id: string;
  type: LibraryKind;
  title: string;
  icon: string | null;
  summary: string | null;
  updatedAt: string;
};

/** Refuse to run at admin: this module exists to be read as a member (a
 *  login's workspace scope), and at admin it would list the whole brain. */
function assertLimited(): void {
  const kind = currentScope().kind;
  if (kind !== 'user') {
    throw new Error('member Library read outside a viewer scope: wrap it in withViewer');
  }
}

function rowOf(n: typeof nodes.$inferSelect): LibraryRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    type: n.type as LibraryKind,
    title: n.title,
    icon: typeof d.icon === 'string' && d.icon.trim() ? d.icon : null,
    summary: typeof d.summary === 'string' ? d.summary : null,
    updatedAt: n.updatedAt.toISOString(),
  };
}

/**
 * Images cut out of a document during ingest (a PDF's pictures, a slide's
 * screenshots) are file nodes that point back at their document through
 * `data.sourceFileId`. They made up much of a real Library and read as noise
 * ("… image 1 (p1)"), so the list leaves them out; they stay readable by id,
 * which is how the page or document that shows them reaches them. Only FILES
 * are dropped: a table or page made from a file is a real item of its own.
 */
const notExtractedFragment = sql`NOT (${nodes.type} = 'file' AND ${nodes.data} ? 'sourceFileId')`;

/** What the Library lists: this brain's items of a Library kind the reader
 *  reads, without extracted image fragments. */
function libraryWhere(anchorId: string, opts: { kind?: LibraryKind; q?: string } = {}) {
  const q = opts.q?.trim();
  return and(
    eq(nodes.ownerId, anchorId),
    opts.kind ? eq(nodes.type, opts.kind) : inArray(nodes.type, [...LIBRARY_KINDS]),
    notExtractedFragment,
    q ? ilike(nodes.title, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
  );
}

/** The Library, newest first: the items the reader reads, without
 *  extracted image fragments. `q` matches the title. */
export async function listLibrary(
  anchorId: string,
  opts: { kind?: LibraryKind; q?: string; limit?: number; offset?: number } = {},
): Promise<{ items: LibraryRow[]; total: number }> {
  assertLimited();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = libraryWhere(anchorId, opts);
  const [rows, [count]] = await Promise.all([
    db.select().from(nodes).where(where).orderBy(desc(nodes.updatedAt)).limit(limit).offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(nodes)
      .where(where),
  ]);
  return { items: rows.map(rowOf), total: count?.n ?? 0 };
}

/** The ids among `ids` the reader's Library holds: this brain's items the
 *  current scope reads (row security on the grants decides). For the one
 *  list's accepted rows: one the Library holds opens as the Library item. */
export async function libraryHolds(anchorId: string, ids: readonly string[]): Promise<Set<string>> {
  assertLimited();
  if (!ids.length) return new Set();
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.ownerId, anchorId), inArray(nodes.id, [...ids])));
  return new Set(rows.map((r) => r.id));
}

/** How many items the Library lists, per kind (zeros included): the stat
 *  tiles a members' home app shows. The same filter as `listLibrary`. */
export async function libraryCounts(anchorId: string): Promise<Record<LibraryKind, number>> {
  assertLimited();
  const rows = await db
    .select({ type: nodes.type, n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(libraryWhere(anchorId))
    .groupBy(nodes.type);
  const out = Object.fromEntries(LIBRARY_KINDS.map((k) => [k, 0])) as Record<LibraryKind, number>;
  for (const r of rows) if (isLibraryKind(r.type)) out[r.type] = r.n;
  return out;
}

export type LibraryItem =
  | (LibraryRow & { type: 'page'; doc: unknown; folderId?: string | null })
  | (LibraryRow & { type: 'note'; content: string })
  | (LibraryRow & { type: 'table'; table: NonNullable<Awaited<ReturnType<typeof getTable>>> })
  | (LibraryRow & { type: 'draw' })
  | (LibraryRow & {
      type: 'file';
      filename: string;
      mimeType: string | null;
      sizeBytes: number | null;
    });

/** One Library item with its readable body, or null when the reader cannot
 *  see it or it is not a Library kind. `tabId` picks a table's tab (default
 *  the first); the table's `tabs` list names them all. */
export async function getLibraryItem(
  anchorId: string,
  id: string,
  opts: { tabId?: string } = {},
): Promise<LibraryItem | null> {
  assertLimited();
  const [n] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, anchorId)))
    .limit(1);
  if (!n || !isLibraryKind(n.type)) return null;
  const base = rowOf(n);
  const d = (n.data ?? {}) as Record<string, unknown>;
  switch (n.type) {
    case 'page': {
      const page = await getPage(anchorId, id);
      // Its folder (folder phase 7), for a Folder index block set to `here`.
      return page
        ? { ...base, type: 'page', doc: page.doc, folderId: page.folderId ?? null }
        : null;
    }
    case 'note': {
      const note = await getNote(anchorId, id);
      return note ? { ...base, type: 'note', content: note.content } : null;
    }
    case 'table': {
      const table = await getTable(anchorId, id, { tabId: opts.tabId, unknownTabIsFirst: true });
      return table ? { ...base, type: 'table', table } : null;
    }
    case 'draw':
      return { ...base, type: 'draw' };
    case 'file':
      return {
        ...base,
        type: 'file',
        filename: typeof d.filename === 'string' ? d.filename : n.title,
        mimeType: typeof d.mime_type === 'string' ? d.mime_type : null,
        sizeBytes: Number(d.size_bytes ?? 0) || null,
      };
  }
}
