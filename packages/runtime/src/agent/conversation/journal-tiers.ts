/**
 * Journal tiers 2 + 3 for one turn (memory_config.journal_tiers; spike 10,
 * dev-brain page 60a2f51e): pick the entries that match this message, work
 * out what they make redundant, and build the snapshot. The caller applies
 * the drops in `live`; in `shadow` nothing it returns reaches the prompt.
 *
 * Entries shown in tier 1 are left out (the always-on block already carries
 * them); tier 1 overflow competes here. With the decider's `journal_recall`
 * use, the rules Jev scored are picked by score (live) or traced beside the
 * similarity pick (shadow), from the SAME candidate load.
 */
import {
  JOURNAL_RELEVANCE_MIN_DEFAULT,
  JOURNAL_RELEVANT_CHARS_DEFAULT,
  isSmallTalk,
  loadJournalCandidates,
  pickJournalEntries,
  type JournalAgentScores,
  type JournalPick,
  type JournalRelevance,
  type JournalRuleRow,
  type Tier1Plan,
} from '@mantle/content';
import type { JournalRecallScoring } from '@mantle/decisions';
import type { ContextSnapshot } from '@mantle/client-types';

/** memory_config values, clamped: a typo must not blank the tiers or flood a turn. */
export function journalTierConfig(cfg: {
  journal_relevance_min?: number;
  journal_relevant_chars?: number;
}): { cutoff: number; budgetChars: number } {
  const cutoff = cfg.journal_relevance_min;
  const chars = cfg.journal_relevant_chars;
  return {
    cutoff:
      typeof cutoff === 'number' && Number.isFinite(cutoff)
        ? Math.min(1, Math.max(0, cutoff))
        : JOURNAL_RELEVANCE_MIN_DEFAULT,
    budgetChars:
      typeof chars === 'number' && Number.isFinite(chars)
        ? Math.min(20_000, Math.max(200, Math.round(chars)))
        : JOURNAL_RELEVANT_CHARS_DEFAULT,
  };
}

/** Normalised key of a passage, to match a pick against a retrieved chunk. */
export const passageKey = (nodeId: string, text: string): string =>
  `${nodeId}|${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`;

export type JournalTurn = {
  relevance: JournalRelevance;
  /** journal_recall's pick (the rules Jev scored at the threshold). */
  jevPicks: JournalPick[];
  /** Entries whose complete body is in the prompt (tier 1 or a whole pick):
   *  their facts, chunk hits and content hits are redundant. */
  wholeIds: Set<string>;
  /** Passages sent: the one chunk each replaces. */
  passageKeys: Set<string>;
};

export async function journalTiersForTurn(o: {
  ownerId: string;
  agentSlug: string;
  inboundText: string;
  queryVec: number[];
  userLane: boolean;
  agentLane: boolean;
  cutoff: number;
  budgetChars: number;
  tier1: Tier1Plan | null;
  recall: { rules: JournalRuleRow[]; scoring: JournalRecallScoring } | null;
}): Promise<JournalTurn> {
  const alwaysOn = new Set(o.tier1?.shown.map((e) => e.nodeId) ?? []);
  const tier1Whole = o.tier1?.shown.filter((e) => e.whole).map((e) => e.nodeId) ?? [];
  if (isSmallTalk(o.inboundText)) {
    return {
      relevance: {
        picks: [],
        gap: null,
        nearMisses: [],
        cutoff: o.cutoff,
        chars: 0,
        skipped: 'small_talk',
      },
      jevPicks: [],
      wholeIds: new Set(tier1Whole),
      passageKeys: new Set(),
    };
  }
  const { candidates, passages } = await loadJournalCandidates({
    ownerId: o.ownerId,
    queryVec: o.queryVec,
    agentSlug: o.agentSlug,
    userLane: o.userLane,
    agentLane: o.agentLane,
    cutoff: o.cutoff,
    alwaysOn,
    ...(o.recall ? { rules: o.recall.rules } : {}),
  });
  const base = { cutoff: o.cutoff, budgetChars: o.budgetChars, passages, alwaysOn };
  const scores: JournalAgentScores | undefined = o.recall
    ? { scores: o.recall.scoring.scores, threshold: o.recall.scoring.threshold }
    : undefined;
  const live = o.recall?.scoring.mode === 'live';
  const picked = pickJournalEntries(candidates, live ? { ...base, agentScores: scores } : base);
  const relevance: JournalRelevance = { ...picked, cutoff: o.cutoff, skipped: null };
  const jevPicks = scores
    ? (live
        ? picked.picks
        : pickJournalEntries(candidates, { ...base, agentScores: scores }).picks
      ).filter((p) => p.score !== undefined)
    : [];
  return {
    relevance,
    jevPicks,
    wholeIds: new Set([...tier1Whole, ...picked.picks.filter((p) => p.whole).map((p) => p.nodeId)]),
    passageKeys: new Set(
      picked.picks.filter((p) => p.passage).map((p) => passageKey(p.nodeId, p.text)),
    ),
  };
}

/** Pure: the `snapshot.journal` record of one turn. */
export function journalSnapshot(o: {
  mode: 'shadow' | 'live';
  turn: JournalTurn;
  tier1: Tier1Plan | null;
  recall: { rules: JournalRuleRow[]; scoring: JournalRecallScoring } | null;
  dedupe: { facts: number; chunkHits: number; contentHits: number };
}): NonNullable<ContextSnapshot['journal']> {
  const rel = o.turn.relevance;
  return {
    mode: o.mode,
    cutoff: rel.cutoff,
    skipped: rel.skipped,
    picked: rel.picks.map((p) => ({
      nodeId: p.nodeId,
      kind: p.kind,
      similarity: p.similarity,
      chars: p.text.length,
      passage: p.passage,
      whole: p.whole,
      ...(p.score !== undefined ? { score: p.score } : {}),
    })),
    gap: rel.gap ? { nodeId: rel.gap.nodeId, similarity: rel.gap.similarity } : null,
    nearMisses: rel.nearMisses,
    chars: rel.chars,
    dedupe: o.dedupe,
    ...(o.tier1
      ? {
          tier1: {
            shown: o.tier1.shown.length,
            overflow: o.tier1.overflow.length,
            chars: o.tier1.chars,
          },
        }
      : {}),
    ...(o.recall
      ? {
          recall: {
            mode: o.recall.scoring.mode,
            threshold: o.recall.scoring.threshold,
            rules: o.recall.rules.length,
            scored: o.recall.scoring.scores.size,
            picked: o.turn.jevPicks.map((p) => ({
              nodeId: p.nodeId,
              score: p.score!,
              chars: p.text.length,
            })),
            calls: o.recall.scoring.calls,
            failed: o.recall.scoring.failed,
            skipped: o.recall.scoring.skipped,
            ms: o.recall.scoring.ms,
            cached: o.recall.scoring.cached,
          },
        }
      : {}),
  };
}
