/**
 * Peers · scoped reads. The three surfaces a peer can actually call, and the
 * one function that decides what they see.
 *
 * `activePeerGrantNodeIds` resolves per-node and per-category grants into the
 * set this peer may read RIGHT NOW; every query below intersects the caller's
 * request with that set. A peer can therefore never reach a node that was not
 * explicitly shared per node or per category, and a revoked grant takes effect
 * on the next call rather than needing a cache flush.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, nodes, peerShares, peerShareScopes } from '@mantle/db';
import { grantUnionFilter, searchChunks, searchNodes } from '@mantle/search';
import { isPeerShareableType } from './grants';

export type PeerQueryOpts = {
  /** Free-text — ranked semantically when `queryEmbedding` is present, else FTS. Empty = list everything granted. */
  query?: string;
  /** Restrict to these node types. */
  types?: string[];
  limit?: number;
  /**
   * Embedding of `query` in the ANSWERING owner's vector space. Computed
   * server-side by the federation route (`embed(peer.ownerId, query)`) — the
   * wire request carries text only, so the protocol is unchanged. When present,
   * ranking is the same hybrid vector+FTS pipeline local search uses; when
   * absent (no query, or embedder down), ranking degrades to FTS.
   */
  queryEmbedding?: number[];
};

export type PeerQueryHit = {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  tags: string[];
  createdAt: string;
};

/**
 * The peer's active grant set — the explicit node ids plus the standing
 * category grants it is allowed to see, and the granting owner. The single
 * scoping source for every federation read; searches filter to a strict
 * subset of it. A node is readable iff (id ∈ nodeIds) OR (type ∈ nodeTypes).
 * No grants of either kind ⇒ ownerId null ⇒ every read path returns nothing.
 */
export async function activePeerGrantNodeIds(
  peerId: string,
): Promise<{ ownerId: string | null; nodeIds: string[]; nodeTypes: string[] }> {
  const [shareRows, scopeRows] = await Promise.all([
    db
      .select({ ownerId: peerShares.ownerId, nodeId: peerShares.nodeId })
      .from(peerShares)
      .where(and(eq(peerShares.peerId, peerId), isNull(peerShares.revokedAt))),
    db
      .select({ ownerId: peerShareScopes.ownerId, nodeType: peerShareScopes.nodeType })
      .from(peerShareScopes)
      .where(and(eq(peerShareScopes.peerId, peerId), isNull(peerShareScopes.revokedAt))),
  ]);
  return {
    ownerId: shareRows[0]?.ownerId ?? scopeRows[0]?.ownerId ?? null,
    nodeIds: shareRows.map((r) => r.nodeId),
    // Defence-in-depth: filter through the allowlist even on read, so a stray
    // row for a never-shareable type could still not open a category.
    nodeTypes: scopeRows.map((r) => r.nodeType).filter(isPeerShareableType),
  };
}

export const toPeerHit = (r: {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  tags: string[] | null;
  createdAt: Date;
}): PeerQueryHit => ({
  id: r.id,
  type: r.type,
  title: r.title,
  summary: r.summary,
  tags: r.tags ?? [],
  createdAt: r.createdAt.toISOString(),
});

/**
 * The federation read surface: nodes the peer is allowed to see (active
 * peer_shares) intersected with its query filters. This is the ONLY path a
 * peer's data ever travels — there is no unscoped variant: with a query the
 * grant set is passed to `searchNodes` as a hard id-allowlist, without one we
 * list the grants recency-first. Bumping the peer's last_contacted/seen
 * accounting is done by the caller (the API route, which also opens the trace).
 */
export async function queryForPeer(
  peerId: string,
  opts: PeerQueryOpts = {},
): Promise<PeerQueryHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const { ownerId, nodeIds, nodeTypes } = await activePeerGrantNodeIds(peerId);
  if (!ownerId || (nodeIds.length === 0 && nodeTypes.length === 0)) return [];
  const grants = { ids: nodeIds, types: nodeTypes };

  // ── Ranked path: search WITHIN the grant set (hybrid when embedded, FTS else).
  if (opts.query?.trim()) {
    const found = await searchNodes({
      ownerId,
      q: opts.query.trim(),
      queryEmbedding: opts.queryEmbedding,
      idsOrTypes: grants,
      types: opts.types?.length ? opts.types : undefined,
      limit,
    });
    return found.map((n) =>
      toPeerHit({
        id: n.id,
        type: n.type,
        title: n.title,
        summary:
          typeof (n.data as Record<string, unknown> | null)?.summary === 'string'
            ? ((n.data as Record<string, unknown>).summary as string)
            : null,
        tags: n.tags,
        createdAt: n.createdAt,
      }),
    );
  }

  // ── List path (no query): everything granted, recency-first. The grant union
  // is the same query-time predicate the ranked path uses — a category grant is
  // never materialized into an id list.
  const conds = [eq(nodes.ownerId, ownerId), grantUnionFilter(nodes.id, grants)];
  if (opts.types && opts.types.length > 0) {
    conds.push(inArray(sql`${nodes.type}::text`, opts.types));
  }
  const rows = await db
    .select({
      id: nodes.id,
      type: nodes.type,
      title: nodes.title,
      summary: sql<string | null>`${nodes.data}->>'summary'`,
      tags: nodes.tags,
      createdAt: nodes.createdAt,
    })
    .from(nodes)
    .where(and(...conds))
    .orderBy(desc(nodes.createdAt))
    .limit(limit);
  return rows.map(toPeerHit);
}

export type PeerChunkHit = {
  nodeId: string;
  nodeTitle: string;
  nodeType: string;
  ordinal: number;
  headingPath: string | null;
  text: string;
  distance: number;
};

/**
 * Passage-level federation read: vector search over `content_chunks` strictly
 * limited to the peer's granted nodes. Pure vector (no FTS fallback) — the
 * caller must supply an embedding; without one there is nothing to rank by.
 * Same no-unscoped-variant rule as `queryForPeer`.
 */
export async function searchChunksForPeer(
  peerId: string,
  embedding: number[],
  limit = 10,
): Promise<PeerChunkHit[]> {
  const capped = Math.min(Math.max(limit, 1), 50);
  const { ownerId, nodeIds, nodeTypes } = await activePeerGrantNodeIds(peerId);
  if (!ownerId || (nodeIds.length === 0 && nodeTypes.length === 0)) return [];
  return searchChunks({
    ownerId,
    embedding,
    nodeIdsOrTypes: { ids: nodeIds, types: nodeTypes },
    limit: capped,
  });
}

export type PeerNodeDetail = {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  tags: string[];
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/**
 * Fetch one node's full content for a peer — **only** if it is covered by an
 * active grant, per node (`peer_shares`) or per category (`peer_share_scopes`).
 * Returns null when ungranted (indistinguishable from not-found, so a peer
 * can't probe for the existence of nodes it wasn't given). The data bag is
 * returned verbatim so the peer gets the body/content it was granted; secrets
 * are never node-data anyway, and ungranted nodes never reach here.
 */
export async function getNodeForPeer(
  peerId: string,
  nodeId: string,
): Promise<PeerNodeDetail | null> {
  const { ownerId, nodeIds, nodeTypes } = await activePeerGrantNodeIds(peerId);
  if (!ownerId || (nodeIds.length === 0 && nodeTypes.length === 0)) return null;
  const [row] = await db
    .select({
      id: nodes.id,
      type: nodes.type,
      title: nodes.title,
      tags: nodes.tags,
      data: nodes.data,
      createdAt: nodes.createdAt,
      updatedAt: nodes.updatedAt,
    })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!row) return null;
  // Effective grant = explicit node grant OR standing category grant.
  if (!nodeIds.includes(row.id) && !nodeTypes.includes(row.type)) return null;
  const data = (row.data ?? {}) as Record<string, unknown>;
  const summary = typeof data.summary === 'string' ? data.summary : null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    summary,
    tags: row.tags ?? [],
    data,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
