/**
 * The cost a provider quotes for a call (OpenRouter's `usage.cost`, USD), as
 * the `reportedCostUsd` of an adapter result. The one reader: every adapter
 * of a provider that quotes a cost spreads this into what it returns, so the
 * recording point (./spend.ts) has the billed cost and not a table guess
 * (docs/spend-recording.md). Nothing when the provider gave none.
 */
export function reportedCost(usage: { cost?: unknown } | null | undefined): {
  reportedCostUsd?: number;
} {
  const cost = usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) ? { reportedCostUsd: cost } : {};
}
