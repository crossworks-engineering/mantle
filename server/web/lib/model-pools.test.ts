import { describe, expect, it } from 'vitest';
import { aiWorkerKind } from '@mantle/db';
import { MODEL_POOLS, MODEL_POOL_IDS } from './model-pools';

describe('MODEL_POOLS', () => {
  it("is 'agents' plus every ai_worker kind except embedding", () => {
    const kinds = new Set<string>(aiWorkerKind.enumValues);
    for (const pool of MODEL_POOLS) {
      if (pool.id === 'agents') continue;
      expect(kinds.has(pool.id), `pool '${pool.id}' is not an ai_worker kind`).toBe(true);
    }
    // Embedding is locked to the 768-dim singleton — never curatable.
    expect(MODEL_POOL_IDS.has('embedding')).toBe(false);
    // Drift tripwire: a NEW worker kind should get a pool (or an explicit
    // exclusion here). embedding is the only sanctioned exclusion.
    for (const kind of kinds) {
      if (kind === 'embedding') continue;
      expect(MODEL_POOL_IDS.has(kind), `worker kind '${kind}' has no curated pool`).toBe(true);
    }
  });

  it('ids are unique and every pool has a description', () => {
    expect(MODEL_POOL_IDS.size).toBe(MODEL_POOLS.length);
    for (const p of MODEL_POOLS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(20);
      expect(['agents', 'workers']).toContain(p.group);
    }
  });
});
