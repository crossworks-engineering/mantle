/**
 * Tables · read paths. List, count, tags, and the single-table read.
 *
 * The list deliberately does NOT materialize a workbook: counts come from the
 * registry's cached `stats` when the table is file-backed, so a directory of
 * large grids costs one query rather than one file parse per row.
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { fileStats, resolveStoragePath } from '@mantle/tabledb';
import { draftAbsOf } from '../table-storage';
import { db, draftAllowed, draftColumn, emailAttachmentSql, nodes, tables } from '@mantle/db';
import type { TableRow, TableDetail, TableSort } from '@mantle/content-core/table-model';
import { countsFromRegistry, detailOf, docsOf, rowOf, tabsFromStats } from './shared';
import { readsDrafts } from '@mantle/db/viewer';

type ListTablesOpts = {
  query?: string;
  tag?: string;
  sort?: TableSort;
  /** Leave out email attachments and items made from one (an API key
   *  without the Search area: access matrix M4, T4). */
  withoutEmailCopies?: boolean;
};

function tableOrderBy(sort?: TableSort) {
  switch (sort) {
    case 'newest':
      return desc(nodes.createdAt);
    case 'oldest':
      return asc(nodes.createdAt);
    case 'title':
      return asc(nodes.title);
    case 'edited':
    default:
      return desc(nodes.updatedAt);
  }
}

function tableConds(ownerId: string, opts: ListTablesOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${tables.dataText} ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  if (opts.withoutEmailCopies) conds.push(sql`not ${emailAttachmentSql()}`);
  return conds;
}

export async function listTables(
  ownerId: string,
  opts: ListTablesOpts & { limit?: number; offset?: number } = {},
): Promise<TableRow[]> {
  // Counts come from the registry `stats` column — the list NEVER opens
  // workbook files and only falls back to a JSONB parse for legacy rows
  // without stats (thundering-herd guard).
  const rows = await db
    .select({ node: nodes, data: tables.data, stats: tables.stats })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(...tableConds(ownerId, opts)))
    .orderBy(tableOrderBy(opts.sort))
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map((r) => rowOf(r.node, countsFromRegistry(r.stats, r.data)));
}

export async function countTables(ownerId: string, opts: ListTablesOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(...tableConds(ownerId, opts)));
  return row?.n ?? 0;
}

export async function listTableTags(ownerId: string): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .select({ tags: nodes.tags })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')));
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function getTable(
  ownerId: string,
  id: string,
  opts: {
    tabId?: string;
    /** An unknown `tabId` reads the first tab instead of throwing: for
     *  readers whose tab id comes from outside (a member's query string). */
    unknownTabIsFirst?: boolean;
    /** The saved table only, even where the scope reads drafts: for a reader
     *  on the admin pool who must not see an admin's working copy (the
     *  author of an accepted item, member-accepted.ts). */
    publishedOnly?: boolean;
  } = {},
): Promise<TableDetail | null> {
  // Below admin the draft is not readable: the published table only, and no
  // draft file from disk either. A member's own space reads its own draft.
  const askedPublished = opts.publishedOnly === true || !readsDrafts();
  const [row] = await db
    .select({
      node: nodes,
      data: tables.data,
      // Whether this caller may read the draft at all (the draft file on
      // disk follows the same rule as the draft columns).
      draftOk: askedPublished ? sql<boolean>`false` : draftAllowed(),
      // An Admin user's request scope reads a draft only of an item it may
      // edit (draftColumn: the rule is in the query).
      draft: askedPublished ? sql<null>`null` : draftColumn<unknown>(tables.draftData),
      storagePath: tables.storagePath,
      // The draft the row points at (the store broker), under the draft
      // columns' rule.
      draftPath: askedPublished ? sql<null>`null` : draftColumn<string>(tables.draftPath),
      draftRev: askedPublished ? sql<null>`null` : draftColumn<number>(tables.draftRev),
      stats: tables.stats,
    })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return null;
  // An Admin user with Read only, or a reader below admin: the published
  // table, and no draft file from disk.
  const published = askedPublished || row.draftOk !== true;
  // Tab list: the DRAFT file's when one exists (a tab added/renamed in the
  // draft must show), else registry stats (published, no file open needed).
  let tabs = row.storagePath ? tabsFromStats(row.stats) : undefined;
  if (row.storagePath && !published) {
    const draftAbs = draftAbsOf(row.draftPath);
    if (draftAbs && existsSync(draftAbs)) {
      try {
        tabs = tabsFromStats(fileStats(draftAbs)) ?? tabs;
      } catch {
        // draft consumed by a concurrent commit — published stats stand
      }
    }
  }
  const known = !opts.unknownTabIsFirst || tabs?.some((t) => t.id === opts.tabId);
  const tabId = (known ? opts.tabId : undefined) ?? tabs?.[0]?.id;
  // Materialize the RESOLVED tab, not the caller's (possibly undefined) one:
  // when a draft tab_delete/tab_reorder changed the first tab, "default tab"
  // must mean the same tab on both the published and draft side (never
  // published tab A with draft tab B).
  const { data, draft, totalRows, docClipped } = docsOf(row, tabId, { publishedOnly: published });
  return detailOf(row.node, data, draft, {
    totalRows,
    docClipped,
    draftRev: row.draftRev ?? 0,
    ...(tabs ? { tabs } : {}),
    ...(tabs && tabId ? { tabId } : {}),
  });
}

/**
 * A table as its author's accepted snapshot holds it: the workbook copy at `storagePath` (relative to TABLE_DB_DIR), or
 * the document of a table with no workbook. Never a draft. `node` supplies
 * the id and the other row fields; the caller passes the snapshot's title.
 */
export function tableFromSnapshot(
  node: typeof nodes.$inferSelect,
  snap: { storagePath: string | null; doc: unknown },
  opts: { tabId?: string } = {},
): TableDetail {
  let tabs: ReturnType<typeof tabsFromStats> | undefined;
  if (snap.storagePath) {
    try {
      tabs = tabsFromStats(fileStats(resolveStoragePath(snap.storagePath)));
    } catch {
      tabs = undefined;
    }
  }
  const known = tabs?.some((t) => t.id === opts.tabId);
  const tabId = (known ? opts.tabId : undefined) ?? tabs?.[0]?.id;
  const { data, totalRows, docClipped } = docsOf(
    { storagePath: snap.storagePath, data: snap.doc, draft: null },
    tabId,
    { publishedOnly: true },
  );
  return detailOf(node, data, null, {
    totalRows,
    docClipped,
    ...(tabs ? { tabs } : {}),
    ...(tabs && tabId ? { tabId } : {}),
  });
}
