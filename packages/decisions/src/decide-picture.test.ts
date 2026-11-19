/**
 * decide() with a picture in the state: sent to a model that takes pictures
 * (Jev), never to one that does not, refused when the picture breaks the
 * limits, and with the use's own timeout floor (`scan_read_check`: 5 s). Its
 * edges stubbed: the worker, its key, the tracing step and the endpoint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  model: '~typesafe/jev-latest',
  sent: [] as Array<{ state: unknown; timeoutMs: number }>,
  skipped: [] as string[],
}));

vi.mock('@mantle/embeddings/provider-outage', () => ({
  noteProviderFailureClass: vi.fn(),
  noteProviderSuccess: vi.fn(),
}));
vi.mock('@mantle/db', () => ({
  getDefaultWorker: vi.fn(async () => ({
    id: 'w1',
    provider: 'openrouter',
    model: h.model,
    apiKeyId: 'k1',
    params: {
      uses: {
        scan_read_check: { enabled: true, mode: 'shadow' },
        passage_scoring: { enabled: true },
      },
    },
  })),
  bumpWorkerUsage: vi.fn(async () => {}),
}));
vi.mock('@mantle/api-keys', () => ({
  getApiKeyById: vi.fn(async () => 'key'),
  getApiKey: vi.fn(async () => 'key'),
  resolveProviderKey: vi.fn(async () => 'key'),
}));
vi.mock('@mantle/tracing', () => ({
  contextLimitFor: () => null,
  log: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  step: vi.fn(async (_o: unknown, fn: (s: unknown) => unknown) =>
    fn({
      setMeta: vi.fn(),
      setOutput: vi.fn(),
      setSkipped: vi.fn((why: string) => h.skipped.push(why)),
    }),
  ),
}));
vi.mock('@mantle/voice', () => ({
  getDecisionAdapter: () => ({
    decide: vi.fn(async (req: { state: unknown; timeoutMs: number }) => {
      h.sent.push({ state: req.state, timeoutMs: req.timeoutMs });
      return { model: h.model, answers: { faithful: { type: 'noul', probability: 0.9 } } };
    }),
  }),
}));

import { clearDecisionCache, decide, forgetResolvedDecider, timeoutOf } from './decide';

/** A PNG header of `w` x `h`. */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const picture = (w: number, hgt: number) => ({
  type: 'image_url',
  image_url: { url: `data:image/png;base64,${png(w, hgt).toString('base64')}` },
});
const q = { faithful: { type: 'noul' as const, instructions: 'faithful?' } };
const ask = (state: unknown, use: 'scan_read_check' | 'passage_scoring' = 'scan_read_check') =>
  decide({ ownerId: 'o1', use, state, questions: q });

beforeEach(() => {
  h.model = '~typesafe/jev-latest';
  h.sent = [];
  h.skipped = [];
  clearDecisionCache();
  forgetResolvedDecider();
});

describe('decide() with a picture', () => {
  it('sends a picture within the limits to Jev, with the 5 s floor of scan_read_check', async () => {
    const state = ['transcription:\nPAGE 7', picture(1108, 1568)];
    const out = await ask(state);
    expect(out?.answers.faithful).toEqual({ type: 'noul', probability: 0.9 });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.state).toBe(state);
    expect(h.sent[0]!.timeoutMs).toBe(5_000);
  });

  it('never sends a picture to a model that takes none', async () => {
    h.model = 'perplexity/pplx-decider-v1.2';
    expect(await ask(['t', picture(1108, 1568)])).toBeNull();
    expect(h.sent).toHaveLength(0);
    expect(h.skipped).toEqual(['no_pictures']);
  });

  it('a picture past the limits is not sent', async () => {
    expect(await ask(['t', picture(1240, 1754)])).toBeNull();
    expect(h.sent).toHaveLength(0);
    expect(h.skipped).toEqual(['over_limit']);
  });

  it('a state with no picture is as before, other uses keep the worker timeout', async () => {
    h.model = 'perplexity/pplx-decider-v1.2';
    await ask({ text: 'no picture' }, 'passage_scoring');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.timeoutMs).toBe(1_500);
  });
});

describe('timeoutOf with a floor', () => {
  it('the floor raises the worker timeout, never past 5 s', () => {
    expect(timeoutOf({}, 1, 5_000)).toBe(5_000);
    expect(timeoutOf({ timeout_ms: 800 }, 1, 2_000)).toBe(2_000);
    expect(timeoutOf({ timeout_ms: 3_000 }, 1, 2_000)).toBe(3_000);
    expect(timeoutOf({}, 1, 9_000)).toBe(5_000);
    expect(timeoutOf({})).toBe(1_500);
  });
});
