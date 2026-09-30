/**
 * The member Library (member logins, Phase 1): the brain items a member login
 * may read. There is no ACCESS filter here on purpose. The caller runs these
 * inside `withViewer('team', …)`, and Postgres row security on the team role
 * decides what exists: team-, client- and public-level workspace items,
 * published content only (draft columns are never granted). A row this code
 * cannot see is simply absent, so a member can never reach an admin item by id.
 *
 * The Library is narrower than what row security allows (client logins,
 * decision 6): a member (team level) lists team and client items, each row
 * carrying its `audience` so the app can badge a client item; a client lists
 * and opens client items only. Public items are not in anyone's Library
 * LIST: an open link makes an item public (0161), and listing every item
 * ever link-shared with an outsider was a surprise nobody chose. A member
 * still OPENS a public item by id (audit B10, Jason 2026-09-29): anyone with
 * its link can read it, so hiding it from staff helped nobody, and a team
 * page that gained an open link vanished from the member app while its
 * images still loaded. A public item reads as `audience: 'team'` there (no
 * Client badge: a client login does not read it).
 *
 * Read-only in Phase 1. Writing and personal spaces come in Phase 2.
 */
import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { currentViewerLevel, db, nodes, type ViewerLevel } from '@mantle/db';
import { isReadAt, readAtSql } from './item-level';
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

/** The levels an item in a Library can have (see LIBRARY_LEVELS). */
export type LibraryAudience = 'team' | 'client';

export type LibraryRow = {
  id: string;
  type: LibraryKind;
  title: string;
  icon: string | null;
  summary: string | null;
  /** 'client' = a client login reads it too (the app's Client badge). */
  audience: LibraryAudience;
  updatedAt: string;
};

/** The item levels each reader's Library lists and opens (decision 6). Every
 *  level is named; a level not here (or an empty list) lists nothing, so a
 *  new level fails closed until someone decides what its Library holds. */
const LIBRARY_LEVELS: Readonly<Record<ViewerLevel, readonly LibraryAudience[]>> = {
  admin: [],
  team: ['team', 'client'],
  client: ['client'],
  public: [],
};

/** The item levels each reader OPENS by id: the Library's, and for a member
 *  public items too (audit B10). A client does not: public is not a client
 *  level (client logins decision 3). */
const OPEN_LEVELS: Readonly<Record<ViewerLevel, readonly ViewerLevel[]>> = {
  admin: [],
  team: ['team', 'client', 'public'],
  client: ['client'],
  public: [],
};

/** The item levels a reader at `level` finds in their Library. */
export function libraryLevelsOf(level: ViewerLevel): readonly LibraryAudience[] {
  return Object.hasOwn(LIBRARY_LEVELS, level) ? LIBRARY_LEVELS[level] : [];
}

/** The levels of `table` the current reader has (empty for an unknown one). */
function levelsOf<T>(table: Readonly<Record<ViewerLevel, readonly T[]>>): readonly T[] {
  const level = currentViewerLevel();
  return Object.hasOwn(table, level) ? table[level] : [];
}

/** A level rule as SQL: false when the reader has no level there. An item
 *  counts at its own level OR the share it inherits from a folder holding it
 *  (folder sharing), the union rule the row policy uses: a note an admin keeps
 *  at admin in a folder shared with the team is in a member's Library. */
function levelWhere(levels: readonly string[] = levelsOf(LIBRARY_LEVELS)) {
  return readAtSql(levels);
}

/** Refuse to run at admin: this module exists to be read at a member's level,
 *  and at admin it would list the whole brain. */
function assertLimited(): void {
  if (currentViewerLevel() === 'admin') {
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
    // The list admits only these two; a public item opened by id (B10), or
    // anything else, reads as team: the Client badge is never gained. A
    // client reads it at its own level or through a client-shared folder.
    audience: isReadAt(n.audience, n.inheritedLevel, ['client']) ? 'client' : 'team',
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

/** What the Library lists: this brain's items of a Library kind at a level
 *  the reader's Library holds, without extracted image fragments. */
function libraryWhere(anchorId: string, opts: { kind?: LibraryKind; q?: string } = {}) {
  const q = opts.q?.trim();
  return and(
    eq(nodes.ownerId, anchorId),
    levelWhere(),
    opts.kind ? eq(nodes.type, opts.kind) : inArray(nodes.type, [...LIBRARY_KINDS]),
    notExtractedFragment,
    q ? ilike(nodes.title, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
  );
}

/** The Library, newest first: the items at a level the reader's Library
 *  holds, without extracted image fragments. `q` matches the title. */
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
  | (LibraryRow & { type: 'page'; doc: unknown })
  | (LibraryRow & { type: 'note'; content: string })
  | (LibraryRow & { type: 'table'; table: NonNullable<Awaited<ReturnType<typeof getTable>>> })
  | (LibraryRow & { type: 'draw' })
  | (LibraryRow & {
      type: 'file';
      filename: string;
      mimeType: string | null;
      sizeBytes: number | null;
    });

/** One Library item with its readable body, or null when the reader's level
 *  cannot see it, its level is not one the reader opens (OPEN_LEVELS: the
 *  list's, plus public for a member), or it is not a Library kind. `tabId`
 *  picks a table's tab (default the first); the table's `tabs` list names
 *  them all. */
export async function getLibraryItem(
  anchorId: string,
  id: string,
  opts: { tabId?: string } = {},
): Promise<LibraryItem | null> {
  assertLimited();
  const [n] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, anchorId), levelWhere(levelsOf(OPEN_LEVELS))))
    .limit(1);
  if (!n || !isLibraryKind(n.type)) return null;
  const base = rowOf(n);
  const d = (n.data ?? {}) as Record<string, unknown>;
  switch (n.type) {
    case 'page': {
      const page = await getPage(anchorId, id);
      return page ? { ...base, type: 'page', doc: page.doc } : null;
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
