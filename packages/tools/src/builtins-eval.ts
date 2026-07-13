/**
 * Retrieval-quality self-check — the automated half of docs/recall-eval.md.
 * A golden-case note (tag `recall-eval-cases`) pairs natural-language queries
 * with the nodes that should come back; `recall_eval` runs each query through
 * the shipped retrievers (hybrid `search_nodes` + passage `search_chunks`),
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
import type { BuiltinToolDef } from './types';

const CASES_TAG = 'recall-eval-cases';
const RUN_TAG = 'recall-eval-run';
const RANK_K = 10;
/** Drift that warrants an alert: MRR down ≥0.05 or R@5 down ≥0.1 vs last run. */
const MRR_ALERT_DROP = 0.05;
const R5_ALERT_DROP = 0.1;

type RunSummary = {
  at: string;
  casesUsed: number;
  casesSkipped: number;
  search: RecallScores;
  chunks: RecallScores;
};

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

const recall_eval: BuiltinToolDef = {
  slug: 'recall_eval',
  name: 'Run the retrieval-quality eval',
  description:
    "Run the brain's retrieval self-check: every golden case (a note tagged `recall-eval-cases` holding a JSON array of {id, query, expectNodeIds?|expectTitleIncludes?}) is searched via the shipped hybrid + passage retrievers, scored (recall@k, MRR), saved as a run note, and compared to the previous run. Returns scores, drift, and `alert: true` when quality dropped enough to tell the user. Writes one summary note per run. For a point-in-time capacity check use `brain_capacity`; this measures retrieval QUALITY.",
  inputSchema: { type: 'object', properties: {} },
  handler: async (_input, ctx) => {
    const casesNote = await latestTaggedNoteJson(ctx.ownerId, CASES_TAG);
    if (!casesNote) {
      return {
        ok: false,
        error:
          `no golden-case note found — create a note tagged '${CASES_TAG}' whose content is a JSON array of ` +
          `{id, query, expectNodeIds? | expectTitleIncludes?} cases (see docs/recall-eval.md), then re-run recall_eval`,
      };
    }
    let cases;
    try {
      cases = parseEvalCases(casesNote.json);
    } catch (err) {
      return {
        ok: false,
        error: `golden-case note is invalid: ${err instanceof Error ? err.message : String(err)} — fix the '${CASES_TAG}' note's JSON and re-run recall_eval`,
      };
    }

    const searchRanks: Array<number | null> = [];
    const chunkRanks: Array<number | null> = [];
    let skipped = 0;
    for (const c of cases) {
      let queryEmbedding: number[];
      try {
        queryEmbedding = await embed(ctx.ownerId, c.query);
      } catch {
        skipped++;
        continue;
      }
      const found = await searchNodes({ ownerId: ctx.ownerId, q: c.query, queryEmbedding, limit: RANK_K });
      searchRanks.push(goldRank(c, found.map((n) => ({ id: n.id, title: n.title }))));
      const passages = await searchChunks({ ownerId: ctx.ownerId, embedding: queryEmbedding, limit: RANK_K * 3 });
      // Passage hits collapse to their parent node, first appearance keeps rank.
      const seen = new Set<string>();
      const nodeHits: Array<{ id: string; title: string }> = [];
      for (const p of passages) {
        if (seen.has(p.nodeId)) continue;
        seen.add(p.nodeId);
        nodeHits.push({ id: p.nodeId, title: p.nodeTitle });
        if (nodeHits.length >= RANK_K) break;
      }
      chunkRanks.push(goldRank(c, nodeHits));
    }
    if (searchRanks.length === 0) {
      return { ok: false, error: 'every case failed to embed — the embedder looks down; check /settings/ai-workers and re-run recall_eval later' };
    }

    const run: RunSummary = {
      at: new Date().toISOString(),
      casesUsed: searchRanks.length,
      casesSkipped: skipped,
      search: scoreRanks(searchRanks),
      chunks: scoreRanks(chunkRanks),
    };

    const prevNote = await latestTaggedNoteJson(ctx.ownerId, RUN_TAG);
    const prev = (prevNote?.json ?? null) as RunSummary | null;
    const drift =
      prev?.search && prev?.chunks
        ? {
            searchMrr: Math.round((run.search.mrr - prev.search.mrr) * 1000) / 1000,
            searchR5: Math.round((run.search.recallAt5 - prev.search.recallAt5) * 1000) / 1000,
            chunksMrr: Math.round((run.chunks.mrr - prev.chunks.mrr) * 1000) / 1000,
            previousAt: prev.at,
          }
        : null;
    const alert = drift
      ? drift.searchMrr <= -MRR_ALERT_DROP || drift.searchR5 <= -R5_ALERT_DROP
      : false;

    const note = await createNote(ctx.ownerId, {
      title: `Recall eval — MRR ${run.search.mrr.toFixed(2)} / R@5 ${(run.search.recallAt5 * 100).toFixed(0)}%`,
      content: JSON.stringify(run, null, 2),
      tags: [RUN_TAG],
    });

    ctx.step?.setMeta({ mrr: run.search.mrr, r5: run.search.recallAt5, alert });
    return { ok: true, output: { ...run, drift, alert, runNoteId: note.id } };
  },
};

export const EVAL_TOOLS: readonly BuiltinToolDef[] = [recall_eval];
