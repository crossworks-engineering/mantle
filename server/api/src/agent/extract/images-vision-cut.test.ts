/**
 * The picture read (visionIngestImageNode) and an answer cut at its token
 * cap: a thinking model can spend the whole cap on its hidden thinking and
 * answer with no text. That is no verdict on the picture, so the read is
 * not `ran` (the caller records no terminal `no_vision_text`); a real empty
 * answer still is. The read asks for the least thinking. A made-up worker,
 * no database, no provider.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ runVisionWorker: vi.fn() }));

vi.mock('@mantle/runtime/agent', async (orig) => ({
  ...(await orig<typeof import('@mantle/runtime/agent')>()),
  runVisionWorker: h.runVisionWorker,
}));
vi.mock('@mantle/tracing', async (orig) => ({
  ...(await orig<typeof import('@mantle/tracing')>()),
  startTrace: vi.fn(async (_init: unknown, fn: () => unknown) => fn()),
  step: vi.fn(async (_init: unknown, fn: (x: unknown) => unknown) =>
    fn({ setOutput: () => {}, setMeta: () => {} }),
  ),
}));
vi.mock('./file-bytes', () => ({
  loadFileBytes: vi.fn(async () => ({
    bytes: Buffer.from('made-up picture'),
    mime: 'image/png',
    filename: 'made-up.png',
  })),
}));

import { visionIngestImageNode } from './images';

const node = { id: 'n-1', type: 'file', title: 'made-up.png', data: {} } as never;

beforeEach(() => vi.clearAllMocks());

describe('the picture read and an answer cut at its cap', () => {
  it('an empty answer cut at the cap is not a terminal read', async () => {
    h.runVisionWorker.mockResolvedValue({
      ran: true,
      text: '',
      cut: true,
      note: 'Vision answer stopped at its token cap (2000) with no text.',
      model: 'made/up-model',
    });
    const r = await visionIngestImageNode(node, 'o-1');
    expect(r).toMatchObject({ text: null, ran: false });
    expect(r.failure).toContain('token cap');
  });

  it('a real empty answer is still a terminal read', async () => {
    h.runVisionWorker.mockResolvedValue({
      ran: true,
      text: '',
      note: 'Vision worker returned no text.',
      model: 'made/up-model',
    });
    expect(await visionIngestImageNode(node, 'o-1')).toMatchObject({ text: null, ran: true });
  });

  it('asks for the least thinking', async () => {
    h.runVisionWorker.mockResolvedValue({ ran: true, text: '', note: 'x', model: 'm' });
    await visionIngestImageNode(node, 'o-1');
    expect(h.runVisionWorker).toHaveBeenCalledWith(
      expect.objectContaining({ leastThinking: true }),
    );
  });
});
