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
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { contentChunks, db, nodes } from '@mantle/db';

export type CapacityZone = 'green' | 'watch' | 'split';

export type CapacityLimits = { watch: number; split: number };

export const CAPACITY_POLICY: { docs: CapacityLimits; chunkVectors: CapacityLimits } = {
  docs: { watch: 10_000, split: 20_000 },
  chunkVectors: { watch: 50_000, split: 100_000 },
};

export type CapacityMetric = {
  count: number;
  watch: number;
  split: number;
  /** count / split — may exceed 1 when the split point is passed. */
  ratio: number;
  zone: CapacityZone;
};

export type BrainCapacity = {
  docs: CapacityMetric;
  chunkVectors: CapacityMetric;
  /** Worst zone across both axes — the brain's headline state. */
  zone: CapacityZone;
  /** Worst-axis fill as an integer percentage of the split budget (may exceed 100). */
  pctOfSplit: number;
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

/** Live counts for one brain, measured against the split policy. */
export async function corpusCapacity(ownerId: string): Promise<BrainCapacity> {
  const [docRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), ne(nodes.type, 'branch')));
  const [chunkRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contentChunks)
    .where(and(eq(contentChunks.ownerId, ownerId), isNotNull(contentChunks.embedding)));
  return computeCapacity(docRow?.n ?? 0, chunkRow?.n ?? 0);
}
