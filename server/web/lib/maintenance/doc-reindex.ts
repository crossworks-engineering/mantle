/**
 * Re-index documentation nodes that lost their summary and node embedding.
 *
 * A docs sync (packages/files docs.ts `upsertDocFromDisk`) that finds a
 * changed file replaces `data` and nulls the embedding, then fires
 * `node_ingested`. When that notify landed while the agent was not listening
 * (the web worker reconciles at boot, during a roll), the node was never
 * re-extracted, and before the safety-net fix (`unextractedNodeConds` on
 * `updated_at`, `noExtractSinceWriteSql`) nothing caught an OLD node. Dev,
 * 2026-10-05: 365 documentation nodes with chunks but no summary and no node
 * embedding, so `search` and the corpus map missed them.
 *
 * The fix stops new cases inside the 7-day window; this remedy is for the
 * old ones. It spends: one extractor model call per doc (retrieval depth: a
 * summary, no facts), then the node embedding and the chunk embeddings. So
 * the dry run (the default) prints the count and an estimated USD, and
 * `--apply` re-queues through the ordinary extract queue in small batches,
 * waiting for each batch to finish. No cron, no trigger, no new path to a
 * model.
 *
 * Output is counts and ids only: safe on a client box (a crawled collection's
 * key or a doc title can name a client, so neither is printed).
 */
import { sql } from 'drizzle-orm';
import { db, extractExemptSql, extractSkippedSql, nodes } from '@mantle/db';
import type { ModelPrice } from './ocr-rescan';

/** What the extractor sends the model per doc: its system prompt plus the
 *  body, sliced to 8,000 chars (server/api extract/model.ts). Used only when
 *  the box has no run history to price from. */
export const ASSUMED_DOC_TOKENS = { in: 3500, out: 500 };

/**
 * Brain-owned documentation nodes with no node embedding, less the exempt
 * ones and those with a current terminal skip (the same exclusions as the
 * extractor's own safety nets). Oldest first.
 */
export async function findDocReindexCandidates(): Promise<string[]> {
  const rows = (await db.execute(sql`
    select ${nodes.id} as id from ${nodes}
     where public.mantle_is_brain_space(${nodes.ownerId})
       and ${nodes.type} = 'documentation'
       and ${nodes.embedding} is null
       and not ${extractExemptSql()}
       and not ${extractSkippedSql()}
     order by ${nodes.createdAt}
  `)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** What this box's extractor has really cost per run, from its traces. */
export type RunHistory = {
  runs: number;
  avgMicroUsd: number;
  maxMicroUsd: number;
  source: string;
};

/** Successful extractor runs with a recorded cost in the last 30 days:
 *  documentation runs first, else any type. Null under 5 runs. */
export async function extractRunHistory(): Promise<RunHistory | null> {
  const q = (docsOnly: boolean) => sql`
    select count(*)::int as n,
           coalesce(avg(t.cost_micro_usd), 0)::float8 as avg,
           coalesce(max(t.cost_micro_usd), 0)::float8 as max
      from public.traces t
      ${docsOnly ? sql`join ${nodes} on ${nodes.id} = t.subject_id and ${nodes.type} = 'documentation'` : sql``}
     where t.kind = 'extractor_run' and t.status = 'success'
       and t.cost_micro_usd > 0
       and t.created_at > now() - interval '30 days'`;
  for (const [docsOnly, label] of [
    [true, 'documentation'],
    [false, 'all'],
  ] as const) {
    const [r] = (await db.execute(q(docsOnly))) as unknown as Array<{
      n: number;
      avg: number;
      max: number;
    }>;
    if (r && r.n >= 5) {
      return {
        runs: r.n,
        avgMicroUsd: r.avg,
        maxMicroUsd: r.max,
        source: `this box's last 30 days: ${r.n} ${label} extractor runs`,
      };
    }
  }
  return null;
}

export type DocEstimate = { expectedUsd: number | null; worstUsd: number | null; basis: string };

/** Pure: price the re-index. Run history wins (it is what this box really
 *  paid); else the model price on the assumed tokens, worst case double. */
export function estimateDocReindexCost(args: {
  count: number;
  history: RunHistory | null;
  price: ModelPrice | null;
}): DocEstimate {
  if (args.history) {
    return {
      expectedUsd: (args.count * args.history.avgMicroUsd) / 1e6,
      worstUsd: (args.count * args.history.maxMicroUsd) / 1e6,
      basis: args.history.source,
    };
  }
  if (args.price) {
    const per =
      (ASSUMED_DOC_TOKENS.in * args.price.inPerM + ASSUMED_DOC_TOKENS.out * args.price.outPerM) /
      1e6;
    return {
      expectedUsd: args.count * per,
      worstUsd: args.count * per * 2,
      basis: `assumed ${ASSUMED_DOC_TOKENS.in} in / ${ASSUMED_DOC_TOKENS.out} out tokens per doc at ${args.price.source} price`,
    };
  }
  return { expectedUsd: null, worstUsd: null, basis: 'no run history and no known model price' };
}
