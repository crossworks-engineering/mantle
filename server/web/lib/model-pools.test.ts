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

describe('curated template + onboarding choices', () => {
  it('template pools are all known and entries are well-formed', async () => {
    const { CURATED_MODEL_POOLS } = await import('@mantle/client-types/model-pools-data');
    expect(CURATED_MODEL_POOLS.length).toBeGreaterThan(50);
    for (const e of CURATED_MODEL_POOLS) {
      expect(MODEL_POOL_IDS.has(e.pool), `template pool '${e.pool}' unknown`).toBe(true);
      expect(e.routes.length).toBeGreaterThan(0);
      for (const r of e.routes) {
        expect(r.provider).toMatch(/^[a-z0-9_-]+$/);
        expect(r.model.length).toBeGreaterThan(0);
      }
    }
  });

  it('onboarding lists keep exactly one recommended (the manifest default) and no duplicate ids', async () => {
    const { ASSISTANT_MODEL_CHOICES, WORKER_MODEL_CHOICES } =
      await import('@mantle/client-types/model-choices');
    for (const list of [ASSISTANT_MODEL_CHOICES, WORKER_MODEL_CHOICES]) {
      const ids = list.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(list.filter((c) => c.recommended).length).toBe(1);
    }
    expect(ASSISTANT_MODEL_CHOICES.find((c) => c.recommended)?.id).toBe(
      'anthropic/claude-sonnet-5',
    );
    expect(WORKER_MODEL_CHOICES.find((c) => c.recommended)?.id).toBe(
      'google/gemini-3.1-flash-lite',
    );
    // The extension actually widened the lists beyond the hand-written heads.
    expect(ASSISTANT_MODEL_CHOICES.length).toBeGreaterThan(4);
    expect(WORKER_MODEL_CHOICES.length).toBeGreaterThan(4);
  });
});
