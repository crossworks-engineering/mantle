/**
 * The member Library (member logins, Phase 1): the brain items a member login
 * may read. There is no ACCESS filter here on purpose. The caller runs these
 * inside `withViewer('team', …)`, and Postgres row security on the team role
 * decides what exists: team-, client- and public-level workspace items,
 * published content only (draft columns are never granted). A row this code
 * cannot see is simply absent, so a member can never reach an admin item by id.
 *
 * The LIST is narrower than what row security allows: it shows only items set
 * to exactly the reader's level. An open link makes an item client or public
 * (the agent emailing a page with a link does that), and listing every such
 * item to every member was a surprise nobody chose. Client and public items
 * stay readable by id (a link inside a team page opens them), and the team
 * agent can still read them; only the listing is narrowed. Jason, 2026-09-26.
 *
 * Read-only in Phase 1. Writing and personal spaces come in Phase 2.
 */
import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { asViewerLevel, currentViewerLevel, db, nodes, type ViewerLevel } from '@mantle/db';
import { getNote } from './notes';
import { getPage } from './pages/read';
import { getTable } from './tables/read';

/** What the Library lists. Folders, apps and formulas come later. */
export const LIBRARY_KINDS = ['page', 'note', 'draw', 'table', 'file'] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export function isLibraryKind(v: unknown): v is LibraryKind {
  return typeof v === 'string' && (LIBRARY_KINDS as readonly string[]).includes(v);
}

export type LibraryRow = {
  id: string;
  type: LibraryKind;
  title: string;
  icon: string | null;
  summary: string | null;
  audience: ViewerLevel;
  updatedAt: string;
};

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
    audience: asViewerLevel(n.audience),
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

/** The Library, newest first: the items set to exactly the reader's level,
 *  without extracted image fragments. `q` matches the title. */
export async function listLibrary(
  anchorId: string,
  opts: { kind?: LibraryKind; q?: string; limit?: number; offset?: number } = {},
): Promise<{ items: LibraryRow[]; total: number }> {
  assertLimited();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = opts.q?.trim();
  const where = and(
    eq(nodes.ownerId, anchorId),
    eq(nodes.audience, currentViewerLevel()),
    opts.kind ? eq(nodes.type, opts.kind) : inArray(nodes.type, [...LIBRARY_KINDS]),
    notExtractedFragment,
    q ? ilike(nodes.title, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
  );
  const [rows, [count]] = await Promise.all([
    db.select().from(nodes).where(where).orderBy(desc(nodes.updatedAt)).limit(limit).offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(nodes)
      .where(where),
  ]);
  return { items: rows.map(rowOf), total: count?.n ?? 0 };
}

export type LibraryItem =
  | (LibraryRow & { type: 'page'; doc: unknown })
  | (LibraryRow & { type: 'note'; content: string })
  | (LibraryRow & { type: 'table'; table: Awaited<ReturnType<typeof getTable>> })
  | (LibraryRow & { type: 'draw' })
  | (LibraryRow & {
      type: 'file';
      filename: string;
      mimeType: string | null;
      sizeBytes: number | null;
    });

/** One Library item with its readable body, or null when the member's level
 *  cannot see it (or it is not a Library kind). `tabId` picks a table's tab
 *  (default the first); the table's `tabs` list names them all. */
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
