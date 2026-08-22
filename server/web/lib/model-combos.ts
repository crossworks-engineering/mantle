/**
 * Named full combinations — one decision instead of thirteen.
 *
 * A combination picks a model from EVERY curated pool at once. The three
 * built-ins are DERIVED live from the owner's pools (not stored), so they
 * track re-curation automatically:
 *
 *   best-advanced — the priciest (blended) entry per pool; unpriced pools
 *                   (voice — per-minute billing) fall back to the curator's
 *                   best-fit-first order, position 0.
 *   cheapest      — the lowest blended price per pool (free wins); unpriced
 *                   pools take the LAST position (curators order best→budget).
 *   cost-aware    — the shipped philosophy: a strong-but-median responder
 *                   pick from the agents pool, the cheapest PAID entry per
 *                   worker pool (free tiers are rate-limited fallbacks, not
 *                   defaults), middle-of-pool for unpriced pools.
 *
 * Applying is an explicit one-shot: the API computes a DIFF against what
 * every conversational agent and default worker actually runs, the owner
 * reviews (and can exclude rows), then apply writes through the same
 * updateAgent / updateAiWorker paths the settings forms use. Targets whose
 * routes have no usable API key are reported, never silently skipped-into.
 * Embedding is untouched by construction — it has no pool.
 */

import type { CuratedModel, CuratedPricing, CuratedRoute } from '@mantle/db';
import { MODEL_POOLS } from '@mantle/client-types/model-pools';

export type ComboKey = 'best-advanced' | 'cost-aware' | 'cheapest' | 'free';

export const COMBO_DEFS: readonly { key: ComboKey; label: string; description: string }[] = [
  {
    key: 'best-advanced',
    label: 'Best advanced',
    description: 'The strongest model in every pool. Price no object.',
  },
  {
    key: 'cost-aware',
    label: 'Smartest cost-aware',
    description: 'A strong responder with cheap workhorse workers - the balanced default.',
  },
  {
    key: 'cheapest',
    label: 'Cheapest paid',
    description:
      'The lowest PAID spend that still performs: cheapest well-rated model per pool, never the free tier.',
  },
  {
    key: 'free',
    label: 'Free',
    description:
      'Zero spend wherever a credible free model is curated; pools without one are left unchanged.',
  },
];

/** The slice of a curated entry the combo math needs. */
export type PoolEntry = Pick<CuratedModel, 'pool' | 'position' | 'name' | 'rating' | 'note'> & {
  routes: CuratedRoute[];
  pricing: CuratedPricing | null;
};

const INPUT_SHARE = 0.75;

/** Blended $ per 1M (75/25 in/out). 0 is REAL (a free model); null = unknown. */
export function blendedPerM(pricing: CuratedPricing | null): number | null {
  if (!pricing) return null;
  const i = pricing.inputPerM;
  const o = pricing.outputPerM;
  if (i == null && o == null) return null;
  return INPUT_SHARE * (i ?? o ?? 0) + (1 - INPUT_SHARE) * (o ?? i ?? 0);
}

/** The combo's pick for one pool. Pure; null when the pool is empty. */
export function pickForPool(key: ComboKey, entries: PoolEntry[], pool: string): PoolEntry | null {
  const sorted = [...entries].sort((a, b) => a.position - b.position);
  if (sorted.length === 0) return null;
  const priced = sorted
    .map((e) => ({ e, b: blendedPerM(e.pricing) }))
    .filter((x): x is { e: PoolEntry; b: number } => x.b != null);

  if (key === 'best-advanced') {
    if (priced.length === 0) return sorted[0]!;
    return priced.reduce((m, x) => (x.b > m.b ? x : m)).e;
  }
  if (key === 'free') {
    // Only a genuinely free model qualifies; a pool without one yields no
    // pick, and the diff reports it instead of quietly substituting a paid one.
    const free = priced.filter((x) => x.b === 0);
    return free.length ? free.map((x) => x.e).sort((a, b) => a.position - b.position)[0]! : null;
  }
  if (key === 'cheapest') {
    // Cheapest PAID that still performs: free tiers have their own combo, and
    // among paid entries a well-rated one (>=3 stars) beats a cheaper unrated
    // gamble. Fallbacks: any paid, any priced, then curator order (unpriced
    // pools list best -> budget, so the tail is the budget fit).
    if (priced.length === 0) return sorted[sorted.length - 1]!;
    const paid = priced.filter((x) => x.b > 0);
    const rated = paid.filter((x) => (x.e.rating ?? 0) >= 3);
    const pickFrom = rated.length ? rated : paid.length ? paid : priced;
    return pickFrom.reduce((m, x) => (x.b < m.b ? x : m)).e;
  }
  // cost-aware
  if (pool === 'agents') {
    if (priced.length === 0) return sorted[Math.floor((sorted.length - 1) / 2)]!;
    // UPPER median (descending order): "strong responder" leans toward the
    // capable half of the pool and never lands on the free tail.
    const byPrice = [...priced].sort((a, b) => b.b - a.b);
    return byPrice[Math.floor((byPrice.length - 1) / 2)]!.e;
  }
  const paid = priced.filter((x) => x.b > 0);
  if (paid.length > 0) return paid.reduce((m, x) => (x.b < m.b ? x : m)).e;
  if (priced.length > 0) return priced.reduce((m, x) => (x.b < m.b ? x : m)).e;
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** Resolve which of an entry's routes this brain can actually run: prefer
 *  keeping the target's current provider, then openrouter, then any route
 *  with a key on file. Null when no route has a usable key. */
export function resolveRoute(
  routes: CuratedRoute[],
  keyIdByService: Map<string, string>,
  currentProvider: string,
): { provider: string; model: string; apiKeyId: string } | null {
  const candidates = [
    routes.find((r) => r.provider === currentProvider),
    routes.find((r) => r.provider === 'openrouter'),
    ...routes,
  ].filter((r): r is CuratedRoute => !!r);
  for (const r of candidates) {
    const keyId = keyIdByService.get(r.provider);
    if (keyId) return { provider: r.provider, model: r.model, apiKeyId: keyId };
  }
  return null;
}

export type ComboTarget = {
  /** 'agent:<uuid>' | 'worker:<uuid>' — stable exclude/apply handle. */
  id: string;
  targetKind: 'agent' | 'worker';
  label: string;
  pool: string;
  pick: string | null;
  current: { provider: string; model: string };
  next: { provider: string; model: string; apiKeyId: string } | null;
  changed: boolean;
  /** Why `next` is null — empty pool, or no key for any of the pick's routes. */
  reason?: string;
};

export type TargetInput = {
  id: string;
  kind: 'agent' | 'worker';
  label: string;
  pool: string;
  provider: string;
  model: string;
};

/** The full diff for one combo. Pure — callers load entries/targets/keys. */
export function buildComboDiff(
  key: ComboKey,
  entries: PoolEntry[],
  targets: TargetInput[],
  keyIdByService: Map<string, string>,
): ComboTarget[] {
  const byPool = new Map<string, PoolEntry[]>();
  for (const e of entries) {
    const arr = byPool.get(e.pool) ?? [];
    arr.push(e);
    byPool.set(e.pool, arr);
  }
  const picks = new Map<string, PoolEntry | null>();
  for (const p of MODEL_POOLS) picks.set(p.id, pickForPool(key, byPool.get(p.id) ?? [], p.id));

  return targets.map((t) => {
    const pick = picks.get(t.pool) ?? null;
    if (!pick) {
      const hasEntries = (byPool.get(t.pool) ?? []).length > 0;
      return {
        id: `${t.kind}:${t.id}`,
        targetKind: t.kind,
        label: t.label,
        pool: t.pool,
        pick: null,
        current: { provider: t.provider, model: t.model },
        next: null,
        changed: false,
        reason: hasEntries
          ? 'no free model curated in this pool; left unchanged'
          : 'pool is empty; curate it first',
      };
    }
    const next = resolveRoute(pick.routes, keyIdByService, t.provider);
    if (!next) {
      return {
        id: `${t.kind}:${t.id}`,
        targetKind: t.kind,
        label: t.label,
        pool: t.pool,
        pick: pick.name,
        current: { provider: t.provider, model: t.model },
        next: null,
        changed: false,
        reason: `no API key for any of ${pick.name}'s routes (${pick.routes.map((r) => r.provider).join(', ')})`,
      };
    }
    const changed = next.provider !== t.provider || next.model !== t.model;
    return {
      id: `${t.kind}:${t.id}`,
      targetKind: t.kind,
      label: t.label,
      pool: t.pool,
      pick: pick.name,
      current: { provider: t.provider, model: t.model },
      next,
      changed,
    };
  });
}
