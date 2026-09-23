/**
 * Journal recall — use `journal_recall`. Journal tier 2 picks agent-lane
 * entries (lessons, expectations: the rules an agent learned) that matter for
 * this message. Picking them by embedding similarity fails: a rule ("the user
 * requires the assistant to log edits in the change log…") and a request
 * ("yes, do the header next") do not embed alike, and a follow-up message
 * names no topic at all. Jev judges the fit directly, with the previous
 * exchange as context.
 *
 * Spike 13 (2026-09-23, 435 NATREF topic rules, 30 real turns, Sonnet 5 key,
 * dev-brain page 9f57fa46): embedding picks found 15 to 49% of the rules a
 * turn needed; Jev found 84% at 1.5 (5k chars a turn) and 89% at 1.0 (8k),
 * against 91k chars when every rule rides every turn. ~0.9 s median, so the
 * caller starts this at the top of the context load.
 */
import { scoreInGroups, type GroupScoring, type ScoredItem } from './group-scoring';

/** Rules per request. Spike 13 ran 60 (median 0.93 s, p90 1.9 s); 40 trims
 *  the tail under the decider's 1.5 s timeout. */
export const JOURNAL_RECALL_GROUP = 40;

/** Default cut on the 0-3 score. Spike 13: 1.5 = 84% of needed rules at 5k
 *  chars a turn; 1.0 = 89% at 8k. */
export const JOURNAL_RECALL_THRESHOLD_DEFAULT = 1.5;

/** Per-rule text cap inside a request. */
export const MAX_JOURNAL_RULE_CHARS = 1_200;

export type JournalRule = ScoredItem;
export type JournalRecallScoring = GroupScoring;

const LEVELS = (k: string): string[] => [
  `\`rules.${k}\` is about a different task or topic than \`message\`.`,
  `\`rules.${k}\` is on a nearby topic, but a reply to \`message\` does not need to follow it.`,
  `\`rules.${k}\` may apply to a reply to \`message\`.`,
  `\`rules.${k}\` applies: a good reply to \`message\` must follow it.`,
];

/** Score Journal rules against `message`. Null = decider off, nothing to
 *  score, or every group failed; the caller keeps the embedding pick. */
export async function scoreJournalRules(
  ownerId: string,
  message: string,
  previousExchange: string | null,
  rules: readonly JournalRule[],
): Promise<JournalRecallScoring | null> {
  return scoreInGroups({
    ownerId,
    use: 'journal_recall',
    message,
    previousExchange,
    items: rules,
    groupSize: JOURNAL_RECALL_GROUP,
    itemsKey: 'rules',
    keyPrefix: 'r',
    capChars: MAX_JOURNAL_RULE_CHARS,
    instructions: (k) =>
      `Does a reply to \`message\` need to follow \`rules.${k}\`? Judge only \`rules.${k}\`.`,
    levels: LEVELS,
    defaultThreshold: JOURNAL_RECALL_THRESHOLD_DEFAULT,
  });
}
