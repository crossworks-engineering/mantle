import { db, nodes, type Node } from '@mantle/db';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

export {
  searchEntities,
  entityNeighbors,
  entityFacts,
  entityMentions,
  type EntitySearchOptions,
  type EntityHit,
  type NeighborOptions,
  type Neighbor,
  type FactsOptions,
  type MentionsOptions,
  type EntityMention,
} from './entities';

export { searchChunks, type ChunkHit, type ChunkSearchOptions } from './chunks';

export interface SearchOptions {
  ownerId: string;
  q?: string;
  /** Restrict to a branch (ltree prefix, e.g. "printers.suppliers"). */
  branch?: string;
  type?: Node['type'];
  tags?: string[];
  since?: Date;
  limit?: number;
}

/**
 * Hybrid search. v1 does full-text + branch + tag filtering; vector search
 * lights up once embeddings are generated in v1.1.
 */
export async function searchNodes(opts: SearchOptions): Promise<Node[]> {
  const conds: SQL[] = [eq(nodes.ownerId, opts.ownerId)];

  if (opts.type) conds.push(eq(nodes.type, opts.type));
  if (opts.branch) conds.push(sql`${nodes.path} <@ ${opts.branch}::ltree`);
  if (opts.tags?.length) conds.push(sql`${nodes.tags} && ${opts.tags}::text[]`);
  if (opts.since) conds.push(sql`${nodes.createdAt} >= ${opts.since}`);

  const orderBy = opts.q
    ? sql`ts_rank(${nodes.searchTsv}, plainto_tsquery('english', ${opts.q})) desc`
    : desc(nodes.updatedAt);

  if (opts.q) {
    conds.push(sql`${nodes.searchTsv} @@ plainto_tsquery('english', ${opts.q})`);
  }

  return db
    .select()
    .from(nodes)
    .where(and(...conds))
    .orderBy(orderBy)
    .limit(opts.limit ?? 50);
}
