/**
 * Recall — owner-UI reads over the COMPILED serving layer (recall_maps /
 * recall_nodes; docs/recall.md). The owner UI talks HTTP, not MCP, so these
 * back `/api/recall/**` the way lib/journal backs `/api/journal`.
 *
 * Deliberately read-only: authoring goes through the normal page
 * draft/commit path (the compiler, lint and trust model live there), so
 * there is no Recall write surface — here or anywhere else.
 *
 * Unlike the agent-facing `recall_index`, the catalog here includes maps
 * that never compiled clean (nodeCount 0): a failed compile is exactly what
 * the owner needs to see, and this API is the only place lint reports
 * become visible outside psql.
 */
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, recallMaps, recallNodes } from '@mantle/db';
import type {
  RecallLintIssueDTO,
  RecallMapDetailDTO,
  RecallMapSummaryDTO,
  RecallNodeDTO,
  RecallPageStateDTO,
} from '@mantle/client-types';

type MapRow = typeof recallMaps.$inferSelect;

function toSummary(row: MapRow): RecallMapSummaryDTO {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    enterWhen: row.enterWhen,
    nodeCount: row.nodeCount,
    lastCompileOk: row.lastCompileOk,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapsWhere(ownerId: string, q?: string) {
  const trimmed = q?.trim();
  if (!trimmed) return eq(recallMaps.ownerId, ownerId);
  const like = `%${trimmed}%`;
  return and(
    eq(recallMaps.ownerId, ownerId),
    or(ilike(recallMaps.title, like), ilike(recallMaps.slug, like)),
  );
}

export async function listRecallMaps(
  ownerId: string,
  opts: { q?: string; limit?: number; offset?: number } = {},
): Promise<RecallMapSummaryDTO[]> {
  let query = db
    .select()
    .from(recallMaps)
    .where(mapsWhere(ownerId, opts.q))
    .orderBy(asc(recallMaps.slug))
    .$dynamic();
  if (opts.limit !== undefined) query = query.limit(opts.limit);
  if (opts.offset) query = query.offset(opts.offset);
  const rows = await query;
  return rows.map(toSummary);
}

export async function countRecallMaps(ownerId: string, q?: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(recallMaps)
    .where(mapsWhere(ownerId, q));
  return row?.n ?? 0;
}

export async function getRecallMapDetail(
  ownerId: string,
  id: string,
): Promise<RecallMapDetailDTO | null> {
  const [map] = await db.select().from(recallMaps).where(eq(recallMaps.id, id)).limit(1);
  if (!map || map.ownerId !== ownerId) return null;

  const rows = await db
    .select({
      id: recallNodes.id,
      slug: recallNodes.slug,
      kind: recallNodes.kind,
      title: recallNodes.title,
      useWhen: recallNodes.useWhen,
      bodyChars: recallNodes.bodyChars,
      options: recallNodes.options,
      sourceVersion: recallNodes.sourceVersion,
      updatedAt: recallNodes.updatedAt,
    })
    .from(recallNodes)
    .where(eq(recallNodes.mapId, map.id))
    .orderBy(asc(recallNodes.slug));

  const nodes: RecallNodeDTO[] = rows.map((n) => ({
    id: n.id,
    slug: n.slug,
    kind: n.kind as RecallNodeDTO['kind'],
    title: n.title,
    useWhen: n.useWhen,
    bodyChars: n.bodyChars,
    options: (n.options ?? []).map((o) => ({
      label: o.label,
      useWhen: o.useWhen,
      targetSlug: o.targetSlug,
    })),
    sourceVersion: n.sourceVersion,
    updatedAt: n.updatedAt.toISOString(),
  }));
  // The index (the root — its node id IS the map id) always leads.
  nodes.sort((a, b) => Number(b.id === map.id) - Number(a.id === map.id));

  return {
    ...toSummary(map),
    report: (map.lastCompileReport as RecallLintIssueDTO[] | null) ?? null,
    nodes,
  };
}

/**
 * This page's place in Recall, if any — backs the editor lint badge. Two
 * lookups: the compiled row (the common case), then failing reports that
 * NAME this page (a brand-new page that broke its map has no compiled row,
 * and that is exactly when the badge matters most).
 */
export async function getRecallStateForPage(
  ownerId: string,
  pageId: string,
): Promise<RecallPageStateDTO | null> {
  const [node] = await db.select().from(recallNodes).where(eq(recallNodes.id, pageId)).limit(1);

  let map: MapRow | undefined;
  let nodeInfo: RecallPageStateDTO['node'] = null;
  if (node && node.ownerId === ownerId) {
    [map] = await db.select().from(recallMaps).where(eq(recallMaps.id, node.mapId)).limit(1);
    nodeInfo = { slug: node.slug, kind: node.kind as RecallNodeDTO['kind'] };
  } else {
    [map] = await db
      .select()
      .from(recallMaps)
      .where(
        and(
          eq(recallMaps.ownerId, ownerId),
          sql`${recallMaps.lastCompileReport} @> ${JSON.stringify([{ pageId }])}::jsonb`,
        ),
      )
      .limit(1);
  }
  if (!map) return null;
  return {
    map: toSummary(map),
    node: nodeInfo,
    report: (map.lastCompileReport as RecallLintIssueDTO[] | null) ?? null,
  };
}
