import { db, nodes, type Node } from '@mantle/db';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { withHnswPool } from './hnsw';
import { pgArrayLiteral } from './pg';

export { withHnswPool } from './hnsw';

export {
  goldRank,
  parseEvalCases,
  scoreRanks,
  type RecallEvalCase,
  type RecallScores,
} from './eval';

export {
  searchEntities,
  entityNeighbors,
  entityFacts,
  entityMentions,
  entityRelationsFor,
  graphPath,
  type RelationTriple,
  type EntitySearchOptions,
  type EntityHit,
  type NeighborOptions,
  type Neighbor,
  type FactsOptions,
  type MentionsOptions,
  type EntityMention,
  type GraphPathOptions,
  type GraphHop,
  type GraphPathResult,
} from './entities';

export {
  searchChunks,
  readSection,
  buildSectionOutline,
  selectSectionChunks,
  assembleSection,
  type ChunkHit,
  type ChunkSearchOptions,
  type SectionRange,
  type ReadSectionOptions,
  type ReadSectionResult,
} from './chunks';

export interface SearchOptions {
  ownerId: string;
  q?: string;
  /** Restrict to a branch (ltree prefix, e.g. "printers.suppliers"). */
  branch?: string;
  type?: Node['type'];
  /** Restrict to these node types (plural OR). Composable with `type`. */
  types?: string[];
  tags?: string[];
  since?: Date;
  limit?: number;
  /**
   * Hard allowlist of node ids — results are strictly a subset. Used by the
   * federation surface to run hybrid search over exactly the peer's granted
   * set (`peer_shares`), preserving the "no unscoped variant" invariant.
   */
  ids?: string[];
  /**
   * When provided, rank **semantically**: a weighted blend of vector similarity
   * (primary) and full-text rank (a booster for exact-term hits). Without it,
   * `searchNodes` keeps its legacy behaviour — FTS as a hard filter, or recency
   * when there's no `q`. The recall eval (docs/recall-eval.md) measured the
   * legacy FTS-only path at R@1 8% vs vector at 90%, which is why the tool
   * surfaces now pass an embedding.
   */
  queryEmbedding?: number[];
  /**
   * Vector vs FTS weight in the hybrid blend, 0..1. Default 0.7 — vector-led,
   * because the eval showed equal-weight fusion *regresses* against pure vector
   * (the weak FTS arm drags it down). FTS only breaks ties / rescues exact-term
   * queries here; it can't filter a semantically-relevant node out.
   */
  semanticWeight?: number;
}

const RRF_K = 60;

/** Salience down-weight strength: effective distance = cosine + λ·(1 − salience),
 *  so bulk/marketing mail can't crowd out real content. Non-email nodes are 1.0
 *  (no change). Keep in sync with @mantle/agent-runtime; tunable via env. */
const SALIENCE_LAMBDA = Number(process.env.MANTLE_SALIENCE_LAMBDA ?? 0.15);

/**
 * Node search. Two modes:
 *  - **hybrid** (when `queryEmbedding` is set): weighted Reciprocal-Rank Fusion
 *    of a vector-ranked pool and an FTS-ranked pool. Vector is the spine; FTS is
 *    a down-weighted booster. This is what the `search` / `search_nodes` tools
 *    use now.
 *  - **legacy** (no embedding): FTS-as-filter, or recency with no `q`. Kept for
 *    back-compat with callers that don't (yet) embed the query.
 */
export async function searchNodes(opts: SearchOptions): Promise<Node[]> {
  const filters: SQL[] = [eq(nodes.ownerId, opts.ownerId)];
  if (opts.type) filters.push(eq(nodes.type, opts.type));
  if (opts.types?.length)
    filters.push(sql`${nodes.type}::text = any(${pgArrayLiteral(opts.types)}::text[])`);
  if (opts.branch) filters.push(sql`${nodes.path} <@ ${opts.branch}::ltree`);
  if (opts.tags?.length) filters.push(sql`${nodes.tags} && ${opts.tags}::text[]`);
  if (opts.since) filters.push(sql`${nodes.createdAt} >= ${opts.since}`);
  // One array-literal param (`= any`) rather than inArray's one-param-per-id —
  // the federation allowlist can be thousands of granted ids.
  if (opts.ids) filters.push(sql`${nodes.id} = any(${pgArrayLiteral(opts.ids)}::uuid[])`);
  const limit = opts.limit ?? 50;

  // ── Legacy path: no query vector → FTS hard filter, or recency. ──────────
  if (!opts.queryEmbedding) {
    const conds = [...filters];
    const orderBy = opts.q
      ? sql`ts_rank(${nodes.searchTsv}, plainto_tsquery('english', ${opts.q})) desc`
      : desc(nodes.updatedAt);
    if (opts.q) conds.push(sql`${nodes.searchTsv} @@ plainto_tsquery('english', ${opts.q})`);
    return db.select().from(nodes).where(and(...conds)).orderBy(orderBy).limit(limit);
  }

  // ── Hybrid path: fuse a vector pool with an FTS pool via weighted RRF. ────
  const pool = Math.min(Math.max(limit * 5, 50), 200);
  const vec = JSON.stringify(opts.queryEmbedding);
  const wVec = opts.semanticWeight ?? 0.7;
  const wFts = 1 - wVec;

  // Salience-adjusted: demote bulk/marketing mail in the vector arm (the
  // dominant RRF contributor) so it falls in rank. The adjustment lives in the
  // OUTER re-rank, not the scan's ORDER BY — an adjusted ORDER BY is not
  // HNSW-eligible and forces a full scan + sort at scale (see hnsw.ts).
  const vectorRows = (await withHnswPool(pool, (tx) =>
    tx.execute(sql`
      select id from (
        select ${nodes.id} as id, ${nodes.salience} as salience,
               ${nodes.embedding} <=> ${vec}::vector as dist
        from ${nodes}
        where ${and(...filters, sql`${nodes.embedding} is not null`)}
        order by ${nodes.embedding} <=> ${vec}::vector
        limit ${pool}
      ) c
      order by dist + ${SALIENCE_LAMBDA} * (1 - salience)
      limit ${pool}
    `),
  )) as unknown as { id: string }[];

  let ftsRows: { id: string }[] = [];
  if (opts.q && opts.q.trim()) {
    ftsRows = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(...filters, sql`${nodes.searchTsv} @@ plainto_tsquery('english', ${opts.q})`))
      .orderBy(sql`ts_rank(${nodes.searchTsv}, plainto_tsquery('english', ${opts.q})) desc`)
      .limit(pool);
  }

  const score = new Map<string, number>();
  vectorRows.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + wVec / (RRF_K + i + 1)));
  ftsRows.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + wFts / (RRF_K + i + 1)));

  const topIds = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
  if (topIds.length === 0) return [];

  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.ownerId, opts.ownerId), inArray(nodes.id, topIds)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return topIds.map((id) => byId.get(id)).filter((r): r is Node => Boolean(r));
}
