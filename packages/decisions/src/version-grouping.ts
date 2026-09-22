/**
 * Version grouping (use `version_grouping`): stop two versions of the same
 * passage from both reaching the prompt, the older one read as current.
 *
 * Two parts, from the 2026-09-22 spike on the dev brain (30 real superseded
 * pairs, 26 search pools, 47 stale passages; write-up: dev-brain page
 * b564522b-6aec-4e84-931d-437e17725032):
 *
 *   A. CODE, no model. A hit whose node is superseded, and whose living
 *      successor is also in the pool, is dropped. The supersede pass has
 *      already resolved each stale hit to the living end of its chain, so
 *      this is a set lookup. Spike: 0 of 47 stale passages above their
 *      successor, 0 other passages dropped.
 *   B. JEV, only on the pairs code cannot resolve: two passages from
 *      DIFFERENT nodes, neither linked to the other by `superseded_by`,
 *      embedding similarity at or above 0.75. One noul per pair, "are these
 *      two versions of the same passage". A yes at or above the threshold
 *      (0.9) drops the LOWER-RANKED passage of the pair. Spike, this wording:
 *      precision 1.00 at 0.8 and 0.9 on 33 labelled negatives; every pool
 *      grouping at 0.9 was a genuine unlinked copy.
 *
 * Rules the spike set, and this file keeps:
 *   - Jev never picks the newer one. It cannot see freshness in text (spike 2:
 *     68%). Code keeps the higher-ranked hit; search ranking already carries
 *     salience and recency.
 *   - A drop needs a DIRECT yes between the two passages. Groups are never
 *     chained (A~B and B~C once collapsed five sections of one living page).
 *   - Two sections of the same node are never compared.
 */
import type { DecisionAnswer, DecisionQuestion } from '@mantle/voice';
import { decide, type DecideOutcome } from './decide';

/** Drop a pair's lower-ranked passage at or above this "same passage"
 *  probability, unless the use's `threshold` says otherwise. */
export const VERSION_THRESHOLD_DEFAULT = 0.9;

/** Only pairs at or above this cosine similarity are asked about. */
export const VERSION_SIMILARITY_FLOOR = 0.75;

/** One request holds at most this many pair questions (the spike ran up to
 *  60 in ~12.8k tokens at ~400 ms). */
export const MAX_VERSION_PAIRS = 60;

/** Per-passage text cap sent to the model (same as passage scoring). */
export const MAX_VERSION_PASSAGE_CHARS = 2_400;

/** The spike's best wording (W2). The contrastive `false` criterion is what
 *  stopped topic overlap from counting: the plain "same fact about the same
 *  subject" wording grouped 14 of 33 negatives at 0.5. */
export function versionQuestion(a: string, b: string): DecisionQuestion {
  return {
    type: 'noul',
    instructions: `Are \`${a}\` and \`${b}\` two versions of the same passage?`,
    criteria: {
      true: 'The same section of the same document or note, copied, reworded, edited or updated at a different time. The facts may have changed between the versions.',
      false:
        'Different sections of one document, or different documents that only share a topic, a project or some names. A task, summary or note that refers to another document is not a version of it.',
    },
  };
}

// ─── Part A: code ───────────────────────────────────────────────────────────

/**
 * Pure: drop hits whose living successor is also in the list. `supersededBy`
 * is the living end of the chain (the supersede pass sets it). The successor
 * stays wherever it ranked; only the stale copy goes.
 */
export function dropSupersededInPool<
  T extends { nodeId: string; supersededBy?: { id: string } | undefined },
>(hits: readonly T[]): { kept: T[]; dropped: T[] } {
  const present = new Set(hits.map((h) => h.nodeId));
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const h of hits) {
    if (h.supersededBy && h.supersededBy.id !== h.nodeId && present.has(h.supersededBy.id)) {
      dropped.push(h);
    } else {
      kept.push(h);
    }
  }
  return { kept, dropped };
}

// ─── Part B: Jev on unlinked pairs ──────────────────────────────────────────

export type VersionPassage = {
  /** Stable id the caller maps answers back with. */
  id: string;
  nodeId: string;
  title: string;
  heading?: string | null;
  text: string;
  /** Living successor, when the node is superseded (see Part A). */
  supersededBy?: { id: string } | undefined;
};

/** Cosine similarity between two passages, by id. */
export type PassagePairSimilarity = { a: string; b: string; similarity: number };

/**
 * Pure: the pairs worth asking about. Different nodes, not linked to each
 * other by supersession (code already knows those), similar enough to be
 * copies. Most similar first, capped.
 */
export function candidateVersionPairs(
  passages: readonly VersionPassage[],
  similarities: readonly PassagePairSimilarity[],
  floor: number = VERSION_SIMILARITY_FLOOR,
  cap: number = MAX_VERSION_PAIRS,
): PassagePairSimilarity[] {
  const byId = new Map(passages.map((p) => [p.id, p]));
  const linked = (x: VersionPassage, y: VersionPassage) =>
    x.supersededBy?.id === y.nodeId || y.supersededBy?.id === x.nodeId;
  return similarities
    .filter((s) => {
      const a = byId.get(s.a);
      const b = byId.get(s.b);
      return (
        !!a &&
        !!b &&
        a.id !== b.id &&
        a.nodeId !== b.nodeId &&
        !linked(a, b) &&
        s.similarity >= floor
      );
    })
    .sort((x, y) => y.similarity - x.similarity)
    .slice(0, cap);
}

export type VersionPairAnswer = { a: string; b: string; probability: number };

export type VersionGrouping = {
  pairs: VersionPairAnswer[];
  mode: 'shadow' | 'live';
  threshold: number;
  cached: boolean;
  ms: number;
};

/** Ask the decider which candidate pairs are versions of one passage. Null
 *  when the decider is off, there is nothing to ask, or the call failed: the
 *  caller keeps its list. */
export async function groupVersions(
  ownerId: string,
  passages: readonly VersionPassage[],
  pairs: readonly PassagePairSimilarity[],
): Promise<VersionGrouping | null> {
  if (pairs.length === 0) return null;
  const used = new Set(pairs.flatMap((p) => [p.a, p.b]));
  const keyById = new Map<string, string>();
  const state: { passages: Record<string, unknown> } = { passages: {} };
  let n = 0;
  for (const p of passages) {
    if (!used.has(p.id)) continue;
    const k = `p${++n}`;
    keyById.set(p.id, k);
    state.passages[k] = {
      document_title: p.title,
      ...(p.heading ? { section: p.heading } : {}),
      text:
        p.text.length > MAX_VERSION_PASSAGE_CHARS
          ? p.text.slice(0, MAX_VERSION_PASSAGE_CHARS)
          : p.text,
    };
  }
  const questions: Record<string, DecisionQuestion> = {};
  pairs.forEach((p, i) => {
    questions[`q${i + 1}`] = versionQuestion(
      `passages.${keyById.get(p.a)}`,
      `passages.${keyById.get(p.b)}`,
    );
  });

  let threshold = VERSION_THRESHOLD_DEFAULT;
  const outcome: DecideOutcome | null = await decide({
    ownerId,
    use: 'version_grouping',
    state,
    questions,
    summarize: (answers) => ({
      pairs: pairs.length,
      would_group: countAtOrAbove(answers, threshold),
      threshold,
    }),
  });
  if (!outcome) return null;
  threshold = outcome.use.threshold ?? VERSION_THRESHOLD_DEFAULT;

  const out: VersionPairAnswer[] = [];
  pairs.forEach((p, i) => {
    const a = outcome.answers[`q${i + 1}`];
    if (a && a.type === 'noul') out.push({ a: p.a, b: p.b, probability: a.probability });
  });
  return { pairs: out, mode: outcome.mode, threshold, cached: outcome.cached, ms: outcome.ms };
}

function countAtOrAbove(answers: Record<string, DecisionAnswer>, threshold: number): number {
  let n = 0;
  for (const a of Object.values(answers)) if (a.type === 'noul' && a.probability >= threshold) n++;
  return n;
}

/**
 * Pure: apply the answers to a ranked list. Walk it best-first; a hit goes
 * only when a hit that is KEPT and ranks above it was judged the same passage
 * (a direct yes at or above the threshold). No chaining: a dropped hit never
 * causes another drop. In `shadow` the caller reads `dropped.length` only.
 */
export function applyVersionGroups<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  grouping: Pick<VersionGrouping, 'pairs' | 'threshold'>,
): { kept: T[]; dropped: T[] } {
  const same = new Map<string, Set<string>>();
  for (const p of grouping.pairs) {
    if (p.probability < grouping.threshold) continue;
    if (!same.has(p.a)) same.set(p.a, new Set());
    if (!same.has(p.b)) same.set(p.b, new Set());
    same.get(p.a)!.add(p.b);
    same.get(p.b)!.add(p.a);
  }
  const keptIds = new Set<string>();
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const item of items) {
    const id = idOf(item);
    const twins = same.get(id);
    if (twins && [...twins].some((t) => keptIds.has(t))) {
      dropped.push(item);
    } else {
      keptIds.add(id);
      kept.push(item);
    }
  }
  return { kept, dropped };
}
