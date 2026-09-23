/**
 * History recall — use `history_recall`. The responder's history is the last
 * `history_limit` messages. A message just past that line drops out, even when
 * the new message returns to it. Once per responder turn, this scores the
 * OLDER exchanges (up to HISTORY_RECALL_WINDOW messages back, whole exchange =
 * user message + reply) 0-3 for "does a reply to this message need it"; code
 * brings back the ones at the threshold, in time order, before the recent part.
 *
 * Why: spike 12 (2026-09-23, 50 real NATREF turns, dev-brain page c8c2256f).
 * Today's last-30 window missed a needed exchange on 4 turns, 3 of them a
 * RETURN to a topic after 8 h to 10 days, which Jev scored 2.2 to 2.85. The
 * last 20 + Jev at 1.0 missed on 3 turns with 78% of the tokens; 11 of the 18
 * needed exchanges outside the last 20 came back. A walk back to the topic
 * start and chat-model selectors both lost (12 to 18 misses).
 *
 * Groups of HISTORY_RECALL_GROUP exchanges go out as separate requests in
 * parallel (Jev reads ~32k tokens a call); the caller starts this early so the
 * ~0.5 s overlaps the rest of the context load. Nothing is ever dropped from
 * the recent part; a failed group only means its exchanges stay out, as today.
 */
import { scoreInGroups, type GroupScoring, type ScoredItem } from './group-scoring';

/** How far back the scan reaches, in messages, counted from the newest (the
 *  recent part included). Spike 12: no NATREF topic began further back. */
export const HISTORY_RECALL_WINDOW = 50;

/** Default cut on the 0-3 score. Spike 12: 1.0 kept 11 of 18 needed older
 *  exchanges; 0.5 kept 12 at twice the recalled text. */
export const HISTORY_RECALL_THRESHOLD_DEFAULT = 1.0;

/** Exchanges per request. */
export const HISTORY_RECALL_GROUP = 10;

/** Per-exchange text cap inside a request (a long reply keeps its head). */
export const MAX_HISTORY_EXCHANGE_CHARS = 5_000;

/** One older exchange: a stable id plus its text as the history renders it. */
export type HistoryExchange = ScoredItem;

export type HistoryRecallScoring = GroupScoring;

const LEVELS = (k: string): string[] => [
  `\`exchanges.${k}\` is about a different topic than \`message\`.`,
  `\`exchanges.${k}\` is on the same topic, but a reply to \`message\` does not need it.`,
  `\`exchanges.${k}\` gives useful background for a reply to \`message\`.`,
  `\`exchanges.${k}\` is needed to reply to \`message\`: \`message\` continues it, refers to it, or relies on something in it.`,
];

/** Score older exchanges against `message`. Null = decider off, nothing to
 *  score, or every group failed; the caller then keeps today's history. */
export async function scoreHistoryExchanges(
  ownerId: string,
  message: string,
  previousExchange: string | null,
  exchanges: readonly HistoryExchange[],
): Promise<HistoryRecallScoring | null> {
  return scoreInGroups({
    ownerId,
    use: 'history_recall',
    message,
    previousExchange,
    items: exchanges,
    groupSize: HISTORY_RECALL_GROUP,
    itemsKey: 'exchanges',
    keyPrefix: 'x',
    capChars: MAX_HISTORY_EXCHANGE_CHARS,
    instructions: (k) =>
      `How much does a reply to \`message\` need \`exchanges.${k}\`? Judge only \`exchanges.${k}\`.`,
    levels: LEVELS,
    defaultThreshold: HISTORY_RECALL_THRESHOLD_DEFAULT,
  });
}

/**
 * Pure: which older exchanges come back. Scored at or above the threshold,
 * in their original (time) order; unscored ones stay out.
 */
export function recallExchanges<T>(
  older: readonly T[],
  idOf: (item: T) => string,
  scoring: Pick<HistoryRecallScoring, 'scores' | 'threshold'>,
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const item of older) {
    const s = scoring.scores.get(idOf(item));
    if (s !== undefined && s >= scoring.threshold) kept.push(item);
    else dropped.push(item);
  }
  return { kept, dropped };
}
