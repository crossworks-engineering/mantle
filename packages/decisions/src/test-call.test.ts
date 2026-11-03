import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Test button: one request, sent as production sends it.
const h = vi.hoisted(() => ({
  calls: [] as Array<{ privacy: unknown; timeoutMs: number; model: string }>,
  outcome: 'ok' as 'ok' | 'fail' | '404',
  key: 'key' as string | null,
  adapter: true,
  tokensIn: 40,
}));

vi.mock('@mantle/db', () => ({
  getDefaultWorker: vi.fn(async () => null),
  bumpWorkerUsage: vi.fn(async () => {}),
}));
vi.mock('@mantle/embeddings/provider-outage', () => ({
  noteProviderFailureClass: vi.fn(),
  noteProviderSuccess: vi.fn(),
}));
vi.mock('@mantle/api-keys', () => ({
  resolveProviderKey: vi.fn(async () => (h.key ? { apiKey: h.key } : null)),
}));
vi.mock('@mantle/tracing', () => ({
  contextLimitFor: () => null,
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  step: vi.fn(),
}));
vi.mock('@mantle/voice', async () => {
  const { ProviderHttpError } = await import('@mantle/std');
  return {
    getDecisionAdapter: () =>
      h.adapter
        ? {
            adapterName: 'openrouter-decision',
            decide: vi.fn(
              async (req: {
                privacy: unknown;
                timeoutMs: number;
                model: string;
                questions: Record<string, unknown>;
              }) => {
                h.calls.push({ privacy: req.privacy, timeoutMs: req.timeoutMs, model: req.model });
                if (h.outcome === '404') {
                  throw new ProviderHttpError({
                    provider: 'openrouter',
                    status: 404,
                    body: 'No endpoints found',
                    message: 'openrouter-decision 404: No endpoints found',
                  });
                }
                if (h.outcome === 'fail') throw new Error('openrouter-decision: no answers');
                return {
                  model: req.model,
                  tokensIn: h.tokensIn,
                  reportedCostUsd: 0.0001,
                  answers: Object.fromEntries(
                    Object.keys(req.questions).map((k) => [k, { type: 'noul', probability: 0.9 }]),
                  ),
                };
              },
            ),
          }
        : null,
  };
});

import { noteProviderFailureClass, noteProviderSuccess } from '@mantle/embeddings/provider-outage';
import { testDecisionWorker } from './test-call';

const worker = (params: Record<string, unknown> = {}, model = '~typesafe/jev-latest') => ({
  kind: 'decider',
  slug: 'decider',
  provider: 'openrouter',
  model,
  apiKeyId: null,
  params,
});

beforeEach(() => {
  h.calls = [];
  h.outcome = 'ok';
  h.key = 'key';
  h.adapter = true;
  h.tokensIn = 40;
  vi.mocked(noteProviderFailureClass).mockClear();
  vi.mocked(noteProviderSuccess).mockClear();
});

describe('testDecisionWorker', () => {
  it('sends ONE request with the real privacy and timeout and answers ok', async () => {
    const r = await testDecisionWorker('o1', worker({ timeout_ms: 900 }) as never, '');
    expect(h.calls).toEqual([{ privacy: 'zdr', timeoutMs: 900, model: '~typesafe/jev-latest' }]);
    expect(r).toMatchObject({ ok: true, privacy: 'zdr', timeoutMs: 900, costUsd: 0.0001 });
  });

  it('the old zdr: false is no_training; a privacy key that disagrees keeps the stricter', async () => {
    await testDecisionWorker('o1', worker({ zdr: false }) as never, '');
    await testDecisionWorker('o1', worker({ zdr: true, privacy: 'no_training' }) as never, '');
    expect(h.calls.map((c) => c.privacy)).toEqual(['no_training', 'zdr']);
  });

  it('a 404 under zdr is a plain reason, sent once, never again with less privacy', async () => {
    h.outcome = '404';
    const r = await testDecisionWorker('o1', worker() as never, '');
    expect(h.calls).toHaveLength(1);
    expect(r).toMatchObject({ ok: false, code: 'privacy_route', privacy: 'zdr' });
    if (!r.ok) expect(r.detail).toMatch(/404/);
  });

  it('leaves the breaker and the decision alert alone', async () => {
    h.outcome = 'fail';
    await testDecisionWorker('o1', worker() as never, '');
    h.outcome = 'ok';
    await testDecisionWorker('o1', worker() as never, '');
    expect(noteProviderFailureClass).not.toHaveBeenCalled();
    expect(noteProviderSuccess).not.toHaveBeenCalled();
  });

  it('a suspected cut is a failure', async () => {
    h.tokensIn = 16_384;
    const r = await testDecisionWorker('o1', worker({}, 'cloudflare/clef-flash') as never, '');
    expect(r).toMatchObject({ ok: false, code: 'cut' });
  });

  it('no key or no adapter answers the reason without a call', async () => {
    h.key = null;
    expect(await testDecisionWorker('o1', worker() as never, '')).toMatchObject({
      ok: false,
      code: 'no_key',
    });
    h.key = 'key';
    h.adapter = false;
    expect(await testDecisionWorker('o1', worker() as never, '')).toMatchObject({
      ok: false,
      code: 'no_adapter',
    });
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a worker that is not a decider', async () => {
    await expect(
      testDecisionWorker('o1', { ...worker(), kind: 'chat' } as never, ''),
    ).rejects.toThrow(/not a decider/);
  });
});
