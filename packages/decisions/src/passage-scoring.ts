/**
 * Passage scoring — the first live use of the decider (use `passage_scoring`).
 *
 * After hybrid search returns its top passages, one decision request scores
 * every passage 0-3 on "how well does this passage answer the question". Code
 * then drops the passages under a threshold and orders the rest by score. The
 * 2026-09-21 spike on the dev brain (40 questions, 20 passages each): right
 * passage at rank 1 went from 30% to 57%, and dropping scores under 2.0 kept
 * 16-29% of the passage text with every gold passage still in. One batched
 * request (all passages in the state) was as accurate as one request per
 * passage, at ~430 ms and ~$0.0006 per search. Write-up: dev-brain page
 * bb01f5dd-e0e9-4c22-b712-1ee81dacc560.
 *
 * What it must NOT do: judge freshness. A stale passage reads as a perfect
 * answer; only dates and `superseded_by` know it is old, and the existing
 * supersede annotation stays in charge of that.
 */
import type { DecisionAnswer, DecisionQuestion } from '@mantle/voice';
import { decide, type DecideOutcome } from './decide';

/** The rubric. Index 0 = useless, 3 = states the answer. Ordered, so the
 *  model's `score` is a probability-weighted position on it. */
export const PASSAGE_LEVELS: readonly string[] = [
  'The passage is about a different topic. It does not help to answer `question`.',
  'The passage is about the same topic as `question`, but it does not contain the answer.',
  'The passage contains part of the answer to `question`, or the answer is only implied.',
  'The passage states the answer to `question` directly and completely.',
];

/** Drop below this unless the use's `threshold` says otherwise. The spike's
 *  gold passages all scored ≥ 2.0; 1.5 leaves headroom for vaguer real
 *  questions. */
export const PASSAGE_THRESHOLD_DEFAULT = 1.5;

/** One request holds at most this many passages: 20 passages ≈ 14k input
 *  tokens on a 32k window. Passages past the cap are left unscored (kept). */
export const MAX_PASSAGES_PER_REQUEST = 25;

/** Per-passage text cap sent to the model. Chunks are ~2.75k chars; the head
 *  carries the topic, and a hard cap keeps the request under the window. */
export const MAX_PASSAGE_CHARS = 2_400;

export type ScorablePassage = {
  /** Stable id the caller uses to map scores back (e.g. `${nodeId}:${ordinal}`). */
  id: string;
  title: string;
  heading?: string | null;
  text: string;
};

export type PassageScore = { score: number; confidence: number };

export type PassageScoring = {
  scores: Map<string, PassageScore>;
  mode: 'shadow' | 'live';
  threshold: number;
  cached: boolean;
  ms: number;
};

/** Ask the decider to score `passages` against `question`. Returns null when
 *  the decider is off or the call failed — the caller keeps its list as is. */
export async function scorePassages(
  ownerId: string,
  question: string,
  passages: readonly ScorablePassage[],
): Promise<PassageScoring | null> {
  const batch = passages.slice(0, MAX_PASSAGES_PER_REQUEST);
  if (batch.length === 0 || !question.trim()) return null;

  const state: Record<string, unknown> = { question, passages: {} as Record<string, unknown> };
  const questions: Record<string, DecisionQuestion> = {};
  const keyById = new Map<string, string>();
  batch.forEach((p, i) => {
    const k = `p${i + 1}`;
    keyById.set(p.id, k);
    (state.passages as Record<string, unknown>)[k] = {
      document_title: p.title,
      ...(p.heading ? { section: p.heading } : {}),
      text: p.text.length > MAX_PASSAGE_CHARS ? p.text.slice(0, MAX_PASSAGE_CHARS) : p.text,
    };
    questions[k] = {
      type: 'score',
      instructions: `How well does \`passages.${k}\` answer \`question\`? Judge only \`passages.${k}\`.`,
      criteria: PASSAGE_LEVELS.map((l) => l.replace(/The passage/g, `\`passages.${k}\``)),
    };
  });

  let threshold = PASSAGE_THRESHOLD_DEFAULT;
  const outcome: DecideOutcome | null = await decide({
    ownerId,
    use: 'passage_scoring',
    state,
    questions,
    summarize: (answers) => ({
      passages: batch.length,
      would_drop: countBelow(answers, threshold),
      threshold,
    }),
  });
  if (!outcome) return null;
  threshold = outcome.use.threshold ?? PASSAGE_THRESHOLD_DEFAULT;

  const scores = new Map<string, PassageScore>();
  for (const p of batch) {
    const a = outcome.answers[keyById.get(p.id)!];
    if (a && a.type === 'score') scores.set(p.id, { score: a.score, confidence: a.confidence });
  }
  return { scores, mode: outcome.mode, threshold, cached: outcome.cached, ms: outcome.ms };
}

function countBelow(answers: Record<string, DecisionAnswer>, threshold: number): number {
  let n = 0;
  for (const a of Object.values(answers)) if (a.type === 'score' && a.score < threshold) n++;
  return n;
}

/**
 * Pure: apply a scoring to a list. Scored items at or above the threshold
 * come first, highest score first (ties keep search order); unscored items
 * (past the per-request cap) follow in their original order; items under the
 * threshold are dropped. In `shadow` mode the caller should NOT use `kept` —
 * it reads `dropped.length` for the trace and keeps its original list.
 */
export function applyPassageScores<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  scoring: Pick<PassageScoring, 'scores' | 'threshold'>,
): { kept: T[]; dropped: T[] } {
  const scored: Array<{ item: T; score: number; i: number }> = [];
  const unscored: T[] = [];
  const dropped: T[] = [];
  items.forEach((item, i) => {
    const s = scoring.scores.get(idOf(item));
    if (!s) unscored.push(item);
    else if (s.score >= scoring.threshold) scored.push({ item, score: s.score, i });
    else dropped.push(item);
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return { kept: [...scored.map((s) => s.item), ...unscored], dropped };
}
