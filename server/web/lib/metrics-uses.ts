/**
 * Pure: fold per-(model, use) rows into the per-model spend rows, so /debug's
 * spend-by-model view can split a decision model (Jev) by the use that called
 * it (passage_scoring, context_pruning, delegation_hint, ...). Dependency-free
 * so it is unit-tested directly.
 */

import type { ModelSpend, UseSpend } from '@mantle/client-types';

export type UseSpendRow = {
  model: string;
  use: string;
  costMicroUsd: number;
  tokensIn: number;
  calls: number;
  failed: number;
  /** Sum of meta.decision_ms over answered calls, and how many carried it. */
  msSum: number;
  msCount: number;
};

export function attachUseSpend(models: ModelSpend[], rows: UseSpendRow[]): ModelSpend[] {
  const byModel = new Map<string, UseSpend[]>();
  for (const r of rows) {
    const list = byModel.get(r.model) ?? [];
    list.push({
      use: r.use,
      costMicroUsd: r.costMicroUsd,
      tokensIn: r.tokensIn,
      calls: r.calls,
      failed: r.failed,
      avgMs: r.msCount > 0 ? Math.round(r.msSum / r.msCount) : null,
    });
    byModel.set(r.model, list);
  }
  return models.map((m) => {
    const uses = byModel.get(m.model);
    if (!uses) return m;
    uses.sort((a, b) => b.costMicroUsd - a.costMicroUsd || b.calls - a.calls);
    return { ...m, uses };
  });
}
