/**
 * A Present canvas's one extractor call (Journal v3 J9): its picture goes
 * only to a vision worker, in that ONE call; with none wired the call is
 * the usual text call and no picture is fetched or drawn. Never two calls,
 * never a picture to a text model. No live model: both routes are stubs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolveDefaultWorker: vi.fn(),
  getPresent: vi.fn(),
  latestCanvasPicture: vi.fn(),
  runVisionWorker: vi.fn(),
  chatWithFailover: vi.fn(),
}));

vi.mock('@mantle/api-keys', () => ({ resolveDefaultWorker: h.resolveDefaultWorker }));
vi.mock('@mantle/voice', () => ({ getVisionAdapter: vi.fn(() => ({ extract: vi.fn() })) }));
vi.mock('@mantle/content/presents', () => ({ getPresent: h.getPresent }));
vi.mock('@mantle/tools', () => ({ latestCanvasPicture: h.latestCanvasPicture }));
vi.mock('@mantle/runtime/agent', () => ({
  runVisionWorker: h.runVisionWorker,
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
  summary: 'A pump skid P&ID.',
  facts: [],
  entities: [],
  relations: [],
});
const WORKER = { id: 'w1', slug: 'extractor', provider: 'local', model: 'text-model' } as never;
const ROUTES = { primary: { provider: 'local', model: 'text-model' } } as never;
const canvas = { id: 'c1', type: 'present', title: 'Feed pump skid', data: {} } as never;

const run = (node = canvas) => runExtractorModel(node, 'o1', WORKER, ROUTES, {}, 'P-101 A/B', {});

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveDefaultWorker.mockResolvedValue({
    ok: true,
    worker: { id: 'v1', slug: 'vision', provider: 'openrouter', model: 'vision-model' },
    credential: { apiKey: 'not-a-real-key' },
  });
  h.getPresent.mockResolvedValue({ id: 'c1', source: '<svg></svg>', meta: {}, rev: 2 });
  h.latestCanvasPicture.mockResolvedValue({ png: Buffer.from('png-bytes'), mime: 'image/png' });
  h.runVisionWorker.mockResolvedValue({
    ran: true,
    text: REPLY,
    note: null,
    model: 'vision-model',
  });
  h.chatWithFailover.mockResolvedValue({ result: { text: REPLY }, failedOver: false });
});

describe("a canvas's one extractor call", () => {
  it('goes to the vision worker with the picture when one is wired: one call, no text call', async () => {
    const out = await run();
    expect(h.runVisionWorker).toHaveBeenCalledTimes(1);
    expect(h.chatWithFailover).not.toHaveBeenCalled();
    const req = h.runVisionWorker.mock.calls[0]![0];
    expect(req.bytes).toEqual(Buffer.from('png-bytes'));
    expect(req.prompt).toContain('P-101 A/B');
    expect(req.systemPrompt).toMatch(/JSON/);
    expect(out).toMatchObject({ summary: 'A pump skid P&ID.', model: 'vision-model' });
  });

  it('with no vision worker: the text call alone, and no picture fetched or drawn', async () => {
    h.resolveDefaultWorker.mockResolvedValue({ ok: false, why: 'none', worker: null });
    const out = await run();
    expect(h.chatWithFailover).toHaveBeenCalledTimes(1);
    expect(h.runVisionWorker).not.toHaveBeenCalled();
    expect(h.getPresent).not.toHaveBeenCalled();
    expect(h.latestCanvasPicture).not.toHaveBeenCalled();
    const msgs = h.chatWithFailover.mock.calls[0]![2].messages;
    expect(typeof msgs[1].content).toBe('string');
    expect(out).toMatchObject({ summary: 'A pump skid P&ID.', model: 'text-model' });
  });

  it('with no picture to send: the text call alone', async () => {
    h.latestCanvasPicture.mockResolvedValue(null);
    await run();
    expect(h.chatWithFailover).toHaveBeenCalledTimes(1);
    expect(h.runVisionWorker).not.toHaveBeenCalled();
  });

  it('a failed vision call fails the pass; it is never followed by a text call', async () => {
    h.runVisionWorker.mockResolvedValue({
      ran: false,
      text: '',
      note: 'Vision worker failed: x',
      model: 'vision-model',
    });
    await expect(run()).rejects.toThrow('Vision worker failed');
    expect(h.chatWithFailover).not.toHaveBeenCalled();
  });

  it('any other type never looks for a vision route', async () => {
    await run({ id: 'n1', type: 'note', title: 'A note', data: {} } as never);
    expect(h.resolveDefaultWorker).not.toHaveBeenCalled();
    expect(h.chatWithFailover).toHaveBeenCalledTimes(1);
  });
});
