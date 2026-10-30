/**
 * resolveDefaultWorker: the one resolution of an owner's default worker and
 * its key (runVisionWorker and circuit_verify share it). The refusals come
 * in one order, and the caller's `usable` check is asked before the key is
 * opened, so a worker the caller cannot run never touches its key. Made-up
 * worker and key; the database is stubbed.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  worker: null as null | Record<string, unknown>,
  rows: [] as Record<string, unknown>[],
  keyReads: 0,
}));

vi.mock('@mantle/db', () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      h.keyReads += 1;
      return h.rows;
    },
  };
  return {
    db: {},
    onFullSystemRoute: () => false,
    apiKeys: {},
    getDefaultWorker: async () => h.worker,
    systemDb: {
      select: () => chain,
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
  };
});

// A throwaway key for this file only, never a real one.
beforeAll(() => {
  vi.stubEnv('MANTLE_MASTER_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('MANTLE_MASTER_KEY_NEXT', '');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  h.worker = null;
  h.rows = [];
  h.keyReads = 0;
});

const worker = (over: Record<string, unknown> = {}) => ({
  id: 'w-1',
  slug: 'vision-test',
  provider: 'openrouter',
  model: 'test/vision',
  apiKeyId: 'k-1',
  ...over,
});

describe('resolveDefaultWorker', () => {
  it('names why, in order: no worker, no key, unusable, unreadable key', async () => {
    const { resolveDefaultWorker } = await import('./index');
    expect(await resolveDefaultWorker('o', 'vision')).toEqual({
      ok: false,
      why: 'none',
      worker: null,
    });
    h.worker = worker({ apiKeyId: null });
    expect(await resolveDefaultWorker('o', 'vision')).toMatchObject({ ok: false, why: 'no_key' });
    h.worker = worker();
    expect(await resolveDefaultWorker('o', 'vision', () => false)).toMatchObject({
      ok: false,
      why: 'unusable',
      worker: { slug: 'vision-test' },
    });
    // The caller's check refused it: the key was never opened.
    expect(h.keyReads).toBe(0);
    expect(await resolveDefaultWorker('o', 'vision', () => true)).toMatchObject({
      ok: false,
      why: 'unreadable_key',
    });
    expect(h.keyReads).toBe(1);
  });

  it('opens the key of a usable worker', async () => {
    const { resolveDefaultWorker } = await import('./index');
    const { seal } = await import('@mantle/crypto');
    h.worker = worker();
    h.rows = [
      {
        id: 'k-1',
        service: 'openrouter',
        kind: 'token',
        keyEnc: seal('sk-test-made-up', 'k-1').ciphertext,
      },
    ];
    const r = await resolveDefaultWorker('o', 'vision');
    expect(r).toMatchObject({
      ok: true,
      worker: { slug: 'vision-test' },
      credential: { apiKey: 'sk-test-made-up' },
    });
  });
});
