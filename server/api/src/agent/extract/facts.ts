/**
 * Extractor: Fact extraction: classify each candidate ADD / UPDATE / DELETE / NOOP and apply it.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { factValidFrom, parseClassifierDecision, resolveCostCap } from './rules';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  facts,
  llmWorkAllowed,
  nodes,
  withDeadlockRetry,
  withHeads,
  type AiWorker,
  type ExtractorParams,
} from '@mantle/db';

import { currentTrace, startTrace, step } from '@mantle/tracing';
import { prefilterFactAdd, type FactAddPrefilter } from '@mantle/decisions';
import { resolveChatRoutes } from '@mantle/runtime/agent';
import { type ExtractedFact, type ExtractorOutput } from '../extractor-parse';
import { CLASSIFIER_PROMPT_TEMPLATE } from './prompts';
import { chatComplete, resolveExtractor } from './model';
import { errorMessage, providerWaitOf, type ProviderWait } from '@mantle/std';

/** Top-K near-neighbours considered when classifying a candidate fact. */
const CLASSIFIER_NEIGHBOURS = 3;

/** Similarity threshold for "this candidate fact looks like an existing one." */
const FACT_DEDUP_THRESHOLD = 0.3; // cosine distance; lower = more similar

async function classifyAndApplyFact(
  ownerId: string,
  candidate: ExtractedFact,
  candidateEmbedding: number[],
  source: Pick<typeof nodes.$inferSelect, 'id' | 'createdAt' | 'data'>,
  primaryEntityId: string | null,
  worker: AiWorker,
): Promise<'ADD' | 'UPDATE' | 'DELETE' | 'NOOP'> {
  const sourceNodeId = source.id;
  // valid_from = when the fact became true: the event date for an episodic
  // fact, else the source document's own date (see factValidFrom).
  const validFrom = factValidFrom(candidate.occurredAt, source);

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

  const newFact = {
    ownerId,
    content: candidate.content,
    kind: candidate.kind,
    entityId: primaryEntityId,
    confidence: candidate.confidence,
    validFrom,
    sourceNodeId,
    embedding: candidateEmbedding,
  };
  // Every fact write takes the source node's head first (plan U1). The
  // classifier has already answered by then, so a retry repeats only the
  // database write, never a model call.
  const addFact = () =>
    withDeadlockRetry(() =>
      withHeads([sourceNodeId], 'update', async (tx) => {
        await tx.insert(facts).values(newFact);
      }),
    );

  // Fast path: no close neighbours → just ADD.
  if (closeNeighbours.length === 0) {
    await addFact();
    return 'ADD';
  }

  // Decider, use `fact_add_prefilter` (experimental, owner-switched): a Jev
  // ADD at the act-alone gate (0.9) skips the chat classifier in `live`. Any
  // other Jev answer is only recorded; the classifier below decides as
  // always. Jev never retires or rewrites a fact (spike: dev-brain page
  // f28a25cf). Null (off / failed / slow): today's path.
  const prefilter = await prefilterFactAdd(
    ownerId,
    candidate.content,
    closeNeighbours.map((n) => n.content),
  );
  if (prefilter?.mode === 'live' && prefilter.wouldSkip) {
    await recordPrefilterVerdict(prefilter, null);
    await addFact();
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
  if (prefilter) await recordPrefilterVerdict(prefilter, decision.decision);

  const targetIdx = decision.target_index ? decision.target_index - 1 : null;
  const target = targetIdx != null ? closeNeighbours[targetIdx] : null;

  if (decision.decision === 'NOOP') {
    // Re-confirmed by this extraction — clear the suspect flag so the
    // re-extract sweep (H4) keeps it rather than retiring it as stale.
    // A fact of this node re-asserted from its folded text (always fold)
    // holds no embed's words: its derived_mixed mark clears.
    if (target)
      await db
        .update(facts)
        .set({
          dirty: false,
          derivedMixed: sql`CASE WHEN ${facts.sourceNodeId} = ${sourceNodeId}::uuid THEN false ELSE ${facts.derivedMixed} END`,
        })
        .where(eq(facts.id, target.id));
    return 'NOOP';
  }

  const now = new Date();
  if (decision.decision === 'DELETE' && target) {
    await db.update(facts).set({ validTo: now, updatedAt: now }).where(eq(facts.id, target.id));
    return 'DELETE';
  }

  if (decision.decision === 'UPDATE' && target) {
    // Retire the old, insert the new pointing back via supersededBy.
    await withDeadlockRetry(() =>
      withHeads([sourceNodeId], 'update', async (tx) => {
        await tx.update(facts).set({ validTo: now, updatedAt: now }).where(eq(facts.id, target.id));
        const [inserted] = await tx
          .insert(facts)
          .values({ ...newFact, supersededBy: null })
          .returning({ id: facts.id });
        if (inserted) {
          // Older row's superseded_by points at the newer row.
          await tx.update(facts).set({ supersededBy: inserted.id }).where(eq(facts.id, target.id));
        }
      }),
    );
    return 'UPDATE';
  }

  // Default: ADD (even if classifier said UPDATE/DELETE but no valid target).
  await addFact();
  return 'ADD';
}

/**
 * The shadow-week evidence for `fact_add_prefilter`: Jev's pick next to the
 * chat classifier's, on one step. `chat` is null when a live skip meant the
 * classifier never ran. Read: of the steps with `would_skip`, how many have
 * `chat: 'ADD'` (the spike: 22 of 22).
 */
async function recordPrefilterVerdict(pre: FactAddPrefilter, chat: string | null): Promise<void> {
  await step({ name: 'fact_add_prefilter_verdict', kind: 'compute' }, async (h) => {
    h.setMeta({
      use: 'fact_add_prefilter',
      mode: pre.mode,
      jev: `${pre.pick}@${Math.round(pre.confidence * 100) / 100}`,
      gate: pre.gate,
      would_skip: pre.wouldSkip,
      chat,
      agree: chat === null ? null : chat.toLowerCase() === pre.pick,
      skipped: chat === null,
    });
  });
}

// ─── Per-stage seams ────────────────────────────────────────────────────────
// extractNode below is a thin orchestrator: the skip-gating + the ordered
// stage calls + the glue. Each stage is a named function here, holding the
// exact code (and comments) moved verbatim from the former monolith. Control
// flow BETWEEN stages (skip gates, the retrieval-only / extract_facts
// conditionals) stays visible in the orchestrator; logic WITHIN a stage lives
// with the stage.

/**
 * A complete re-extract that found NO facts: retire every live fact this node
 * gave, as processFacts retires the ones a re-extract does not re-assert (H4).
 * Without it, a document edited down to no facts kept serving all its old
 * ones. Also clears a capped run's incomplete-marker: this pass is complete.
 */
export async function retireUnassertedFacts(ownerId: string, nodeId: string): Promise<number> {
  return step(
    { name: 'retire_facts', kind: 'db_write', input: { reason: 'no_facts' } },
    async (h) => {
      const rows = await db
        .update(facts)
        .set({ validTo: new Date(), dirty: false, updatedAt: new Date() })
        .where(
          and(eq(facts.ownerId, ownerId), eq(facts.sourceNodeId, nodeId), isNull(facts.validTo)),
        )
        .returning({ id: facts.id });
      await db
        .update(nodes)
        .set({ data: sql`${nodes.data} - 'extract_incomplete'` })
        .where(and(eq(nodes.id, nodeId), sql`jsonb_exists(${nodes.data}, 'extract_incomplete')`));
      h.setOutput({ retired: rows.length });
      return rows.length;
    },
  );
}

/**
 * The fact pass of a read: embed the candidate facts, then classify+apply
 * each (ADD/UPDATE/DELETE/NOOP) against near-neighbour facts. Uses the H4
 * dirty-flag protocol: mark this node's live facts suspect, clear the
 * re-asserted ones, retire the rest on a COMPLETE pass.
 *
 * Nothing is dropped (owner decision 2026-11-19: cost controls pace paid
 * calls, they never decide what is kept; the provider is the cap). Two
 * things stop the pass before its last candidate, and both DEFER the rest:
 *  - the optional per-run cost cap (`extract_cost_cap_micro_usd`, opt-in): a
 *    pace. The rest goes back in the queue (FACTS_PACE_MS later), in a job
 *    of its own with a fresh budget, until every candidate is done;
 *  - the provider's "not now" on a classify call (a rate limit, no credit,
 *    busy: @mantle/std provider-wait.ts): the rest waits with the provider's
 *    growing gap.
 * A deferred pass retires nothing yet (the candidates after the stop were
 * not looked at yet): the facts not re-asserted keep their suspect flag,
 * and the node is marked `data.extract_incomplete` with `reason:
 * 'facts_deferred'`. The job that applies the last candidate retires what
 * is still suspect and clears the marker (processDeferredFacts). Returns the ADD/UPDATE/DELETE/NOOP/retired tally
 * and `deferred`, the candidates left for later.
 */
export async function processFacts(
  node: typeof nodes.$inferSelect,
  ownerId: string,
  worker: AiWorker,
  params: ExtractorParams,
  parsed: ExtractorOutput,
  entityIdByName: Map<string, string>,
  deps: Partial<FactsDeps> = {},
): Promise<FactsTally> {
  // Each candidate with the entity it is about, resolved now: a deferred
  // job applies it as this pass would have.
  const items: DeferredFactCandidate[] = parsed.facts.map((f) => {
    let entityId: string | null = null;
    for (const e of f.entities ?? []) {
      const id = entityIdByName.get(e.name.trim().toLowerCase());
      if (id) {
        entityId = id;
        break;
      }
    }
    return {
      content: f.content,
      kind: f.kind,
      confidence: f.confidence,
      ...(f.occurredAt ? { occurredAt: f.occurredAt } : {}),
      entityId,
    };
  });
  const vectors = await embedFacts(node.id, ownerId, items);

  // Treat 0 / negative / non-numeric as "no cap". `?? null` alone is a
  // trap: a configured 0 survives (0 ?? null === 0) and, because the
  // llm_extract step has already spent money by the time we get here,
  // `spent >= 0` is always true — so every fact gets stopped at #0. A 0
  // means "unlimited", not "zero budget".
  const costCap = resolveCostCap(params.extract_cost_cap_micro_usd);

  return step(
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
      const run = await applyCandidates(ownerId, node, worker, items, vectors, costCap);
      const t = run.tally;
      // H4: retire facts this extraction didn't re-assert (still dirty) —
      // but only on a complete pass. A deferred pass leaves later
      // candidates for later, so their facts must NOT be retired yet: the
      // last deferred job retires them (processDeferredFacts).
      let retired = 0;
      if (run.stoppedAt == null) {
        retired = await retireSuspect(ownerId, node.id);
        // A complete pass clears any stale incomplete-marker from a prior
        // deferred run (guarded by `?` so it's a no-op when absent — no
        // write amplification on the normal path).
        await clearIncomplete(node.id);
        const output = { ...t, retired };
        h.setOutput(output);
        return output;
      }
      // The suspect flag stays on the facts not re-asserted yet: the job
      // that applies the last deferred candidate retires what is still
      // suspect then (H4 across the jobs; nothing but this protocol reads
      // the flag).
      const deferred = await deferRest(
        node.id,
        items.slice(run.stoppedAt),
        run.stoppedAt,
        run.wait,
        deps,
      );
      reportDeferred(h, {
        processed: run.stoppedAt,
        deferred: deferred.facts.candidates.length,
        wait: run.wait,
        model: worker.model,
        costCap,
      });
      const output = { ...t, retired, deferred: deferred.facts.candidates.length };
      h.setOutput(output);
      return { ...t, retired, deferred };
    },
  );
}

/** The tally of a fact pass, with the candidates it left for later. */
export type FactsTally = {
  ADD: number;
  UPDATE: number;
  DELETE: number;
  NOOP: number;
  retired: number;
  deferred?: DeferredFactsOut;
};

/** The pace of deferred facts: the rest of a pass stopped by the cost cap
 *  goes back in the queue this long after, so other files get their turn.
 *  A gap, not a limit: every candidate is done in the end. */
export const FACTS_PACE_MS = 2 * 60_000;

/** One candidate fact left for later, with the entity it is about. */
export type DeferredFactCandidate = {
  content: string;
  kind: ExtractedFact['kind'];
  confidence: number;
  occurredAt?: string;
  entityId: string | null;
};

/** The facts a read left for later, as their job carries them. `at` is the
 *  node's `extract_incomplete.at`: a newer read writes a newer one, and the
 *  old job then has nothing to do (its facts are the old read's). */
export type DeferredFacts = { at: string; candidates: DeferredFactCandidate[] };

/** What a fact pass sends for later: the facts, and the provider's wait
 *  when that is why it stopped (else the cost cap's pace). */
export type DeferredFactsOut = { facts: DeferredFacts; wait?: ProviderWait };

/** The queue's door for deferred facts: a stand-in in a test. */
export type FactsDeps = {
  defer(nodeId: string, out: DeferredFactsOut): Promise<void>;
};

/** The default door: the extract queue (loaded at the call: the queue
 *  imports this module). */
async function deferToQueue(nodeId: string, out: DeferredFactsOut): Promise<void> {
  const { enqueueDeferredFacts } = await import('../extract-queue.js');
  await enqueueDeferredFacts(nodeId, out);
}

async function embedFacts(
  nodeId: string,
  ownerId: string,
  items: readonly DeferredFactCandidate[],
): Promise<number[][]> {
  try {
    const { embedBatch } = await import('@mantle/embeddings');
    return await embedBatch(
      ownerId,
      items.map((f) => f.content),
    );
  } catch (err) {
    // Throw so the queue retries — a silent return here meant the facts
    // for this node were never written and (pre-completion-marker)
    // never would be.
    throw new Error(`extractor: fact embed batch failed for node ${nodeId}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

/**
 * Classify and apply the candidates in order, until the last one or a stop:
 * the cost cap (spent in this trace) or the provider's "not now". Any other
 * failure of one candidate is logged and the next goes on, as before.
 */
async function applyCandidates(
  ownerId: string,
  node: Pick<typeof nodes.$inferSelect, 'id' | 'createdAt' | 'data'>,
  worker: AiWorker,
  items: readonly DeferredFactCandidate[],
  vectors: readonly number[][],
  costCap: number | null,
  atLeastOne = false,
): Promise<{
  tally: { ADD: number; UPDATE: number; DELETE: number; NOOP: number };
  stoppedAt: number | null;
  wait?: ProviderWait;
}> {
  const tally = { ADD: 0, UPDATE: 0, DELETE: 0, NOOP: 0 };
  for (let i = 0; i < items.length; i++) {
    // The cap paces: past it the rest is deferred. A deferred job always
    // applies one candidate first (`atLeastOne`), so a budget its own
    // embed call already spent can never hold it at no progress.
    if (costCap != null && !(atLeastOne && i === 0)) {
      const spent = currentTrace()?.costMicroUsd ?? 0;
      if (spent >= costCap) return { tally, stoppedAt: i };
    }
    const item = items[i]!;
    try {
      const decision = await classifyAndApplyFact(
        ownerId,
        item,
        vectors[i]!,
        node,
        item.entityId,
        worker,
      );
      tally[decision]++;
    } catch (err) {
      const wait = providerWaitOf(err);
      if (wait) return { tally, stoppedAt: i, wait };
      console.error(
        '[extractor]   fact classify failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { tally, stoppedAt: null };
}

/** Retire this node's live facts still marked suspect (H4): not
 *  re-asserted by the whole read. Returns how many. */
async function retireSuspect(ownerId: string, nodeId: string): Promise<number> {
  const rows = await db
    .update(facts)
    .set({ validTo: new Date(), dirty: false, updatedAt: new Date() })
    .where(
      and(
        eq(facts.ownerId, ownerId),
        eq(facts.sourceNodeId, nodeId),
        isNull(facts.validTo),
        eq(facts.dirty, true),
      ),
    )
    .returning({ id: facts.id });
  return rows.length;
}

/** Drop the node's incomplete marker (a no-op when absent). */
async function clearIncomplete(nodeId: string): Promise<void> {
  await db
    .update(nodes)
    .set({ data: sql`${nodes.data} - 'extract_incomplete'` })
    .where(and(eq(nodes.id, nodeId), sql`jsonb_exists(${nodes.data}, 'extract_incomplete')`));
}

/**
 * Mark the node and send the rest for later. The marker is durable and
 * queryable: the node has facts not applied yet, and why. Its `at` is the
 * deferred job's key to the node: a newer read writes a newer one.
 */
async function deferRest(
  nodeId: string,
  rest: DeferredFactCandidate[],
  processed: number,
  wait: ProviderWait | undefined,
  deps: Partial<FactsDeps>,
): Promise<DeferredFactsOut> {
  const at = new Date().toISOString();
  const incomplete = {
    reason: 'facts_deferred',
    why: wait ? `provider_${wait.reason}` : 'cost_cap',
    deferred: rest.length,
    processed,
    at,
  };
  await db
    .update(nodes)
    .set({
      data: sql`${nodes.data} || ${JSON.stringify({ extract_incomplete: incomplete })}::jsonb`,
    })
    .where(eq(nodes.id, nodeId));
  const out: DeferredFactsOut = { facts: { at, candidates: rest }, ...(wait ? { wait } : {}) };
  await (deps.defer ?? deferToQueue)(nodeId, out);
  return out;
}

/** The step of a deferred pass, amber in /traces: the candidates left for
 *  later, and why. `fact_cost_cap` stays for the /debug roll-up; `dropped`
 *  is 0, since nothing is dropped any more. */
function reportDeferred(
  h: { setSkipped(reason: string): void; setMeta(meta: Record<string, unknown>): void },
  r: {
    processed: number;
    deferred: number;
    wait: ProviderWait | undefined;
    model: string;
    costCap: number | null;
  },
): void {
  h.setSkipped('facts_deferred');
  h.setMeta({
    facts_deferred: true,
    ...(r.wait
      ? { provider_wait: r.wait.reason }
      : { fact_cost_cap: true, costCapMicroUsd: r.costCap }),
    processed: r.processed,
    deferred: r.deferred,
    dropped: 0,
    model: r.model,
    spentMicroUsd: currentTrace()?.costMicroUsd ?? 0,
  });
  console.warn(
    `[extractor]   facts deferred after ${r.processed} (${r.wait ? `provider: ${r.wait.reason}` : 'cost cap'}): ${r.deferred} left for a later job`,
  );
}

/**
 * The job of deferred facts (extract-queue.ts): apply the candidates a read
 * left for later, in a trace of its own (so the cost cap is a fresh budget).
 * Nothing is read again and no extraction call is made. A job whose node
 * was read again since (its `extract_incomplete.at` is not this job's) or
 * is gone does nothing: the newer read has its own facts. The guards of a
 * read hold again (model work allowed, facts on). Stops and defers again on
 * the cap or the provider's "not now"; the last job retires the facts the
 * read never re-asserted (still suspect, H4) and clears the marker.
 */
export async function processDeferredFacts(
  nodeId: string,
  ownerId: string,
  job: DeferredFacts,
  deps: { llmAllowed?: (nodeId: string) => Promise<boolean> } = {},
): Promise<{ applied: number; deferred?: DeferredFactsOut }> {
  const d = { llmAllowed: deps.llmAllowed ?? llmWorkAllowed };
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  const marker = (node?.data as { extract_incomplete?: { at?: unknown } } | null)
    ?.extract_incomplete;
  if (!node || marker?.at !== job.at || job.candidates.length === 0) return { applied: 0 };
  // The guards of every read, again at the time of spend: the file may
  // have no model work now (moved to a workspace with no assistant), and
  // facts may be off. Then nothing is classified; the marker stays and
  // says the facts are not applied.
  if (!(await d.llmAllowed(nodeId))) return { applied: 0 };
  const worker = await resolveExtractor(ownerId);
  // No extractor any more: nothing can classify; the marker stays.
  if (!worker) return { applied: 0 };
  const params = (worker.params ?? {}) as ExtractorParams;
  if (params.extract_facts === false) return { applied: 0 };
  const costCap = resolveCostCap(params.extract_cost_cap_micro_usd);
  return startTrace(
    {
      kind: 'extractor_run',
      ownerId,
      subjectId: nodeId,
      subjectKind: 'node',
      data: { source: 'facts_deferred', candidates: job.candidates.length },
    },
    async () => {
      const vectors = await embedFacts(nodeId, ownerId, job.candidates);
      return step(
        { name: 'process_facts', kind: 'compute', input: { deferred: job.candidates.length } },
        async (h) => {
          const run = await applyCandidates(
            ownerId,
            node,
            worker,
            job.candidates,
            vectors,
            costCap,
            true,
          );
          const applied = run.stoppedAt ?? job.candidates.length;
          if (run.stoppedAt == null) {
            // The last candidate of the read: retire what it never
            // re-asserted (H4), then the marker goes.
            const retired = await retireSuspect(ownerId, nodeId);
            await clearIncomplete(nodeId);
            h.setOutput({ ...run.tally, applied, retired });
            return { applied };
          }
          // Only a provider's "not now" on the first candidate leaves a job
          // with no progress (it then waits the provider's gap); the cap
          // always lets one through.
          const rest = job.candidates.slice(run.stoppedAt);
          const out: DeferredFactsOut = {
            facts: { at: job.at, candidates: rest },
            ...(run.wait ? { wait: run.wait } : {}),
          };
          await db
            .update(nodes)
            .set({
              data: sql`jsonb_set(${nodes.data}, '{extract_incomplete,deferred}', ${String(rest.length)}::jsonb)`,
            })
            .where(
              and(
                eq(nodes.id, nodeId),
                sql`${nodes.data}->'extract_incomplete'->>'at' = ${job.at}`,
              ),
            );
          reportDeferred(h, {
            processed: applied,
            deferred: rest.length,
            wait: run.wait,
            model: worker.model,
            costCap,
          });
          h.setOutput({ ...run.tally, applied, deferred: rest.length });
          return { applied, deferred: out };
        },
      );
    },
  );
}

// ─── The main entrypoint ────────────────────────────────────────────────────
