/**
 * Context pruning — use `context_pruning`. Once per responder turn, ONE
 * decision request scores every item retrieval injected (facts, content hits,
 * passages) 0-3 for "does this help answer the question"; code drops the ones
 * under a threshold before the prompt is built.
 *
 * Why: the 2026-09-22 spike over 60 real turns (1 524 items, dev-brain page
 * 29a6b411) found the answer relied on only 13% of the injected context.
 * Jev ranked a needed item above a not-needed one 82% of the time; dropping
 * scores under 1.0 halved the injected text and lost ~1 needed item in 10,
 * while 1.5 lost 30% — so the default is the gentle 1.0, to be tightened on
 * full text after a shadow week. A plain threshold beat every top-k mix.
 *
 * Rules (docs/decisions.md): preference facts are EXEMPT (identity, not
 * retrieval); each block keeps a floor so a bad call cannot empty the prompt;
 * freshness is not judged here (`valid_to`, `superseded_by` stay in charge);
 * history and the corpus map are never touched.
 */
import type { DecisionAnswer, DecisionQuestion } from '@mantle/voice';
import { decide, type DecideOutcome } from './decide';

export type ContextBlock = 'fact' | 'hit' | 'chunk';

export type ContextItem = {
  /** Stable id the caller maps scores back with. */
  id: string;
  block: ContextBlock;
  /** What the model sees: title/entity + the text. */
  text: string;
};

export type ContextScore = { score: number; confidence: number };

export type ContextScoring = {
  scores: Map<string, ContextScore>;
  mode: 'shadow' | 'live';
  threshold: number;
  cached: boolean;
  ms: number;
};

/** Default cut. The spike's needed items clustered at 1.5-2.0 and the
 *  not-needed at 0-1.0 on 240-char snippets; 1.0 keeps the loss near 10%. */
export const CONTEXT_THRESHOLD_DEFAULT = 1.0;

/** One request holds at most this many items (a turn has ~26). */
export const MAX_CONTEXT_ITEMS = 40;

/** Per-item text cap. Facts are short; a passage is ~2.7k, and its head
 *  carries the topic. Keeps a 40-item request under the 32k window. */
export const MAX_CONTEXT_ITEM_CHARS = 1_200;

/** Fewest scored items a block keeps, whatever the scores say. */
export const CONTEXT_FLOORS: Record<ContextBlock, number> = { fact: 2, hit: 1, chunk: 2 };

const LEVELS = (k: string): string[] => [
  `\`items.${k}\` is about a different topic. It does not help to answer \`question\`.`,
  `\`items.${k}\` is about the same topic as \`question\` but adds nothing the answer needs.`,
  `\`items.${k}\` gives useful background or part of what the answer needs.`,
  `\`items.${k}\` is needed to answer \`question\` well.`,
];

/** Score `items` against `question`. Null = decider off or the call failed;
 *  the caller keeps every item. */
export async function scoreContextItems(
  ownerId: string,
  question: string,
  items: readonly ContextItem[],
): Promise<ContextScoring | null> {
  const batch = items.slice(0, MAX_CONTEXT_ITEMS);
  if (batch.length === 0 || !question.trim()) return null;

  const state: Record<string, unknown> = { question, items: {} as Record<string, string> };
  const questions: Record<string, DecisionQuestion> = {};
  const keyById = new Map<string, string>();
  batch.forEach((it, i) => {
    const k = `${it.block[0]}${i + 1}`;
    keyById.set(it.id, k);
    (state.items as Record<string, string>)[k] =
      it.text.length > MAX_CONTEXT_ITEM_CHARS ? it.text.slice(0, MAX_CONTEXT_ITEM_CHARS) : it.text;
    questions[k] = {
      type: 'score',
      instructions: `How much does \`items.${k}\` help to answer \`question\`? Judge only \`items.${k}\`.`,
      criteria: LEVELS(k),
    };
  });

  let threshold = CONTEXT_THRESHOLD_DEFAULT;
  const outcome: DecideOutcome | null = await decide({
    ownerId,
    use: 'context_pruning',
    state,
    questions,
    summarize: (answers) => ({ items: batch.length, would_drop: countBelow(answers, threshold) }),
  });
  if (!outcome) return null;
  threshold = outcome.use.threshold ?? CONTEXT_THRESHOLD_DEFAULT;

  const scores = new Map<string, ContextScore>();
  for (const it of batch) {
    const a = outcome.answers[keyById.get(it.id)!];
    if (a && a.type === 'score') scores.set(it.id, { score: a.score, confidence: a.confidence });
  }
  return { scores, mode: outcome.mode, threshold, cached: outcome.cached, ms: outcome.ms };
}

function countBelow(answers: Record<string, DecisionAnswer>, threshold: number): number {
  let n = 0;
  for (const a of Object.values(answers)) if (a.type === 'score' && a.score < threshold) n++;
  return n;
}

/**
 * Pure: apply a scoring to one block. Exempt items keep their place at the
 * front (preferences are prepended by retrieval); scored items at or above
 * the threshold follow, best first (ties in retrieval order); unscored items
 * (past the request cap) keep their order at the end; the rest are dropped —
 * except that the block never falls below `floor` scored items: when the
 * threshold would cut deeper, the best of the cut survive.
 */
export function pruneContextItems<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  scoring: Pick<ContextScoring, 'scores' | 'threshold'>,
  opts: { exempt?: (item: T) => boolean; floor?: number } = {},
): { kept: T[]; dropped: T[] } {
  const floor = opts.floor ?? 0;
  const exempt: T[] = [];
  const scored: Array<{ item: T; score: number; i: number }> = [];
  const unscored: T[] = [];
  items.forEach((item, i) => {
    if (opts.exempt?.(item)) return void exempt.push(item);
    const s = scoring.scores.get(idOf(item));
    if (!s) return void unscored.push(item);
    scored.push({ item, score: s.score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const keepCount = Math.max(
    scored.filter((s) => s.score >= scoring.threshold).length,
    Math.min(floor, scored.length),
  );
  return {
    kept: [...exempt, ...scored.slice(0, keepCount).map((s) => s.item), ...unscored],
    dropped: scored.slice(keepCount).map((s) => s.item),
  };
}
