/**
 * Score many items against one message, in parallel groups: the shared engine
 * of `history_recall` (older exchanges) and `journal_recall` (Journal rules).
 * The request planner sends the groups side by side, so a long list costs one
 * round trip of wall time, not one per group. A group is `groupSize` items,
 * or fewer when the decider model's limits need it. A failed or refused group
 * leaves its items unscored (callers must treat an unscored item as "no
 * decision" and run their old path for it); all groups failing returns null.
 * The groups share one `DecideBatch`, so the breaker counts the fan-out as
 * one decision.
 */
import type { DecisionUse } from '@mantle/db';
import type { DecisionQuestion } from '@mantle/voice';
import { decidePlanned, unitSize } from './request-planner';

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

  const message = opts.message.slice(0, MAX_MESSAGE_CHARS);
  const previous = (opts.previousExchange ?? '').slice(0, MAX_PREVIOUS_CHARS);
  const text = (item: ScoredItem) =>
    item.text.length > opts.capChars ? item.text.slice(0, opts.capChars) : item.text;
  const question = (k: string): DecisionQuestion => ({
    type: 'score',
    instructions: opts.instructions(k),
    criteria: opts.levels(k),
  });
  const keysOf = new Map<ScoredItem[], Map<string, string>>();
  const plan = await decidePlanned({
    ownerId: opts.ownerId,
    use: opts.use,
    units: items,
    groupSize: opts.groupSize,
    baseChars: JSON.stringify({ message, previous_exchange: previous }).length,
    sizeOf: (item) => unitSize(text(item), { k000: question(`${opts.keyPrefix}000`) }),
    alwaysBatch: true,
    build: (group) => {
      const keyById = new Map<string, string>();
      const texts: Record<string, string> = {};
      const questions: Record<string, DecisionQuestion> = {};
      group.forEach((item, i) => {
        const k = `${opts.keyPrefix}${i + 1}`;
        keyById.set(item.id, k);
        texts[k] = text(item);
        questions[k] = question(k);
      });
      keysOf.set(group, keyById);
      return {
        state: { message, previous_exchange: previous, [opts.itemsKey]: texts },
        questions,
        summarize: (answers, use) => ({
          [opts.itemsKey]: group.length,
          at_or_above: Object.values(answers).filter(
            (a) => a.type === 'score' && a.score >= (use.threshold ?? opts.defaultThreshold),
          ).length,
        }),
      };
    },
  });

  const answered = plan.results.filter((r) => r.outcome);
  const first = answered[0]?.outcome;
  if (!first) return null;
  const scores = new Map<string, number>();
  for (const { group, outcome } of answered) {
    const keyById = keysOf.get(group)!;
    for (const item of group) {
      const a = outcome!.answers[keyById.get(item.id)!];
      if (a && a.type === 'score') scores.set(item.id, a.score);
    }
  }
  return {
    scores,
    mode: first.mode,
    threshold: first.use.threshold ?? opts.defaultThreshold,
    calls: plan.calls,
    failed: plan.failed,
    skipped: plan.skipped,
    cached: answered.every((r) => r.outcome!.cached),
    ms: plan.ms,
  };
}
