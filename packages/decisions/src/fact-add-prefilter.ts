/**
 * Fact add pre-filter (use `fact_add_prefilter`): let a confident Jev "this is
 * a new fact" skip the chat classifier on the extractor's slow path.
 *
 * When a candidate fact has close neighbours, the extractor asks a chat model
 * ADD / UPDATE / DELETE / NOOP (server/api/src/agent/extract/facts.ts). The
 * 2026-09-21 spike (60 real NATREF cases, dev-brain page f28a25cf) found Jev
 * unsafe for that whole choice: it read multi-valued attributes as
 * single-valued ("uses line class A" against "uses line class B") and chose
 * UPDATE, once at 0.99, which retires a fact that is still true. So a
 * confidence gate does not make Jev's UPDATE or DELETE safe.
 *
 * ADD is the safe answer: it never retires anything; the worst case is a
 * near-duplicate. Jev ADD at confidence ≥ 0.9 matched the chat model on 22 of
 * 22 cases (37% of slow-path calls). So the one rule here: an ADD at or above
 * the gate skips the chat call; EVERY other answer (any UPDATE, DELETE or
 * NOOP, or a low-confidence ADD) goes to the chat classifier as today. Jev's
 * update / delete / noop picks are recorded, never acted on.
 */
import type { DecisionQuestion } from '@mantle/voice';
import { decide, type DecideOutcome } from './decide';

/** The relation choice. Contrastive ("not for …") criteria, and the
 *  multi-valued case spelled out in `add`, because that is where the spike
 *  saw Jev go wrong. */
export const FACT_RELATION_CRITERIA: Readonly<Record<FactRelation, string>> = {
  add: '`candidate` states something `existing` does not already say: a new fact, a new detail, or one more value of an attribute that can hold many values at once (a project uses many line classes, a person has many skills, a company has many clients). Not for a reworded copy of an existing fact.',
  update:
    '`candidate` replaces one fact in `existing` because an attribute that holds ONE value at a time has changed (a new status, a new date, a new owner, a corrected number). Not for an attribute that can hold many values at once, and not when the existing fact is still true.',
  delete:
    '`candidate` says that one fact in `existing` is no longer true, and gives no new value for it.',
  noop: '`candidate` says the same thing as one fact in `existing`, in other words, with no new detail. Not when `candidate` adds anything.',
};

export type FactRelation = 'add' | 'update' | 'delete' | 'noop';

/** Per-fact text cap in the state. Facts are one sentence; this only guards
 *  a runaway extraction. */
export const MAX_FACT_CHARS = 600;

export type FactAddPrefilter = {
  /** Jev's pick, recorded whatever it is. */
  pick: FactRelation;
  confidence: number;
  mode: 'shadow' | 'live';
  /** The confidence an ADD needs to skip the chat call. */
  gate: number;
  /** True only for ADD at or above the gate. In `shadow` nothing is skipped. */
  wouldSkip: boolean;
  cached: boolean;
  ms: number;
};

export function factRelationQuestion(): DecisionQuestion {
  return {
    type: 'choice',
    instructions:
      'A knowledge base holds the facts in `existing`. A new fact, `candidate`, was just extracted. How does `candidate` relate to `existing`?',
    criteria: { ...FACT_RELATION_CRITERIA },
  };
}

/** Ask the decider how `candidate` relates to its close neighbours. Null when
 *  the use is off or the call failed: the caller runs the chat classifier. */
export async function prefilterFactAdd(
  ownerId: string,
  candidate: string,
  existing: readonly string[],
): Promise<FactAddPrefilter | null> {
  if (!candidate.trim() || existing.length === 0) return null;
  const cap = (s: string) => (s.length > MAX_FACT_CHARS ? s.slice(0, MAX_FACT_CHARS) : s);
  const state = {
    candidate: cap(candidate),
    existing: Object.fromEntries(existing.map((f, i) => [`f${i + 1}`, cap(f)])),
  };
  const outcome: DecideOutcome | null = await decide({
    ownerId,
    use: 'fact_add_prefilter',
    state,
    questions: { relation: factRelationQuestion() },
  });
  if (!outcome) return null;
  const a = outcome.answers.relation;
  if (!a || a.type !== 'choice' || !(a.choice in FACT_RELATION_CRITERIA)) return null;
  const pick = a.choice as FactRelation;
  // The use's `threshold` may raise or lower the gate; default is the
  // worker's act-alone floor (0.9), the spike's zero-miss cut.
  const gate = outcome.use.threshold ?? outcome.use.actAloneAt;
  return {
    pick,
    confidence: a.confidence,
    mode: outcome.mode,
    gate,
    wouldSkip: shouldSkipClassifier(pick, a.confidence, gate),
    cached: outcome.cached,
    ms: outcome.ms,
  };
}

/** Pure: the one rule. Only a confident ADD may skip the chat classifier. */
export function shouldSkipClassifier(
  pick: FactRelation,
  confidence: number,
  gate: number,
): boolean {
  return pick === 'add' && confidence >= gate;
}
