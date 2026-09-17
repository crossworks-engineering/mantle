/**
 * Tables · read paths. List, count, tags, and the single-table read.
 *
 * The list deliberately does NOT materialize a workbook: counts come from the
 * registry's cached `stats` when the table is file-backed, so a directory of
 * large grids costs one query rather than one file parse per row.
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { fileStats } from '@mantle/tabledb';
import { draftAbsFor } from '../table-storage';
import { db, nodes, tables } from '@mantle/db';
import type { TableRow, TableDetail, TableSort } from '@mantle/content-core/table-model';
import { countsFromRegistry, detailOf, docsOf, rowOf, tabsFromStats } from './shared';

type ListTablesOpts = { query?: string; tag?: string; sort?: TableSort };

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
  return conds;
}

export async function listTables(
  ownerId: string,
  opts: ListTablesOpts & { limit?: number; offset?: number } = {},
): Promise<TableRow[]> {
  // Counts come from the registry `stats` column — the list NEVER opens
  // workbook files and only falls back to a JSONB parse for legacy rows that
  // haven't committed since v2 (thundering-herd guard, plan §9).
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
  opts: { tabId?: string } = {},
): Promise<TableDetail | null> {
  const [row] = await db
    .select({
      node: nodes,
      data: tables.data,
      draft: tables.draftData,
      storagePath: tables.storagePath,
      draftRev: tables.draftRev,
      stats: tables.stats,
    })
    .from(nodes)
    .leftJoin(tables, eq(tables.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
    .limit(1);
  if (!row) return null;
  // Tab list: the DRAFT file's when one exists (a tab added/renamed in the
  // draft must show), else registry stats (published, no file open needed).
  let tabs = row.storagePath ? tabsFromStats(row.stats) : undefined;
  if (row.storagePath) {
    const draftAbs = draftAbsFor(row.storagePath);
    if (existsSync(draftAbs)) {
      try {
        tabs = tabsFromStats(fileStats(draftAbs)) ?? tabs;
      } catch {
        // draft consumed by a concurrent commit — published stats stand
      }
    }
  }
  const tabId = opts.tabId ?? tabs?.[0]?.id;
  // Materialize the RESOLVED tab, not the caller's (possibly undefined) one:
  // when a draft tab_delete/tab_reorder changed the first tab, "default tab"
  // must mean the same tab on both the published and draft side (audit: the
  // payload mixed published tab A with draft tab B).
  const { data, draft, totalRows, docClipped } = docsOf(row, tabId);
  return detailOf(row.node, data, draft, {
    totalRows,
    docClipped,
    draftRev: row.draftRev ?? 0,
    ...(tabs ? { tabs } : {}),
    ...(tabs && tabId ? { tabId } : {}),
  });
}
