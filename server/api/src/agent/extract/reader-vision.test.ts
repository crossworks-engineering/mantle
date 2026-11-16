import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ allowed: true, calls: [] as unknown[] }));
vi.mock('@mantle/db', () => ({ llmWorkAllowed: async () => h.allowed }));
vi.mock('@mantle/tracing', () => ({
  step: async (_s: unknown, fn: (h: { setMeta: () => void }) => unknown) =>
    fn({ setMeta: () => {} }),
}));
vi.mock('@mantle/runtime/agent', () => ({
  runVisionWorker: async (o: { mimeType: string; prompt?: string; maxTokens?: number }) => {
    h.calls.push(o);
    return { ran: true, text: o.prompt === 'blank?' ? '' : 'an answer', note: 'empty', model: 'm' };
  },
}));

import {
  READER_VISION_PICTURE_MAX_BYTES,
  askReaderVision,
  visionAskOf,
  visionMimeOf,
} from './reader-vision';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('x')]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const TIFF = Buffer.from('II*\0abcd');
const ask = (input: unknown, worker = 'vision') => ({ call: 'worker' as const, worker, input });
const pics = new Map([
  ['a.png', PNG],
  ['b.tif', TIFF],
]);

beforeEach(() => {
  h.allowed = true;
  h.calls.length = 0;
});

describe('the vision asks of an own Reader', () => {
  it('knows a PNG, a JPEG and a WebP by their bytes, and nothing else', () => {
    expect(visionMimeOf(PNG)).toBe('image/png');
    expect(visionMimeOf(JPG)).toBe('image/jpeg');
    expect(visionMimeOf(WEBP)).toBe('image/webp');
    expect(visionMimeOf(TIFF)).toBeNull();
    expect(visionMimeOf(Buffer.alloc(0))).toBeNull();
  });

  it('refuses another worker, a missing picture, a bad question and a picture of another type', () => {
    const why = (c: ReturnType<typeof ask>) => {
      const r = visionAskOf(c, pics);
      return 'refused' in r ? r.refused : null;
    };
    expect(why(ask({ picture: 'a.png', question: 'q' }, 'decider'))).toMatch(/vision/);
    expect(why(ask({ picture: 'a.png' }))).toMatch(/picture and a question/);
    expect(why(ask({ picture: 'a.png', question: '  ' }))).toMatch(/characters/);
    expect(why(ask({ picture: 'a.png', question: 'x'.repeat(2001) }))).toMatch(/characters/);
    expect(why(ask({ picture: 'gone.png', question: 'q' }))).toMatch(/not in the step/);
    expect(why(ask({ picture: 'b.tif', question: 'q' }))).toMatch(/PNG, JPEG or WebP/);
    const big = new Map([
      ['big.png', Buffer.concat([PNG, Buffer.alloc(READER_VISION_PICTURE_MAX_BYTES)])],
    ]);
    expect('refused' in visionAskOf(ask({ picture: 'big.png', question: 'q' }), big)).toBe(true);
    expect(why(ask({ picture: 'a.png', question: 'q' }))).toBeNull();
  });

  it('asks the vision worker with the question and the picture type, and gives its text', async () => {
    const r = await askReaderVision('o', 'n', ask({ picture: 'a.png', question: 'what?' }), pics);
    expect(r).toEqual({ ok: true, output: { text: 'an answer', model: 'm' } });
    expect(h.calls).toEqual([
      expect.objectContaining({ mimeType: 'image/png', prompt: 'what?', leastThinking: true }),
    ]);
  });

  it('no model work for the file: refused, and no call', async () => {
    h.allowed = false;
    const r = await askReaderVision('o', 'n', ask({ picture: 'a.png', question: 'what?' }), pics);
    expect(r).toMatchObject({ ok: false, error: 'refused' });
    expect(h.calls).toEqual([]);
  });

  it('a bad ask is refused before the guard and the call; no text is not_available', async () => {
    expect(
      await askReaderVision('o', 'n', ask({ picture: 'b.tif', question: 'q' }), pics),
    ).toMatchObject({
      ok: false,
      error: 'refused',
    });
    expect(h.calls).toEqual([]);
    expect(
      await askReaderVision('o', 'n', ask({ picture: 'a.png', question: 'blank?' }), pics),
    ).toMatchObject({
      ok: false,
      error: 'not_available',
    });
  });
});
