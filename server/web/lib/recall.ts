/**
 * Recall: the owner UI's HTTP side over the serving layer (recall_maps /
 * recall_nodes; docs/recall.md). The owner UI talks HTTP, not MCP, so these
 * back `/api/recall/**` the way lib/journal backs `/api/journal`.
 *
 * A map is authored through the routes: the rows are the source, written by
 * packages/content/src/recall-native.ts. Page-built (v1) maps were retired in
 * R5; a leftover row without its tree item is never listed or opened.
 *
 * Unlike the agent-facing `recall_index`, the catalog here includes maps an
 * agent made that the owner has not published yet, and maps with no cards.
 */
import { and, asc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { NextResponse } from '@/server/http-compat';
import { db, nodes, recallMaps, recallNodes } from '@mantle/db';
import {
  RecallWriteError,
  getRecallCard,
  listRecallRevisions,
  recallFolderCrumbs,
} from '@mantle/content';
import type {
  RecallCardDetailDTO,
  RecallMapDetailDTO,
  RecallMapSummaryDTO,
  RecallNodeDTO,
  RecallRevisionDTO,
} from '@mantle/client-types';

type MapRow = typeof recallMaps.$inferSelect;

function toSummary(row: MapRow, folder: string | null = null): RecallMapSummaryDTO {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    enterWhen: row.enterWhen,
    nodeCount: row.nodeCount,
    // Every served row has its item: the queries below filter the rest.
    nodeId: row.nodeId!,
    // Resolved by the caller from the map item's path (`withFolders`); null
    // for a map filed at the Recall root.
    folder,
    published: row.published,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Summaries with their folder crumbs, resolved the way `recall_index` does:
 * from the path of each map's item, in one extra query for the whole list.
 */
async function withFolders(ownerId: string, rows: MapRow[]): Promise<RecallMapSummaryDTO[]> {
  const itemIds = rows.map((r) => r.nodeId).filter((id): id is string => id !== null);
  const items =
    itemIds.length === 0
      ? []
      : await db
          .select({ id: nodes.id, path: nodes.path })
          .from(nodes)
          .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, itemIds)));
  const pathOf = new Map(items.map((i) => [i.id, i.path === null ? null : String(i.path)]));
  const crumbs = await recallFolderCrumbs(
    ownerId,
    rows.map((r) => ({ id: r.id, path: r.nodeId ? (pathOf.get(r.nodeId) ?? null) : null })),
  );
  return rows.map((r) => toSummary(r, crumbs.get(r.id) ?? null));
}

/** A map row with no tree item is a leftover page-built (v1) map, retired in
 *  R5 (migration 0209 deletes them): never listed, never opened. */
function mapsWhere(ownerId: string, q?: string) {
  const mine = and(eq(recallMaps.ownerId, ownerId), isNotNull(recallMaps.nodeId));
  const trimmed = q?.trim();
  if (!trimmed) return mine;
  const like = `%${trimmed}%`;
  return and(mine, or(ilike(recallMaps.title, like), ilike(recallMaps.slug, like)));
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
  return await withFolders(ownerId, await query);
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
  if (!map || map.ownerId !== ownerId || map.nodeId === null) return null;

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
      rank: recallNodes.rank,
      promptPending: recallNodes.promptPending,
      updatedAt: recallNodes.updatedAt,
    })
    .from(recallNodes)
    .where(eq(recallNodes.mapId, map.id))
    // Card order is the owner's (drag to reorder); slug is the tiebreak.
    .orderBy(asc(recallNodes.rank), asc(recallNodes.slug));

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
      ...(o.targetId ? { targetId: o.targetId } : {}),
      ...(o.targetMap ? { targetMap: o.targetMap } : {}),
    })),
    sourceVersion: n.sourceVersion,
    rank: n.rank,
    promptPending: n.promptPending,
    updatedAt: n.updatedAt.toISOString(),
  }));
  const [summary] = await withFolders(ownerId, [map]);
  return { ...summary!, nodes };
}

// ── v2: the write side ───────────────────────────────────────────────────────

/**
 * A refused write is a 400 with the module's own message, which is written to
 * be actionable ("split it: keep the overview here…"). Anything that is not a
 * RecallWriteError is a bug, not a refusal, and is rethrown so `app.onError`
 * answers an opaque 500 rather than this layer inventing a reason.
 */
/** The refusals that mean the THING addressed is missing. A bad reference
 *  inside a body (an option to a missing map, a folder that does not exist)
 *  is a 400: the request was wrong, not the address. */
const RECALL_NOT_FOUND_CODES = new Set(['map_not_found', 'card_not_found', 'revision_not_found']);

export function recallWriteFailure(err: unknown): Response {
  if (err instanceof RecallWriteError) {
    const status = RECALL_NOT_FOUND_CODES.has(err.code)
      ? 404
      : err.code === 'version_stale'
        ? 409
        : 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  throw err;
}

/** One card with its body, for the editor. */
export async function getRecallCardDetail(
  ownerId: string,
  mapId: string,
  cardSlug: string,
): Promise<RecallCardDetailDTO | null> {
  const row = await getRecallCard(ownerId, mapId, cardSlug);
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind as RecallNodeDTO['kind'],
    title: row.title,
    useWhen: row.useWhen,
    bodyMd: row.bodyMd,
    bodyChars: row.bodyChars,
    options: (row.options ?? []).map((o) => ({
      label: o.label,
      useWhen: o.useWhen,
      targetSlug: o.targetSlug,
      ...(o.targetId ? { targetId: o.targetId } : {}),
      ...(o.targetMap ? { targetMap: o.targetMap } : {}),
    })),
    sourceVersion: row.sourceVersion,
    rank: row.rank,
    promptPending: row.promptPending,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The revisions panel. `actorName` is the name stored with the revision (the
 *  agent's slug, 'mcp', or the admin's display name); null on rows written
 *  before migration 0206. */
export async function getRecallRevisions(
  ownerId: string,
  mapId: string,
): Promise<RecallRevisionDTO[]> {
  const rows = await listRecallRevisions(ownerId, mapId);
  return rows.map((r) => ({
    id: r.id,
    cardId: r.cardId,
    cardSlug: r.cardSlug,
    actorKind: r.actorKind,
    actorName: r.actorName,
    summary: r.summary,
    createdAt: r.createdAt,
  }));
}
