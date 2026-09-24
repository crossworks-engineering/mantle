/**
 * The rule reconciler writeLearnedEntries and the cleanup task use: the
 * brain's embedder plus the decider's `rule_reconcile` use. Lives here
 * because @mantle/content depends on neither (see content/rule-reconcile.ts).
 */
import type { RuleReconcileReport, RuleReconciler } from '@mantle/content';
import { RULE_SIMILARITY_FLOOR, judgeRulePairs } from '@mantle/decisions';
import { embedBatch } from '@mantle/embeddings';

export function ruleReconcilerFor(ownerId: string): RuleReconciler {
  return {
    embed: (texts) => embedBatch(ownerId, texts),
    judge: (pairs) => judgeRulePairs(ownerId, pairs),
    similarityFloor: RULE_SIMILARITY_FLOOR,
  };
}

/** Trace meta for a reconcile: counts plus each retire's scores (not the
 *  rule texts, which the Journal already holds). */
export function reconcileMeta(r: RuleReconcileReport): Record<string, unknown> {
  return {
    mode: r.mode,
    pairs: r.pairs,
    calls: r.calls,
    failed: r.failed,
    ms: r.ms,
    [r.mode === 'live' ? 'retired' : 'would_retire']: r.retires.map((x) => ({
      older: x.olderId,
      newer: x.newerId,
      same: x.same,
      replaces: x.replaces,
    })),
    ...(r.errors ? { errors: r.errors } : {}),
  };
}
