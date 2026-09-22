/**
 * Pairwise cosine similarity between a handful of retrieved passages, for the
 * decider's `version_grouping` use: only pairs similar enough to be copies of
 * one passage are worth a question. One query; the embeddings never leave
 * Postgres. Two sections of the same node are never paired.
 */
import { sql } from 'drizzle-orm';
import { contentChunks, db } from '@mantle/db';

export type ChunkKey = { nodeId: string; ordinal: number };

export type ChunkPairSimilarity = { a: ChunkKey; b: ChunkKey; similarity: number };

/** Keys beyond this are ignored (n keys → n(n-1)/2 pairs). */
export const MAX_CHUNK_PAIR_KEYS = 30;

export async function chunkPairSimilarities(
  ownerId: string,
  keys: readonly ChunkKey[],
): Promise<ChunkPairSimilarity[]> {
  const unique = [...new Map(keys.map((k) => [`${k.nodeId}:${k.ordinal}`, k])).values()].slice(
    0,
    MAX_CHUNK_PAIR_KEYS,
  );
  if (unique.length < 2) return [];
  const values = sql.join(
    unique.map((k) => sql`(${k.nodeId}::uuid, ${k.ordinal}::int)`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    with k(node_id, ordinal) as (values ${values}),
    c as (
      select ${contentChunks.nodeId} as node_id, ${contentChunks.ordinal} as ordinal,
             ${contentChunks.embedding} as embedding
      from ${contentChunks}
      inner join k on k.node_id = ${contentChunks.nodeId} and k.ordinal = ${contentChunks.ordinal}
      where ${contentChunks.ownerId} = ${ownerId} and ${contentChunks.embedding} is not null
    )
    select a.node_id as a_node, a.ordinal as a_ord, b.node_id as b_node, b.ordinal as b_ord,
           1 - (a.embedding <=> b.embedding) as sim
    from c a join c b on a.node_id < b.node_id
  `)) as unknown as Array<{
    a_node: string;
    a_ord: number;
    b_node: string;
    b_ord: number;
    sim: number | string;
  }>;
  return rows.map((r) => ({
    a: { nodeId: r.a_node, ordinal: Number(r.a_ord) },
    b: { nodeId: r.b_node, ordinal: Number(r.b_ord) },
    similarity: typeof r.sim === 'number' ? r.sim : Number(r.sim),
  }));
}
