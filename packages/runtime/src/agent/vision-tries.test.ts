/**
 * `runVisionWorker` with `tries`: a provider that failed (a timeout, a
 * stall) is asked one time more when the caller says 2, and never when it
 * says nothing. A made-up worker and adapter; no provider, no database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The answers of the made-up provider, in order: `fail` throws (a
 *  timeout), `read` answers. Past the end: `fail`. */
const h = vi.hoisted(() => ({ plan: [] as ('fail' | 'read')[], calls: 0 }));
const extract = async () => {
  h.calls += 1;
  if ((h.plan.shift() ?? 'fail') === 'fail') throw new Error('timeout');
  return { text: 'read' };
};

vi.mock('@mantle/db', () => ({ bumpWorkerUsage: vi.fn(), getDefaultWorker: vi.fn() }));
// The public text of a failed call, with no log line.
vi.mock('@mantle/std', async (orig) => ({
  ...(await orig<typeof import('@mantle/std')>()),
  publicProviderErrorMessage: () => 'The provider does not answer in time.',
}));
vi.mock('@mantle/api-keys', () => ({
  getApiKeyById: vi.fn(),
  resolveDefaultWorker: vi.fn(async () => ({
    ok: true,
    worker: { id: 'w-1', provider: 'made-up', model: 'made-up-model', params: {} },
    credential: { apiKey: 'k' },
  })),
}));
vi.mock('@mantle/voice', () => ({
  DEFAULT_VISION_DESCRIBE_PROMPT: 'describe',
  getVisionAdapter: () => ({ adapterName: 'made-up', extract }),
}));
vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof import('@mantle/files')>()),
  transcodeImageForVision: async (bytes: Buffer, mimeType: string) => ({ bytes, mimeType }),
}));

import { runVisionWorker } from './attachments';

const ask = (tries?: 1 | 2) =>
  runVisionWorker({
    ownerId: 'o-1',
    bytes: Buffer.from('made-up picture'),
    mimeType: 'image/png',
    ...(tries ? { tries } : {}),
  });

describe('runVisionWorker tries', () => {
  beforeEach(() => {
    h.plan = [];
    h.calls = 0;
  });

  it('with tries 2, a failed call is asked one time more, and its answer is kept', async () => {
    h.plan = ['fail', 'read'];
    const out = await ask(2);
    expect(h.calls).toBe(2);
    expect(out).toMatchObject({ ran: true, text: 'read' });
  });

  it('with tries 2, two failed calls: ran false, and no third call', async () => {
    const out = await ask(2);
    expect(h.calls).toBe(2);
    expect(out.ran).toBe(false);
  });

  it('with no tries, one call only', async () => {
    expect((await ask()).ran).toBe(false);
    expect(h.calls).toBe(1);
  });

  it('an answer on the first call: one call', async () => {
    h.plan = ['read'];
    expect((await ask(2)).text).toBe('read');
    expect(h.calls).toBe(1);
  });
});
