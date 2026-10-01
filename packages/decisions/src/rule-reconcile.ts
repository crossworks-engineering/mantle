/**
 * Rule reconcile (use `rule_reconcile`): when an agent learns a rule, is an
 * older rule it already holds now redundant or wrong?
 *
 * Spike 14 (2026-09-24, dev-brain page d58e4ed3): 387 real pairs of learned
 * rules from two work brains (cosine ≥ 0.70), Sonnet 5 as the answer key with
 * four labels (same / replaces / extends / different), every retire hand
 * checked. The reframe that makes Jev safe here: for same, extends AND
 * replaces the right action is identical, keep the NEWER rule and retire the
 * older. Only `different` (both rules still apply) is harmed by a retire.
 *
 *   - Two nouls per (older, newer) pair: "same rule" and "newer changes the
 *     older". A retire needs either at or above 0.8: 0 harmful retires of 102
 *     on both brains; 0.7 let one or two through.
 *   - `same` alone reads as "same rule", not "same words": its extra yeses are
 *     `extends`, where the newer rule covers the older.
 *   - `replaces` is precise (8/8 at 0.8) and caught the live contradictions
 *     (0.84-0.94), but finds few; the two together are the gate.
 *   - A 4-way choice was no better and confused extends with different.
 *
 * Rules kept from earlier spikes: Jev never says which rule is newer (spike 2:
 * 68%); code orders by date and names the newer one in the question. Jev
 * never retires on its own in shadow; live retires are reversible supersede
 * marks, not deletes.
 */
import type { DecisionQuestion } from '@mantle/voice';
import { DecideBatch, decide, type DecideOutcome } from './decide';

/** Retire the older rule when either answer is at or above this, unless the
 *  use's `threshold` says otherwise. */
export const RULE_RECONCILE_THRESHOLD_DEFAULT = 0.8;

/** Only pairs at or above this cosine similarity (of the rule texts) are
 *  asked about. The spike sampled 0.70 up; below that pairs are mostly
 *  different rules and were not measured. */
export const RULE_SIMILARITY_FLOOR = 0.7;

/** Pairs per request: two questions each, so 40 questions (~330-400 ms in
 *  the spike). */
export const MAX_RULE_PAIRS = 20;

/** Per-rule text cap inside a request. */
export const MAX_RULE_CHARS = 1_200;

export type RulePair = { older: string; newer: string };

/** Jev's two probabilities for one pair. */
export type RulePairScore = { same: number; replaces: number };

export type RuleReconcileJudgement = {
  /** Index-aligned with the pairs asked; null where a group failed. */
  scores: Array<RulePairScore | null>;
  mode: 'shadow' | 'live';
  threshold: number;
  calls: number;
  failed: number;
  skipped: number;
  ms: number;
};

export function sameRuleQuestion(a: string, b: string): DecisionQuestion {
  return {
    type: 'noul',
    instructions: `Do \`rules.${a}\` and \`rules.${b}\` state the same rule?`,
    criteria: {
      true: 'The same instruction, maybe in other words or with small wording changes. Keeping only one of them loses nothing a reply must follow.',
      false:
        'Different instructions that only share a topic, a tool, a project, a document or some names; or one adds a requirement the other lacks; or they disagree.',
    },
  };
}

export function replacesRuleQuestion(older: string, newer: string): DecisionQuestion {
  return {
    type: 'noul',
    instructions: `\`rules.${newer}\` is newer than \`rules.${older}\`. Does \`rules.${newer}\` change or reverse \`rules.${older}\`, so that following \`rules.${older}\` as written would now be wrong?`,
    criteria: {
      true: `\`rules.${newer}\` sets a different value, choice, format, target or correction for the same thing, and both cannot be followed at once.`,
      false: `Both can be followed at once: \`rules.${newer}\` repeats \`rules.${older}\`, adds detail that fits with it, or is about a different task, document, dataset or setting.`,
    },
  };
}

/** Pure: the one rule. The older rule goes when the newer one states the
 *  same rule or changes it. */
export function retiresOlder(score: RulePairScore | null, threshold: number): boolean {
  if (!score) return false;
  return score.same >= threshold || score.replaces >= threshold;
}

/** Ask the decider about (older, newer) rule pairs. Null = use off, nothing
 *  to ask, or every group failed: the caller keeps both rules. */
export async function judgeRulePairs(
  ownerId: string,
  pairs: readonly RulePair[],
): Promise<RuleReconcileJudgement | null> {
  if (pairs.length === 0) return null;
  const cap = (s: string) => (s.length > MAX_RULE_CHARS ? s.slice(0, MAX_RULE_CHARS) : s);
  const groups: Array<{ start: number; pairs: readonly RulePair[] }> = [];
  for (let i = 0; i < pairs.length; i += MAX_RULE_PAIRS) {
    groups.push({ start: i, pairs: pairs.slice(i, i + MAX_RULE_PAIRS) });
  }

  const batch = new DecideBatch();
  const t0 = Date.now();
  const results = await Promise.all(
    groups.map(async (g) => {
      const rules: Record<string, string> = {};
      const questions: Record<string, DecisionQuestion> = {};
      g.pairs.forEach((p, k) => {
        const a = `a${k + 1}`;
        const b = `b${k + 1}`;
        rules[a] = cap(p.older);
        rules[b] = cap(p.newer);
        questions[`s${k + 1}`] = sameRuleQuestion(a, b);
        questions[`r${k + 1}`] = replacesRuleQuestion(a, b);
      });
      const outcome: DecideOutcome | null = await decide({
        ownerId,
        use: 'rule_reconcile',
        batch,
        state: { rules },
        questions,
        summarize: (answers, use) => {
          const t = use.threshold ?? RULE_RECONCILE_THRESHOLD_DEFAULT;
          return {
            pairs: g.pairs.length,
            would_retire: g.pairs.filter((_, k) => retiresOlder(scoreOf(answers, k), t)).length,
          };
        },
      });
      return { g, outcome };
    }),
  );
  batch.settle();

  const answered = results.filter((r) => r.outcome);
  if (answered.length === 0) return null;
  const first = answered[0]!.outcome!;
  const scores: Array<RulePairScore | null> = pairs.map(() => null);
  for (const { g, outcome } of answered) {
    g.pairs.forEach((_, k) => {
      scores[g.start + k] = scoreOf(outcome!.answers, k);
    });
  }
  return {
    scores,
    mode: first.mode,
    threshold: first.use.threshold ?? RULE_RECONCILE_THRESHOLD_DEFAULT,
    calls: results.length,
    failed: results.length - answered.length,
    skipped: batch.skipped,
    ms: Date.now() - t0,
  };
}

function scoreOf(answers: DecideOutcome['answers'], k: number): RulePairScore | null {
  const s = answers[`s${k + 1}`];
  const r = answers[`r${k + 1}`];
  if (!s || s.type !== 'noul' || !r || r.type !== 'noul') return null;
  return { same: s.probability, replaces: r.probability };
}
