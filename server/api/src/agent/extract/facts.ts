/**
 * Extractor: Fact extraction: classify each candidate ADD / UPDATE / DELETE / NOOP and apply it.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { parseClassifierDecision, resolveCostCap } from './rules';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, facts, nodes, type AiWorker, type ExtractorParams } from '@mantle/db';

import { currentTrace, step } from '@mantle/tracing';
import { resolveChatRoutes } from '@mantle/runtime/agent';
import { type ExtractedFact, type ExtractorOutput } from '../extractor-parse';
import { CLASSIFIER_PROMPT_TEMPLATE } from './prompts';
import { chatComplete } from './model';

/** Top-K near-neighbours considered when classifying a candidate fact. */
const CLASSIFIER_NEIGHBOURS = 3;

/** Similarity threshold for "this candidate fact looks like an existing one." */
const FACT_DEDUP_THRESHOLD = 0.3; // cosine distance; lower = more similar

async function classifyAndApplyFact(
  ownerId: string,
  candidate: ExtractedFact,
  candidateEmbedding: number[],
  sourceNodeId: string,
  primaryEntityId: string | null,
  worker: AiWorker,
): Promise<'ADD' | 'UPDATE' | 'DELETE' | 'NOOP'> {
  // valid_from = when the fact became true. For an episodic fact with a parsed
  // event date, that's the EVENT date (so recency decays by when it happened,
  // not when we ingested it); otherwise now.
  const validFrom = candidate.occurredAt
    ? new Date(`${candidate.occurredAt}T00:00:00Z`)
    : new Date();

  // Find near-neighbour facts among currently-valid rows.
  const neighbours = await db
    .select({
      id: facts.id,
      content: facts.content,
      dist: sql<number>`${facts.embedding} <=> ${JSON.stringify(candidateEmbedding)}::vector`,
    })
    .from(facts)
    .where(
      and(eq(facts.ownerId, ownerId), isNull(facts.validTo), sql`${facts.embedding} is not null`),
    )
    .orderBy(sql`${facts.embedding} <=> ${JSON.stringify(candidateEmbedding)}::vector`)
    .limit(CLASSIFIER_NEIGHBOURS);

  const closeNeighbours = neighbours.filter((n) => (n.dist ?? 1) <= FACT_DEDUP_THRESHOLD);

  // Fast path: no close neighbours → just ADD.
  if (closeNeighbours.length === 0) {
    await db.insert(facts).values({
      ownerId,
      content: candidate.content,
      kind: candidate.kind,
      entityId: primaryEntityId,
      confidence: candidate.confidence,
      validFrom,
      sourceNodeId,
      embedding: candidateEmbedding,
    });
    return 'ADD';
  }

  // Slow path: call the classifier to decide.
  const params = (worker.params ?? {}) as ExtractorParams;
  const decisionResult = await chatComplete(
    ownerId,
    resolveChatRoutes(worker),
    'You are a precise JSON output assistant. Output strictly the JSON requested, with no additional commentary.',
    CLASSIFIER_PROMPT_TEMPLATE(
      candidate.content,
      closeNeighbours.map((n) => n.content),
    ),
    params,
  );
  const decision = parseClassifierDecision(decisionResult.text);

  const targetIdx = decision.target_index ? decision.target_index - 1 : null;
  const target = targetIdx != null ? closeNeighbours[targetIdx] : null;

  if (decision.decision === 'NOOP') {
    // Re-confirmed by this extraction — clear the suspect flag so the
    // re-extract sweep (H4) keeps it rather than retiring it as stale.
    if (target) await db.update(facts).set({ dirty: false }).where(eq(facts.id, target.id));
    return 'NOOP';
  }

  const now = new Date();
  if (decision.decision === 'DELETE' && target) {
    await db.update(facts).set({ validTo: now, updatedAt: now }).where(eq(facts.id, target.id));
    return 'DELETE';
  }

  if (decision.decision === 'UPDATE' && target) {
    // Retire the old, insert the new pointing back via supersededBy.
    await db.update(facts).set({ validTo: now, updatedAt: now }).where(eq(facts.id, target.id));
    const [inserted] = await db
      .insert(facts)
      .values({
        ownerId,
        content: candidate.content,
        kind: candidate.kind,
        entityId: primaryEntityId,
        confidence: candidate.confidence,
        validFrom,
        sourceNodeId,
        embedding: candidateEmbedding,
        supersededBy: null,
      })
      .returning({ id: facts.id });
    if (inserted) {
      // Older row's superseded_by points at the newer row.
      await db.update(facts).set({ supersededBy: inserted.id }).where(eq(facts.id, target.id));
    }
    return 'UPDATE';
  }

  // Default: ADD (even if classifier said UPDATE/DELETE but no valid target).
  await db.insert(facts).values({
    ownerId,
    content: candidate.content,
    kind: candidate.kind,
    entityId: primaryEntityId,
    confidence: candidate.confidence,
    validFrom,
    sourceNodeId,
    embedding: candidateEmbedding,
  });
  return 'ADD';
}

// ─── Per-stage seams ────────────────────────────────────────────────────────
// extractNode below is a thin orchestrator: the skip-gating + the ordered
// stage calls + the glue. Each stage is a named function here, holding the
// exact code (and comments) moved verbatim from the former monolith. Control
// flow BETWEEN stages (skip gates, the retrieval-only / extract_facts
// conditionals) stays visible in the orchestrator; logic WITHIN a stage lives
// with the stage.

/**
 * fact extraction pass: embed the candidate facts, then classify+apply each
 * (ADD/UPDATE/DELETE/NOOP) against near-neighbour facts, honouring the optional
 * per-run cost cap. Uses the H4 dirty-flag protocol: mark this node's live
 * facts suspect, clear the re-asserted ones, retire the rest on a COMPLETE pass
 * (a cost-cap break leaves them untouched and records `data.extract_incomplete`
 * for recovery). Returns the ADD/UPDATE/DELETE/NOOP/retired tally.
 */
export async function processFacts(
  node: typeof nodes.$inferSelect,
  ownerId: string,
  worker: AiWorker,
  params: ExtractorParams,
  parsed: ExtractorOutput,
  entityIdByName: Map<string, string>,
): Promise<{ ADD: number; UPDATE: number; DELETE: number; NOOP: number; retired: number }> {
  const factTexts = parsed.facts.map((f) => f.content);
  let factVectors: number[][] = [];
  try {
    const { embedBatch } = await import('@mantle/embeddings');
    factVectors = await embedBatch(ownerId, factTexts);
  } catch (err) {
    // Throw so the queue retries — a silent return here meant the facts
    // for this node were never written and (pre-completion-marker)
    // never would be.
    throw new Error(
      `extractor: fact embed batch failed for node ${node.id}: ${err instanceof Error ? err.message : err}`,
      { cause: err },
    );
  }

  // Treat 0 / negative / non-numeric as "no cap". `?? null` alone is a
  // trap: a configured 0 survives (0 ?? null === 0) and, because the
  // llm_extract step has already spent money by the time we get here,
  // `spent >= 0` is always true — so every fact gets dropped at #0. A 0
  // means "unlimited", not "zero budget".
  const costCap = resolveCostCap(params.extract_cost_cap_micro_usd);

  const tally = await step(
    {
      name: 'process_facts',
      kind: 'compute',
      input: {
        candidates: parsed.facts.length,
        costCapMicroUsd: costCap,
        // Full list of fact candidates — content + their entities.
        // truncateJson safety net at 64KB; arrays-over-50 cap in
        // truncate.ts catches genuinely runaway iterations.
        preview: parsed.facts.map((f) => ({
          content: f.content,
          entities: (f.entities ?? []).map((e) => e.name),
        })),
      },
    },
    async (h) => {
      const t = { ADD: 0, UPDATE: 0, DELETE: 0, NOOP: 0 };
      // H4 (re-extract reconciliation): mark this node's live facts suspect.
      // Each re-asserted by the new extraction gets cleared (NOOP/UPDATE);
      // the rest are retired after the loop. Without this, a fact dropped
      // from an edited document stays valid_to=NULL forever. No-op for a
      // fresh node (0 prior facts).
      await db
        .update(facts)
        .set({ dirty: true })
        .where(
          and(eq(facts.ownerId, ownerId), eq(facts.sourceNodeId, node.id), isNull(facts.validTo)),
        );
      let capExceededAt: number | null = null;
      for (let i = 0; i < parsed.facts.length; i++) {
        if (costCap != null) {
          const spent = currentTrace()?.costMicroUsd ?? 0;
          if (spent >= costCap) {
            capExceededAt = i;
            // Surface every dropped fact so a tight cap isn't an
            // invisible data-loss event. The previous code summed
            // them up only after the loop and left the individual
            // contents undiscoverable.
            const dropped = parsed.facts.slice(i).map((f) => f.content);
            console.warn(
              `[extractor] cost cap ${costCap}µ$ hit at fact ${i}/${parsed.facts.length}; ` +
                `dropping ${dropped.length} fact(s) from node ${node.id}:`,
              dropped,
            );
            break;
          }
        }
        const candidate = parsed.facts[i]!;
        const vec = factVectors[i]!;
        let primaryEntityId: string | null = null;
        for (const e of candidate.entities ?? []) {
          const id = entityIdByName.get(e.name.trim().toLowerCase());
          if (id) {
            primaryEntityId = id;
            break;
          }
        }
        try {
          const decision = await classifyAndApplyFact(
            ownerId,
            candidate,
            vec,
            node.id,
            primaryEntityId,
            worker,
          );
          t[decision]++;
        } catch (err) {
          console.error(
            '[extractor]   fact classify failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }
      // H4: retire facts this extraction didn't re-assert (still dirty) —
      // but only on a complete pass. A cost-cap break leaves later
      // candidates unprocessed, so their facts must NOT be retired; just
      // clear the suspect flag in that case.
      let retired = 0;
      if (capExceededAt == null) {
        const retiredRows = await db
          .update(facts)
          .set({ validTo: new Date(), dirty: false, updatedAt: new Date() })
          .where(
            and(
              eq(facts.ownerId, ownerId),
              eq(facts.sourceNodeId, node.id),
              isNull(facts.validTo),
              eq(facts.dirty, true),
            ),
          )
          .returning({ id: facts.id });
        retired = retiredRows.length;
        // A complete pass clears any stale incomplete-marker from a prior
        // capped run (guarded by `?` so it's a no-op when absent — no write
        // amplification on the normal path).
        await db
          .update(nodes)
          .set({ data: sql`${nodes.data} - 'extract_incomplete'` })
          .where(
            and(eq(nodes.id, node.id), sql`jsonb_exists(${nodes.data}, 'extract_incomplete')`),
          );
      } else {
        await db
          .update(facts)
          .set({ dirty: false })
          .where(
            and(
              eq(facts.ownerId, ownerId),
              eq(facts.sourceNodeId, node.id),
              isNull(facts.validTo),
              eq(facts.dirty, true),
            ),
          );
        // Durable, queryable proof that this node has facts the extractor
        // never persisted (the cost cap cut the run short). Logs + the amber
        // trace step get pruned; this marker survives so the loss is
        // recoverable: raise extract_cost_cap_micro_usd for the worker, then
        // re-fire pg_notify('node_ingested') on these nodes. Cleared on the
        // next complete pass (above).
        const incomplete = {
          reason: 'fact_cost_cap',
          dropped: parsed.facts.length - capExceededAt,
          processed: capExceededAt,
          at: new Date().toISOString(),
        };
        await db
          .update(nodes)
          .set({
            data: sql`${nodes.data} || ${JSON.stringify({ extract_incomplete: incomplete })}::jsonb`,
          })
          .where(eq(nodes.id, node.id));
      }
      const output: Record<string, unknown> = { ...t, retired };
      if (capExceededAt != null) {
        const dropped = parsed.facts.length - capExceededAt;
        output.costCapHitAt = capExceededAt;
        output.processed = capExceededAt;
        output.skipped = dropped;
        // Flip the step to `skipped` so a cost-cap-exhausted fact run is
        // amber in /traces and the node-biography instead of a green
        // "success" that hides paid-for facts being dropped — the exact
        // silent-miss class observability.md §4 used to warn was invisible.
        // `fact_cost_cap`/`dropped`/`model` mirror the duplicate-guard
        // meta so /debug's widget rolls it up without a join. See §9n.
        h.setSkipped('fact_cost_cap');
        h.setMeta({
          fact_cost_cap: true,
          dropped,
          model: worker.model,
          costCapMicroUsd: costCap,
          spentMicroUsd: currentTrace()?.costMicroUsd ?? 0,
        });
        console.warn(
          `[extractor]   cost cap ${costCap}µ$ hit after ${capExceededAt}/${parsed.facts.length} facts — skipping rest`,
        );
      }
      h.setOutput(output);
      return { ...t, retired };
    },
  );
  return tally;
}

// ─── The main entrypoint ────────────────────────────────────────────────────
