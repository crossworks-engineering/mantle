/**
 * HNSW query tuning shared by the vector arms in this package.
 *
 * pgvector's HNSW index can only serve a *bare* `embedding <=> $vec` ORDER BY.
 * Any arithmetic layered onto the distance — our salience adjustment — makes
 * the plan ineligible, and the query silently degrades to a full scan + sort:
 * the exact latency cliff migration 0057 was written to remove (verified with
 * EXPLAIN: with seq/bitmap scans force-disabled, the adjusted ORDER BY still
 * cannot touch nodes_embedding_idx). And once the index *is* used, a scan
 * returns at most `hnsw.ef_search` rows — default 40, i.e. a fifth of our
 * 200-candidate pools.
 *
 * So every vector arm follows one recipe:
 *   1. inner subquery: bare-distance ORDER BY + LIMIT pool  → index-eligible
 *   2. `SET LOCAL hnsw.ef_search` ≥ pool                    → pool honoured
 *   3. outer query: re-rank the pool with the adjustment terms
 *
 * Re-ranking inside the pool instead of over the whole table is a bounded
 * approximation: the salience penalty is at most λ·(1−0.25) ≈ 0.11 cosine, so
 * with pools ≥ 5× the requested limit only candidates within that band of the
 * pool boundary can differ — at small corpora the planner keeps choosing the
 * (exact) seq scan anyway, and at large corpora this is precisely the
 * approximation HNSW already makes.
 *
 * `withHnswPool` wraps step 2: one read-only transaction with the GUCs
 * applied locally. `hnsw.iterative_scan` (pgvector ≥ 0.8) is enabled in
 * relaxed mode so a filtered scan keeps walking the graph until the LIMIT is
 * satisfied instead of returning short after ef_search candidates; the probe
 * uses `current_setting(..., missing_ok => true)`, which yields NULL rather
 * than erroring on older pgvector.
 */
import { db } from '@mantle/db';
import { sql } from 'drizzle-orm';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const EF_SEARCH_MIN = 40; // pgvector's default — never tune below it
const EF_SEARCH_MAX = 1000; // pgvector's hard GUC ceiling

let hasIterativeScan: boolean | undefined;

export async function withHnswPool<T>(pool: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const ef = Math.min(Math.max(Math.ceil(pool), EF_SEARCH_MIN), EF_SEARCH_MAX);
  if (hasIterativeScan === undefined) {
    const probe = (await db.execute(
      sql`select current_setting('hnsw.iterative_scan', true) as v`,
    )) as unknown as Array<{ v: string | null }>;
    hasIterativeScan = probe[0]?.v != null;
  }
  return db.transaction(async (tx) => {
    // GUC values can't be bind parameters; `ef` is a clamped integer.
    await tx.execute(sql.raw(`set local hnsw.ef_search = ${ef}`));
    if (hasIterativeScan) {
      await tx.execute(sql.raw(`set local hnsw.iterative_scan = 'relaxed_order'`));
    }
    return fn(tx);
  });
}
