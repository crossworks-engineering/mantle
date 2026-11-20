/**
 * The extractor's call and the answer cache (./model.ts; @mantle/db
 * answer-cache.ts), the cache a map and the model a stub:
 *  - a reply that parses to JSON is kept, and a try again takes it with no
 *    call; a reply that does not is not kept, so a try again asks again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  kept: new Map<string, unknown>(),
  chatWithFailover: vi.fn(),
}));

vi.mock('@mantle/db/answer-cache', async (orig) => ({
  ...(await orig<typeof import('@mantle/db/answer-cache')>()),
  keptAnswer: vi.fn(async (key: string) => h.kept.get(key) ?? null),
  keepAnswer: vi.fn(async (_kind: string, key: string, answer: unknown) => {
    h.kept.set(key, answer);
  }),
}));
vi.mock('@mantle/runtime/agent', () => ({
  runVisionWorker: vi.fn(),
  chatWithFailover: h.chatWithFailover,
  resolveChatRoutes: vi.fn(),
}));
vi.mock('@mantle/embeddings', () => ({
  noteProviderFailure: vi.fn(),
  noteProviderSuccess: vi.fn(),
  tagProviderSubject: vi.fn(),
}));
vi.mock('@mantle/tracing', () => ({
  step: vi.fn(async (_init: unknown, fn: (x: unknown) => unknown) =>
    fn({ setOutput: () => {}, setMeta: () => {} }),
  ),
}));

import { runExtractorModel } from './model';

const REPLY = JSON.stringify({
  summary: 'A note on P-101.',
  facts: [],
  entities: [],
  relations: [],
});
const WORKER = { id: 'w1', slug: 'extractor', provider: 'local', model: 'text-model' } as never;
const ROUTES = { primary: { provider: 'local', model: 'text-model' } } as never;
const note = { id: 'n1', type: 'note', title: 'Pump P-101', data: {} } as never;

const run = () => runExtractorModel(note, 'o1', WORKER, ROUTES, {}, 'P-101 A/B', {});
const reply = (text: string) =>
  h.chatWithFailover.mockResolvedValue({ result: { text }, failedOver: false });

beforeEach(() => {
  vi.clearAllMocks();
  h.kept.clear();
});

describe("the extractor's call and the answer cache", () => {
  it('a reply that parses to JSON is kept: a try again makes no call', async () => {
    reply(REPLY);
    expect(await run()).toMatchObject({ summary: 'A note on P-101.' });
    expect(await run()).toMatchObject({ summary: 'A note on P-101.' });
    expect(h.chatWithFailover).toHaveBeenCalledTimes(1);
    expect(h.kept.size).toBe(1);
  });

  it('a reply that is no JSON is not kept: a try again asks again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reply('I could not read this note.');
      await run();
      await run();
      expect(h.chatWithFailover).toHaveBeenCalledTimes(2);
      expect(h.kept.size).toBe(0);
      // Its next reply, JSON, is kept.
      reply(REPLY);
      await run();
      await run();
      expect(h.chatWithFailover).toHaveBeenCalledTimes(3);
    } finally {
      error.mockRestore();
    }
  });
});
