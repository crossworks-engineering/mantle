/**
 * Chunk-level vector retrieval (Phase 4). Where `searchNodes` ranks whole
 * nodes, this finds the most relevant *passage* inside a long page / file /
 * email by cosine distance over `content_chunks.embedding`, joined back to its
 * node for title/type/scope. Caller supplies a precomputed query embedding so
 * this package stays dependency-light (no embeddings dep).
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { contentChunks, db, nodes } from '@mantle/db';

/** Salience down-weight strength (see @mantle/search index). Tunable via env. */
const SALIENCE_LAMBDA = Number(process.env.MANTLE_SALIENCE_LAMBDA ?? 0.15);

export type ChunkHit = {
  nodeId: string;
  nodeTitle: string;
  nodeType: string;
  ordinal: number;
  headingPath: string | null;
  text: string;
  /** Cosine distance — lower = closer. */
  distance: number;
};

export type ChunkSearchOptions = {
  ownerId: string;
  embedding: number[];
  /** Restrict to an ltree branch prefix (e.g. "pages"). */
  branch?: string;
  limit?: number;
};

export async function searchChunks(opts: ChunkSearchOptions): Promise<ChunkHit[]> {
  const vec = JSON.stringify(opts.embedding);
  const conds = [eq(contentChunks.ownerId, opts.ownerId), isNotNull(contentChunks.embedding)];
  if (opts.branch) conds.push(sql`${nodes.path} <@ ${opts.branch}::ltree`);

  return db
    .select({
      nodeId: contentChunks.nodeId,
      nodeTitle: nodes.title,
      nodeType: sql<string>`${nodes.type}`,
      ordinal: contentChunks.ordinal,
      headingPath: contentChunks.headingPath,
      text: contentChunks.text,
      distance: sql<number>`${contentChunks.embedding} <=> ${vec}::vector`,
    })
    .from(contentChunks)
    .innerJoin(nodes, eq(nodes.id, contentChunks.nodeId))
    .where(and(...conds))
    // Rank by salience-adjusted distance so a bulk/marketing email's passages
    // can't outrank real content; the returned `distance` stays raw cosine.
    .orderBy(sql`(${contentChunks.embedding} <=> ${vec}::vector) + ${SALIENCE_LAMBDA} * (1 - ${nodes.salience})`)
    .limit(opts.limit ?? 10);
}
