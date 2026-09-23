/**
 * Score many items against one message, in parallel groups: the shared engine
 * of `history_recall` (older exchanges) and `journal_recall` (Journal rules).
 * Each group is one `decide()` request (Jev reads ~32k tokens a call), so a
 * long list costs one round trip of wall time, not one per group. A failed
 * group leaves its items unscored (callers must treat an unscored item as
 * "no decision" and run their old path for it); all groups failing returns
 * null. The groups share one `DecideBatch`, so the breaker counts the
 * fan-out as one decision.
 */
import type { DecisionUse } from '@mantle/db';
import type { DecisionQuestion } from '@mantle/voice';
import { DecideBatch, decide, type DecideOutcome } from './decide';

/** One item to score: a stable id plus the text Jev reads. */
export type ScoredItem = { id: string; text: string };

export type GroupScoring = {
  scores: Map<string, number>;
  mode: 'shadow' | 'live';
  threshold: number;
  /** Groups (one request each, cache hits included). */
  calls: number;
  /** Groups that came back with no answer (their items stay unscored). */
  failed: number;
  /** Of `failed`: groups the open breaker kept from going out. */
  skipped: number;
  cached: boolean;
  /** Wall time of the whole fan-out: the wait the turn saw, timeouts included. */
  ms: number;
};

/** The most recent exchange, given as context for a terse message. */
const MAX_PREVIOUS_CHARS = 2_000;
/** The message rides in every group's state: a pasted document or a run's
 *  compiled state would be copied into each request (the delegation hint
 *  caps its message the same way). */
export const MAX_MESSAGE_CHARS = 3_000;

export async function scoreInGroups(opts: {
  ownerId: string;
  use: DecisionUse;
  message: string;
  previousExchange: string | null;
  items: readonly ScoredItem[];
  groupSize: number;
  /** The state key the items sit under (`exchanges`, `rules`). */
  itemsKey: string;
  /** Question key prefix (`x1`, `r1`, …). */
  keyPrefix: string;
  capChars: number;
  instructions: (k: string) => string;
  levels: (k: string) => string[];
  defaultThreshold: number;
}): Promise<GroupScoring | null> {
  const { items } = opts;
  if (items.length === 0 || !opts.message.trim()) return null;
  const groups: ScoredItem[][] = [];
  for (let i = 0; i < items.length; i += opts.groupSize) {
    groups.push(items.slice(i, i + opts.groupSize));
  }

  const batch = new DecideBatch();
  const message = opts.message.slice(0, MAX_MESSAGE_CHARS);
  const t0 = Date.now();
  const results = await Promise.all(
    groups.map(async (group) => {
      const keyById = new Map<string, string>();
      const texts: Record<string, string> = {};
      const questions: Record<string, DecisionQuestion> = {};
      group.forEach((item, i) => {
        const k = `${opts.keyPrefix}${i + 1}`;
        keyById.set(item.id, k);
        texts[k] = item.text.length > opts.capChars ? item.text.slice(0, opts.capChars) : item.text;
        questions[k] = {
          type: 'score',
          instructions: opts.instructions(k),
          criteria: opts.levels(k),
        };
      });
      const outcome: DecideOutcome | null = await decide({
        ownerId: opts.ownerId,
        use: opts.use,
        batch,
        state: {
          message,
          previous_exchange: (opts.previousExchange ?? '').slice(0, MAX_PREVIOUS_CHARS),
          [opts.itemsKey]: texts,
        },
        questions,
        summarize: (answers, use) => ({
          [opts.itemsKey]: group.length,
          at_or_above: Object.values(answers).filter(
            (a) => a.type === 'score' && a.score >= (use.threshold ?? opts.defaultThreshold),
          ).length,
        }),
      });
      return { group, keyById, outcome };
    }),
  );
  batch.settle();
  const ms = Date.now() - t0;

  const answered = results.filter((r) => r.outcome);
  if (answered.length === 0) return null;
  const first = answered[0]!.outcome!;
  const scores = new Map<string, number>();
  for (const { group, keyById, outcome } of answered) {
    for (const item of group) {
      const a = outcome!.answers[keyById.get(item.id)!];
      if (a && a.type === 'score') scores.set(item.id, a.score);
    }
  }
  return {
    scores,
    mode: first.mode,
    threshold: first.use.threshold ?? opts.defaultThreshold,
    calls: results.length,
    failed: results.length - answered.length,
    skipped: batch.skipped,
    cached: answered.every((r) => r.outcome!.cached),
    ms,
  };
}
