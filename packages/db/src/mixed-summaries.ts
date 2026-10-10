/**
 * An item's older summary, set aside by the W2 mark (migration 0247): it was
 * made before always fold and may hold an embedded item's words, so only an
 * Admin user's item detail shows it, labelled; lists and search never do.
 * Admin pool only (no limited role may read node_mixed_summaries).
 */
import { eq } from 'drizzle-orm';
import { systemDb } from './client';
import { nodeMixedSummaries } from './schema/node-embeds';

export const OLDER_SUMMARY_LABEL = 'older summary, includes embedded items';

export async function olderSummaryOf(
  nodeId: string,
): Promise<{ text: string; label: string; at: string | null } | null> {
  const [r] = await systemDb
    .select({ summary: nodeMixedSummaries.summary, at: nodeMixedSummaries.summaryAt })
    .from(nodeMixedSummaries)
    .where(eq(nodeMixedSummaries.nodeId, nodeId))
    .limit(1);
  return r?.summary ? { text: r.summary, label: OLDER_SUMMARY_LABEL, at: r.at ?? null } : null;
}
