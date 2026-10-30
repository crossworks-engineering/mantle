/**
 * The worker tools' defaultWorkerOrError is a wording over the one
 * resolution (@mantle/api-keys resolveDefaultWorker), not a second one: on
 * the same owner both pick the same worker and open the same key, and each
 * refusal keeps the sentence the tools always gave. Made-up worker and key
 * sealed under a throwaway master key; the database reads are stubbed.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  worker: null as null | Record<string, unknown>,
  rows: [] as Record<string, unknown>[],
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => h.rows,
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    getDefaultWorker: async () => h.worker,
    systemDb: {
      select: () => chain,
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
  };
});

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
});

const worker = (over: Record<string, unknown> = {}) => ({
  id: 'w-1',
  slug: 'stt-test',
  provider: 'openai',
  model: 'test/stt',
  apiKeyId: 'k-1',
  ...over,
});

describe('defaultWorkerOrError over resolveDefaultWorker', () => {
  it('picks the same worker and opens the same key', async () => {
    const { resolveDefaultWorker } = await import('@mantle/api-keys');
    const { defaultWorkerOrError } = await import('./builtins-workers');
    const { seal } = await import('@mantle/crypto');
    h.worker = worker();
    h.rows = [
      {
        id: 'k-1',
        service: 'openai',
        kind: 'token',
        keyEnc: seal('sk-test-made-up', 'k-1').ciphertext,
      },
    ];
    const one = await resolveDefaultWorker('o', 'stt');
    const tool = await defaultWorkerOrError('o', 'stt');
    expect(one.ok && tool.ok).toBe(true);
    if (!one.ok || !tool.ok) return;
    expect(tool.worker).toEqual(one.worker);
    expect(tool.worker.slug).toBe('stt-test');
    expect(tool.credential).toEqual(one.credential);
    expect(tool.credential).toMatchObject({ apiKey: 'sk-test-made-up' });
  });

  it('words each refusal as the tools always did', async () => {
    const { resolveDefaultWorker } = await import('@mantle/api-keys');
    const { defaultWorkerOrError } = await import('./builtins-workers');
    expect(await resolveDefaultWorker('o', 'tts')).toMatchObject({ why: 'none' });
    expect(await defaultWorkerOrError('o', 'tts')).toEqual({
      ok: false,
      error:
        'No default tts worker configured. Create one at /settings/ai-workers and mark it default.',
    });
    h.worker = worker({ slug: 'tts-test', apiKeyId: null });
    expect(await resolveDefaultWorker('o', 'tts')).toMatchObject({ why: 'no_key' });
    expect(await defaultWorkerOrError('o', 'tts')).toEqual({
      ok: false,
      error:
        "The default tts worker 'tts-test' has no api_key attached. Edit it at /settings/ai-workers.",
    });
    h.worker = worker({ slug: 'tts-test' });
    expect(await resolveDefaultWorker('o', 'tts')).toMatchObject({ why: 'unreadable_key' });
    expect(await defaultWorkerOrError('o', 'tts')).toEqual({
      ok: false,
      error:
        "The api_key for tts worker 'tts-test' could not be decrypted. Check /settings/api-keys.",
    });
  });
});
