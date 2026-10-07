/**
 * Retrieval-quality self-check — the automated half of docs/recall-eval.md.
 * A golden-case note (tag `recall-eval-cases`) pairs natural-language queries
 * with the nodes that should come back; `recall_eval` runs each query through
 * the shipped retrievers (hybrid `search_nodes` + passage `search_chunks`,
 * HYBRID as agents call it, plus the Jev-scored passage path when the
 * decider's passage_scoring has a `pool` set; vector-only passages stay as a
 * secondary line),
 * scores recall@k / MRR with the pure helpers in @mantle/search, persists the
 * run as a note (tag `recall-eval-run`), and reports drift vs the previous
 * run. Built to be fired from a scheduled heartbeat: the agent calls the tool,
 * reads `alert`, and messages the user only when quality actually moved.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { embed } from '@mantle/embeddings';
import {
  goldRank,
  parseEvalCases,
  scoreRanks,
  searchChunks,
  searchNodes,
  type RecallScores,
} from '@mantle/search';
import { createNote } from '@mantle/content';
import {
  MAX_PASSAGES_PER_REQUEST,
  applyPassageScores,
  decisionUseEnabled,
  passageScoringPool,
  scorePassages,
} from '@mantle/decisions';
import type { BuiltinToolDef } from './types';
import { errorMessage } from '@mantle/std';

const CASES_TAG = 'recall-eval-cases';
const RUN_TAG = 'recall-eval-run';
const RANK_K = 10;
/** Drift that warrants an alert: MRR down ≥0.05 or R@5 down ≥0.1 vs last run. */
const MRR_ALERT_DROP = 0.05;
const R5_ALERT_DROP = 0.1;

/** Passages fetched per case: collapsed to their nodes, the first RANK_K count. */
const PASSAGE_K = RANK_K * 3;
/** Jev's list price per request of up to 25 passages (docs/recall-eval.md:
 *  USD 0.00138 for 2 requests), for the run's cost line. */
const JEV_USD_PER_REQUEST = 0.0007;

type RunSummary = {
  at: string;
  casesUsed: number;
  casesSkipped: number;
  search: RecallScores;
  /** Passages through the HYBRID search agents use (vector + keyword arm). */
  chunks: RecallScores;
  /** What `chunks` measured. Runs before 2026-10-03 have no field: their
   *  `chunks` was vector-only, so no chunks drift is read against them. */
  chunksPath?: 'hybrid';
  /** Secondary line: the vector arm alone (the old `chunks` number). */
  chunksVector?: RecallScores;
  /** The Jev-scored passage path, when passage_scoring has a `pool` set:
   *  the hybrid pool scored and ordered as `live` would order it (whatever
   *  the use's mode). */
  chunksScored?: RecallScores & {
    mode: 'shadow' | 'live';
    pool: number;
    requests: number;
    failed: number;
    usd: number;
  };
  /** Case ids that no retriever ranked at all (null in BOTH arms). */
  unmatchedCases: string[];
};

/** Why `alert` is true. `gold_set_unmatched` = every case missed in both
 *  retrievers, which is a stale gold set (ids deleted / re-created, titles
 *  changed), not degraded retrieval; `quality_dropped` = drift vs last run. */
type AlertReason = 'gold_set_unmatched' | 'quality_dropped' | null;

/** Newest note carrying a tag, parsed as JSON from its content. */
async function latestTaggedNoteJson(
  ownerId: string,
  tag: string,
): Promise<{ id: string; json: unknown } | null> {
  const [row] = await db
    .select({ id: nodes.id, data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'note'),
        // Literal array (tags are compile-time constants) — a JS array bind
        // param is NOT serialized to a PG array by the postgres-js driver.
        sql`${nodes.tags} @> ${sql.raw(`'{${tag}}'::text[]`)}`,
      ),
    )
    .orderBy(desc(nodes.updatedAt))
    .limit(1);
  if (!row) return null;
  const content = ((row.data ?? {}) as Record<string, unknown>).content;
  if (typeof content !== 'string') return { id: row.id, json: null };
  // Tolerate a fenced block — the note may be edited by hand in the UI.
  const body = content.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    return { id: row.id, json: JSON.parse(body) };
  } catch {
    return { id: row.id, json: null };
  }
}

/** Passage hits collapse to their parent node, first appearance keeps rank. */
function toNodeHits(
  passages: ReadonlyArray<{ nodeId: string; nodeTitle: string }>,
): Array<{ id: string; title: string }> {
  const seen = new Set<string>();
  const nodeHits: Array<{ id: string; title: string }> = [];
  for (const p of passages) {
    if (seen.has(p.nodeId)) continue;
    seen.add(p.nodeId);
    nodeHits.push({ id: p.nodeId, title: p.nodeTitle });
    if (nodeHits.length >= RANK_K) break;
  }
  return nodeHits;
}

const recall_eval: BuiltinToolDef = {
  slug: 'recall_eval',
  name: 'Run the retrieval-quality eval',
  description:
    "Run the brain's retrieval self-check: every golden case (a note tagged `recall-eval-cases`, a JSON array of {id, query, expectNodeIds?|expectTitleIncludes?}) runs through the retrievers agents use (hybrid node and passage search; with passage_scoring's pool set, also the Jev-scored path, about USD 0.0007 per 25 passages per case), is scored (recall@k, MRR), saved as one run note and compared to the previous run. `alert: true` with `reason: 'quality_dropped'` when quality fell, or `reason: 'gold_set_unmatched'` when EVERY case missed both retrievers (repair the gold set, see `unmatchedCases`). `skipped: true, alert: false` when no gold set exists: unmeasured, not degraded, say nothing. Capacity is `brain_capacity`; this measures QUALITY.",
  // The Jev-scored passage path calls the decider (when a pool is set).
  spends: true,
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) => {
    const casesNote = await latestTaggedNoteJson(ctx.ownerId, CASES_TAG);
    if (!casesNote) {
      // NOT an error: a brain with no gold set has nothing to measure yet, and
      // the gold set is necessarily hand-written per brain (a case pins node
      // ids, so no set can ship). Returning ok:false here made the weekly
      // brain-health heartbeat alert every single fire on a fresh brain —
      // nagging the owner about a self-check they never configured. `skipped`
      // says "nothing to do", which the heartbeat skill treats as silence.
      return {
        ok: true,
        output: {
          skipped: true,
          reason: 'no_golden_cases',
          alert: false,
          detail:
            `no note tagged '${CASES_TAG}' — retrieval quality is unmeasured, not degraded. ` +
            `To start measuring, create a note tagged '${CASES_TAG}' whose content is a JSON array of ` +
            `{id, query, expectNodeIds? | expectTitleIncludes?} cases (see docs/recall-eval.md).`,
        },
      };
    }
    let cases;
    try {
      cases = parseEvalCases(casesNote.json);
    } catch (err) {
      return {
        ok: false,
        error: `golden-case note is invalid: ${errorMessage(err)} — fix the '${CASES_TAG}' note's JSON and re-run recall_eval`,
      };
    }

    const searchRanks: Array<number | null> = [];
    const chunkRanks: Array<number | null> = [];
    const vectorRanks: Array<number | null> = [];
    const scoredRanks: Array<number | null> = [];
    // The scored path costs one Jev fan-out per case (manual run or the
    // weekly heartbeat; bounded by the gold set): only when the owner set a
    // pool, which is the switch for "judge the deeper pool".
    const scoringUse = await decisionUseEnabled(ctx.ownerId, 'passage_scoring');
    const scoredPool =
      scoringUse && scoringUse.pool !== undefined
        ? passageScoringPool(scoringUse, PASSAGE_K)
        : null;
    let scoredRequests = 0;
    let scoredFailed = 0;
    const scoredIds: string[] = [];
    let skipped = 0;
    for (const c of cases) {
      let queryEmbedding: number[];
      try {
        queryEmbedding = await embed(ctx.ownerId, c.query);
      } catch {
        skipped++;
        continue;
      }
      scoredIds.push(c.id);
      const found = await searchNodes({
        ownerId: ctx.ownerId,
        q: c.query,
        queryEmbedding,
        limit: RANK_K,
      });
      searchRanks.push(
        goldRank(
          c,
          found.map((n) => ({ id: n.id, title: n.title })),
        ),
      );
      // Hybrid: the query text feeds the keyword arm, as in search_chunks.
      const passages = await searchChunks({
        ownerId: ctx.ownerId,
        embedding: queryEmbedding,
        q: c.query,
        limit: Math.max(PASSAGE_K, scoredPool ?? 0),
      });
      chunkRanks.push(goldRank(c, toNodeHits(passages.slice(0, PASSAGE_K))));
      const vectorOnly = await searchChunks({
        ownerId: ctx.ownerId,
        embedding: queryEmbedding,
        limit: PASSAGE_K,
      });
      vectorRanks.push(goldRank(c, toNodeHits(vectorOnly)));
      if (scoredPool !== null) {
        const pool = passages.slice(0, scoredPool);
        const key = (p: { nodeId: string; ordinal: number }) => `${p.nodeId}:${p.ordinal}`;
        const scoring = await scorePassages(
          ctx.ownerId,
          c.query,
          pool.map((p) => ({
            id: key(p),
            title: p.nodeTitle,
            heading: p.headingPath,
            text: p.text,
          })),
        );
        scoredRequests += Math.ceil(pool.length / MAX_PASSAGES_PER_REQUEST);
        if (!scoring) scoredFailed++;
        // Ordered as live would order it; no answer = the search order.
        const ordered = scoring ? applyPassageScores(pool, key, scoring).kept : pool;
        scoredRanks.push(goldRank(c, toNodeHits(ordered)));
      }
    }
    if (searchRanks.length === 0) {
      return {
        ok: false,
        error:
          'every case failed to embed — the embedder looks down; check /settings/ai-workers and re-run recall_eval later',
      };
    }

    // A case neither retriever ranks is invisible to the eval. When that is
    // EVERY case the score is exactly 0 in both arms — which is never what a
    // degraded retriever looks like (it degrades unevenly) and always what a
    // gold set that no longer matches the corpus looks like (ids deleted or
    // re-created by a re-sync, titles renamed, or a set pasted in from another
    // brain). Drift can't see it: 0 vs 0 is "no change", so this state stayed
    // silent for weeks on a real brain. It is alerted on its own.
    const unmatchedCases = scoredIds.filter(
      (_, i) => searchRanks[i] === null && chunkRanks[i] === null,
    );
    const goldSetUnmatched = unmatchedCases.length === scoredIds.length;

    const run: RunSummary = {
      at: new Date().toISOString(),
      casesUsed: searchRanks.length,
      casesSkipped: skipped,
      search: scoreRanks(searchRanks),
      chunks: scoreRanks(chunkRanks),
      chunksPath: 'hybrid',
      chunksVector: scoreRanks(vectorRanks),
      ...(scoredPool !== null && scoringUse
        ? {
            chunksScored: {
              ...scoreRanks(scoredRanks),
              mode: scoringUse.mode,
              pool: scoredPool,
              requests: scoredRequests,
              failed: scoredFailed,
              usd: Math.round(scoredRequests * JEV_USD_PER_REQUEST * 10_000) / 10_000,
            },
          }
        : {}),
      unmatchedCases,
    };

    const prevNote = await latestTaggedNoteJson(ctx.ownerId, RUN_TAG);
    const prev = (prevNote?.json ?? null) as RunSummary | null;
    const drift =
      prev?.search && prev?.chunks
        ? {
            searchMrr: Math.round((run.search.mrr - prev.search.mrr) * 1000) / 1000,
            searchR5: Math.round((run.search.recallAt5 - prev.search.recallAt5) * 1000) / 1000,
            // Only like against like: a run from before the hybrid switch
            // measured vector-only passages.
            chunksMrr:
              prev.chunksPath === 'hybrid'
                ? Math.round((run.chunks.mrr - prev.chunks.mrr) * 1000) / 1000
                : null,
            previousAt: prev.at,
          }
        : null;
    const qualityDropped = drift
      ? drift.searchMrr <= -MRR_ALERT_DROP || drift.searchR5 <= -R5_ALERT_DROP
      : false;
    const alert = goldSetUnmatched || qualityDropped;
    const reason: AlertReason = goldSetUnmatched
      ? 'gold_set_unmatched'
      : qualityDropped
        ? 'quality_dropped'
        : null;
    const detail = goldSetUnmatched
      ? `every gold case (${unmatchedCases.length}) missed in BOTH retrievers — retrieval is not measured, ` +
        `the gold set no longer matches this brain (expected node ids deleted or re-created, titles changed, ` +
        `or a set written for another brain). Repair the note tagged '${CASES_TAG}': prefer expectTitleIncludes ` +
        `for nodes whose ids churn on re-sync, then re-run recall_eval.`
      : null;

    const note = await createNote(ctx.ownerId, {
      title: `Recall eval — MRR ${run.search.mrr.toFixed(2)} / R@5 ${(run.search.recallAt5 * 100).toFixed(0)}%`,
      content: JSON.stringify(run, null, 2),
      tags: [RUN_TAG],
    });

    ctx.step?.setMeta({ mrr: run.search.mrr, r5: run.search.recallAt5, alert, reason });
    return { ok: true, output: { ...run, drift, alert, reason, detail, runNoteId: note.id } };
  },
};

export const EVAL_TOOLS: readonly BuiltinToolDef[] = [recall_eval];
