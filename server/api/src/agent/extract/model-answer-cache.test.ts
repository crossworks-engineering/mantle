/**
 * The extractor's call and the answer cache (./model.ts; @mantle/db
 * answer-cache.ts), the cache a map and the model a stub:
 *  - a reply that parses to JSON is kept, and a try again takes it with no
 *    call; a reply that does not is kept as not accepted, and a kept one
 *    is read as it was when fresh (the empty result), with no call.
 *  - the key is the input the model is asked (built again with a fixed
 *    fence): a change to the prompt is a new ask.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  kept: new Map<string, unknown>(),
  accepted: new Map<string, boolean>(),
  chatWithFailover: vi.fn(),
  /** Words added to the built system prompt, as a code change to the
   *  default prompt or the fence's note would. */
  promptEdit: '',
}));

vi.mock('@mantle/std', async (orig) => {
  const real = await orig<typeof import('@mantle/std')>();
  return {
    ...real,
    withFenceNote: (system: string, fence: Parameters<typeof real.withFenceNote>[1]) =>
      real.withFenceNote(system, fence) + h.promptEdit,
  };
});

vi.mock('@mantle/db/answer-cache', async (orig) => ({
  ...(await orig<typeof import('@mantle/db/answer-cache')>()),
  // As a wait's try again takes them: any kept answer, accepted or not
  // (which a fresh job takes is answer-cache.db.test's).
  keptAnswer: vi.fn(async (key: string) => h.kept.get(key) ?? null),
  keepAnswer: vi.fn(async (_kind: string, key: string, answer: unknown, accepted: boolean) => {
    h.kept.set(key, answer);
    h.accepted.set(key, accepted);
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
  h.accepted.clear();
  h.promptEdit = '';
});

describe("the extractor's call and the answer cache", () => {
  it('a reply that parses to JSON is kept: a try again makes no call', async () => {
    reply(REPLY);
    expect(await run()).toMatchObject({ summary: 'A note on P-101.' });
    expect(await run()).toMatchObject({ summary: 'A note on P-101.' });
    expect(h.chatWithFailover).toHaveBeenCalledTimes(1);
    expect(h.kept.size).toBe(1);
  });

  it('a reply that is no JSON is kept as not accepted; taken, it is read as when fresh', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reply('I could not read this note.');
      const first = await run();
      expect(first).toMatchObject({ summary: '', facts: [], entities: [] });
      expect([...h.accepted.values()]).toEqual([false]);
      // A wait's try again takes it: the same result, no call.
      expect(await run()).toEqual(first);
      expect(h.chatWithFailover).toHaveBeenCalledTimes(1);
      // A reply that is JSON is kept as accepted.
      h.kept.clear();
      reply(REPLY);
      await run();
      expect([...h.accepted.values()]).toEqual([true]);
    } finally {
      error.mockRestore();
    }
  });

  it("a change to the prompt it is asked is a new ask; the call's own nonce is not", async () => {
    reply(REPLY);
    await run();
    await run();
    expect(h.chatWithFailover).toHaveBeenCalledTimes(1);
    h.promptEdit = ' Name each pump by its tag.';
    await run();
    expect(h.chatWithFailover).toHaveBeenCalledTimes(2);
    // The model was asked the new prompt.
    expect(h.chatWithFailover.mock.calls[1]![2].messages[0].content).toContain(
      'Name each pump by its tag.',
    );
    await run();
    expect(h.chatWithFailover).toHaveBeenCalledTimes(2);
  });
});
