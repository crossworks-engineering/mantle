/**
 * The curated-pool TEMPLATE is data, and its two ends have to agree.
 *
 * `GET /api/model-pools/export` writes the file; `model-pools-seed.ts` reads it
 * back through `CURATED_MODEL_POOLS`. Until tier 3 of the 2026-09-02 audit the
 * route emitted pools NESTED as `[{ pool, label, models: [...] }]` with
 * `position` dropped, so an exported file could never be seeded — and nothing
 * failed, because no test had ever fed one end to the other.
 *
 * These pin the template's own shape. The route builds a
 * `CuratedTemplateEntry[]` and is type-checked against it, so a route change
 * that broke the contract now fails the build; a DATA change that breaks it
 * fails here.
 */

import { describe, expect, it } from 'vitest';

import { CURATED_MODEL_POOLS, type CuratedTemplateEntry } from './model-pools-data';

describe('curated model pool template', () => {
  it('is a flat array of entries, not pools-with-models', () => {
    expect(Array.isArray(CURATED_MODEL_POOLS)).toBe(true);
    expect(CURATED_MODEL_POOLS.length).toBeGreaterThan(0);
    for (const e of CURATED_MODEL_POOLS) {
      expect(e).not.toHaveProperty('models');
      expect(typeof e.pool).toBe('string');
      expect(typeof e.name).toBe('string');
    }
  });

  it('carries the position the seeder orders by', () => {
    // The nested export shape dropped this field entirely; a template without
    // it seeds every pool in insertion order, silently losing the curation.
    for (const e of CURATED_MODEL_POOLS) {
      expect(Number.isInteger(e.position), `${e.pool}/${e.name} has no position`).toBe(true);
    }
  });

  it('positions are unique within a pool', () => {
    const seen = new Map<string, Set<number>>();
    const clashes: string[] = [];
    for (const e of CURATED_MODEL_POOLS) {
      const set = seen.get(e.pool) ?? new Set<number>();
      if (set.has(e.position)) clashes.push(`${e.pool}: two entries at ${e.position}`);
      set.add(e.position);
      seen.set(e.pool, set);
    }
    expect(clashes).toEqual([]);
  });

  it('every entry has at least one route to call', () => {
    const routeless = CURATED_MODEL_POOLS.filter((e) => e.routes.length === 0).map(
      (e) => `${e.pool}/${e.name}`,
    );
    expect(routeless).toEqual([]);
  });

  it('pricing, when present, is a captured USD snapshot', () => {
    const bad: string[] = [];
    for (const e of CURATED_MODEL_POOLS) {
      if (!e.pricing) continue;
      if (e.pricing.currency !== 'USD') bad.push(`${e.name}: ${e.pricing.currency}`);
      if (Number.isNaN(Date.parse(e.pricing.capturedAt))) bad.push(`${e.name}: capturedAt`);
    }
    expect(bad).toEqual([]);
  });

  it('the JSON parses back into the declared entry type', () => {
    // The .json file is the source; this asserts the cast in model-pools-data.ts
    // is not hiding a shape drift a re-export could introduce.
    const sample: CuratedTemplateEntry | undefined = CURATED_MODEL_POOLS[0];
    expect(sample).toBeDefined();
    expect(Object.keys(sample!).sort()).toEqual(
      ['name', 'note', 'pool', 'position', 'pricing', 'rating', 'routes', 'vendor'].sort(),
    );
  });
});
