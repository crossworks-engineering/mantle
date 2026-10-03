/**
 * Brain capacity accounting — real corpus counts measured against the split
 * policy from the scaling whitepaper ("Scaling Retrieval Without
 * Degradation"): a brain is split into a federated breakout brain BEFORE any
 * single index reaches the corpus sizes where the published literature records
 * flat-RAG degradation (~10⁵–10⁶ passages). Policy per brain:
 *
 *   documents        watch 10 000   split 20 000
 *   passage vectors  watch 50 000   split 100 000
 *
 * "Documents" = non-branch nodes (folders are structure, not content);
 * "passage vectors" = embedded content_chunks rows — the number that actually
 * grows the vector index (transcript-heavy corpora hit this axis first).
 * Shared by the dashboard capacity dial and the `brain_capacity` tool so
 * heartbeat alerts and the UI can never disagree.
 */
import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { contentChunks, db, nodes } from '@mantle/db';
import type { CapacityZone, BrainCapacity, RetrievalScore } from '@mantle/client-types';
import type { CapacityMetric } from '@mantle/client-types';
export type { CapacityMetric };
export type { CapacityZone, BrainCapacity };

export type CapacityLimits = { watch: number; split: number };

export const CAPACITY_POLICY: { docs: CapacityLimits; chunkVectors: CapacityLimits } = {
  docs: { watch: 10_000, split: 20_000 },
  chunkVectors: { watch: 50_000, split: 100_000 },
};

export function capacityZone(count: number, limits: CapacityLimits): CapacityZone {
  if (count >= limits.split) return 'split';
  if (count >= limits.watch) return 'watch';
  return 'green';
}

const metric = (count: number, limits: CapacityLimits): CapacityMetric => ({
  count,
  watch: limits.watch,
  split: limits.split,
  ratio: count / limits.split,
  zone: capacityZone(count, limits),
});

/** Pure zone/ratio computation — unit-tested; `corpusCapacity` adds the counts. */
export function computeCapacity(docCount: number, chunkVectorCount: number): BrainCapacity {
  const docs = metric(docCount, CAPACITY_POLICY.docs);
  const chunkVectors = metric(chunkVectorCount, CAPACITY_POLICY.chunkVectors);
  const worst = docs.ratio >= chunkVectors.ratio ? docs : chunkVectors;
  const order: CapacityZone[] = ['green', 'watch', 'split'];
  const zone = order[Math.max(order.indexOf(docs.zone), order.indexOf(chunkVectors.zone))]!;
  return { docs, chunkVectors, zone, pctOfSplit: Math.round(worst.ratio * 100) };
}

/**
 * The passage score of the newest `recall_eval` run note (tag
 * `recall-eval-run`, JSON content written by the builtin), or null when there
 * is none or it does not parse (pure). The `chunks` arm is read: it is the
 * `search_chunks` path agents use.
 */
export function retrievalFromRunNote(content: unknown, at: Date | string): RetrievalScore | null {
  if (typeof content !== 'string') return null;
  try {
    const run = JSON.parse(content) as {
      casesUsed?: unknown;
      chunks?: { recallAt10?: unknown; mrr?: unknown };
    };
    const r10 = run.chunks?.recallAt10;
    const mrr = run.chunks?.mrr;
    if (typeof r10 !== 'number' || typeof mrr !== 'number') return null;
    return {
      at: typeof at === 'string' ? at : at.toISOString(),
      cases: typeof run.casesUsed === 'number' ? run.casesUsed : 0,
      recallAt10: r10,
      mrr,
    };
  } catch {
    return null;
  }
}

async function latestRetrieval(ownerId: string): Promise<RetrievalScore | null> {
  const [row] = await db
    .select({ data: nodes.data, at: nodes.updatedAt })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'note'),
        sql`${nodes.tags} @> '{recall-eval-run}'::text[]`,
      ),
    )
    .orderBy(desc(nodes.updatedAt))
    .limit(1);
  if (!row) return null;
  return retrievalFromRunNote((row.data as Record<string, unknown> | null)?.content, row.at);
}

/** Live counts for one brain, measured against the split policy, plus the
 *  latest measured retrieval score. */
export async function corpusCapacity(ownerId: string): Promise<BrainCapacity> {
  const [docRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), ne(nodes.type, 'branch')));
  const [chunkRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contentChunks)
    .where(and(eq(contentChunks.ownerId, ownerId), isNotNull(contentChunks.embedding)));
  return {
    ...computeCapacity(docRow?.n ?? 0, chunkRow?.n ?? 0),
    retrieval: await latestRetrieval(ownerId),
  };
}
