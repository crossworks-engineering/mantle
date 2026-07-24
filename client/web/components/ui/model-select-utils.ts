/**
 * Pure helpers backing `<ModelSelect>` — sort, badge formatters, the small
 * predicates used to decide whether a pricing pill should render.
 *
 * Lives in a separate file from `model-select.tsx` so vitest can cover the
 * formatting + sort invariants without dragging the React JSX imports
 * (which would chain through `@/components/ui/command` and friends, paths
 * vitest's root config doesn't resolve).
 */
import type { ExplorerModel } from '@server/lib/model-explorer';

export type ModelSelectSortKey = 'newest' | 'name' | 'cheapest' | 'context';

/** Sort the model list by the requested key. Stable: rows missing the sort
 *  field fall to the bottom of their group rather than jumbling. */
export function sortModels(models: ExplorerModel[], key: ModelSelectSortKey): ExplorerModel[] {
  const copy = [...models];
  switch (key) {
    case 'newest':
      // ISO strings sort lexicographically equivalent to chronologically;
      // missing `created` falls back to the original order at the end.
      return copy.sort((a, b) => {
        const av = a.created ?? '';
        const bv = b.created ?? '';
        if (av && bv) return bv.localeCompare(av);
        if (av) return -1;
        if (bv) return 1;
        return 0;
      });
    case 'name':
      return copy.sort((a, b) =>
        (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: 'base' }),
      );
    case 'cheapest':
      return copy.sort((a, b) => {
        const av = priceTotal(a);
        const bv = priceTotal(b);
        // Models without pricing sink to the bottom — they're not
        // comparable, and 0 would unfairly promote them.
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av - bv;
      });
    case 'context':
      return copy.sort((a, b) => (b.contextTokens ?? 0) - (a.contextTokens ?? 0));
  }
}

/** Sum of in + out per-1M-token cost for the "cheapest" sort key. Models
 *  that don't expose pricing return null (caller treats as last). */
function priceTotal(m: ExplorerModel): number | null {
  if (m.inputPricePerM == null && m.outputPricePerM == null) return null;
  return (m.inputPricePerM ?? 0) + (m.outputPricePerM ?? 0);
}

/** Does this row have any non-zero pricing? Drives the `$x / $y` badge —
 *  free rows render the `free` badge instead. */
export function hasPrice(m: ExplorerModel): boolean {
  return (
    (m.inputPricePerM != null && m.inputPricePerM > 0) ||
    (m.outputPricePerM != null && m.outputPricePerM > 0)
  );
}

/** Both sides explicitly priced as 0 — the OpenRouter convention for free
 *  routes. Drives a distinct `free` pill so the operator sees them clearly. */
export function isFree(m: ExplorerModel): boolean {
  return m.inputPricePerM === 0 && m.outputPricePerM === 0;
}

/** Token-count formatter. `1_050_000 → "1M"`, `200_000 → "200k"`, `4096 → "4k"`. */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return String(tokens);
}

/** Per-million pricing as `$3 / $15` (input / output). Strips trailing
 *  zeros — `$0.20` not `$0.2`, `$3` not `$3.00`. Half-priced rows (only
 *  input or only output known) render the missing side as `?` so the row
 *  still tells the operator something rather than being dropped. */
export function formatPriceCompact(m: ExplorerModel): string {
  const fmt = (n: number | undefined) => {
    if (n == null) return '?';
    if (n === 0) return '$0';
    if (n < 1) return `$${n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
    return `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
  };
  return `${fmt(m.inputPricePerM)} / ${fmt(m.outputPricePerM)}`;
}
