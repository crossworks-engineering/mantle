/**
 * A vision answer that used its whole token budget stopped there: said in
 * the read's sink (docs/files.md, "Read in part"), so the file shows as read
 * in part. A made-up worker and adapter; no provider, no database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The made-up answer's tokens out. */
const h = vi.hoisted(() => ({
  tokensOut: 0 as number | undefined,
  text: 'a long description',
  finishReason: undefined as string | undefined,
}));

vi.mock('@mantle/db', () => ({ bumpWorkerUsage: vi.fn(), getDefaultWorker: vi.fn() }));
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
  getVisionAdapter: () => ({
    adapterName: 'made-up',
    extract: async () => ({
      text: h.text,
      tokensOut: h.tokensOut,
      ...(h.finishReason ? { finishReason: h.finishReason } : {}),
    }),
  }),
}));
vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof import('@mantle/files')>()),
  transcodeImageForVision: async (bytes: Buffer, mimeType: string) => ({ bytes, mimeType }),
}));

import { withReadCutSink } from '@mantle/files/read-cut-sink';
import { runVisionWorker } from './attachments';

const ask = () =>
  runVisionWorker({
    ownerId: 'o-1',
    bytes: Buffer.from('made-up picture'),
    mimeType: 'image/png',
    maxTokens: 2000,
  });

describe('a vision answer cut at its token limit', () => {
  beforeEach(() => {
    h.text = 'a long description';
    h.finishReason = undefined;
  });

  it('is said once per answer that reached the limit', async () => {
    h.tokensOut = 2000;
    const { value, cuts } = await withReadCutSink(async () => {
      await ask();
      return ask();
    });
    expect(value.text).toBe('a long description');
    expect(cuts).toEqual({
      vision_answer: { what: 'answers', read: 0, total: 2, limit: 2000 },
    });
  });

  it('an answer under the limit, or with no count, says nothing', async () => {
    h.tokensOut = 1999;
    expect((await withReadCutSink(ask)).cuts).toEqual({});
    h.tokensOut = undefined;
    expect((await withReadCutSink(ask)).cuts).toEqual({});
  });

  it('an empty answer at the cap is cut, not a verdict on the picture', async () => {
    h.text = '';
    h.tokensOut = 2000;
    const atCount = await ask();
    expect(atCount).toMatchObject({ ran: true, text: '', cut: true });
    expect(atCount.note).toContain('token cap (2000)');
    // The provider's own word, with no count.
    h.tokensOut = undefined;
    h.finishReason = 'length';
    expect(await ask()).toMatchObject({ ran: true, text: '', cut: true });
  });

  it('an empty answer under the cap is a real empty read', async () => {
    h.text = '';
    h.tokensOut = 12;
    h.finishReason = 'stop';
    const r = await ask();
    expect(r).toMatchObject({ ran: true, text: '', note: 'Vision worker returned no text.' });
    expect(r.cut).toBeUndefined();
  });

  it('an answer with text is never cut, even at the cap', async () => {
    h.tokensOut = 2000;
    h.finishReason = 'length';
    expect((await ask()).cut).toBeUndefined();
  });
});
