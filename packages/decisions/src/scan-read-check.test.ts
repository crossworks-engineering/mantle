/**
 * The use `scan_read_check`: one `noul` with the page picture and the Scan
 * reader's text; shadow is never used; live passes at the threshold. decide()
 * and the parser's shrink are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ use: string; state: unknown; questions: unknown }>,
  outcome: null as null | Record<string, unknown>,
}));

vi.mock('./decide', () => ({
  decide: vi.fn(async (input: { use: string; state: unknown; questions: unknown }) => {
    h.calls.push(input);
    return h.outcome;
  }),
}));

import {
  checkScanRead,
  SCAN_READ_CHECK_MAX_CHARS,
  SCAN_READ_CHECK_QUESTIONS,
  SCAN_READ_CHECK_THRESHOLD,
} from './scan-read-check';

function png(w: number, hgt: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(hgt, 20);
  return b;
}

const outcome = (mode: 'shadow' | 'live', p: number, threshold?: number) => ({
  answers: { faithful: { type: 'noul', probability: p } },
  mode,
  use: { enabled: true, mode, threshold, deferBelow: 0.6, actAloneAt: 0.9 },
  model: 'typesafe/jev-1.14',
  cached: false,
  ms: 900,
});

const page = { picture: png(1108, 1568), mimeType: 'image/png', text: 'PAGE 7\nA | B' };

beforeEach(() => {
  h.calls = [];
  h.outcome = null;
});

describe('checkScanRead', () => {
  it('asks one noul with the text and the page picture in the state', async () => {
    h.outcome = outcome('shadow', 0.91);
    await checkScanRead('o1', page);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.use).toBe('scan_read_check');
    expect(call.questions).toBe(SCAN_READ_CHECK_QUESTIONS);
    const [text, picture] = call.state as [string, { type: string; image_url: { url: string } }];
    expect(text).toBe('transcription:\nPAGE 7\nA | B');
    expect(picture.type).toBe('image_url');
    expect(picture.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('in shadow the answer is logged and never used', async () => {
    h.outcome = outcome('shadow', 0.12);
    expect(await checkScanRead('o1', page)).toMatchObject({
      faithful: 0.12,
      mode: 'shadow',
      used: false,
      passes: false,
      threshold: SCAN_READ_CHECK_THRESHOLD,
    });
  });

  it('live, the read passes at the threshold (the use may set its own)', async () => {
    h.outcome = outcome('live', 0.5);
    expect(await checkScanRead('o1', page)).toMatchObject({ used: true, passes: true });
    h.outcome = outcome('live', 0.49);
    expect(await checkScanRead('o1', page)).toMatchObject({ used: true, passes: false });
    h.outcome = outcome('live', 0.6, 0.7);
    expect(await checkScanRead('o1', page)).toMatchObject({ passes: false, threshold: 0.7 });
  });

  it('no decision (use off, no decider, a failure): null, the caller keeps its rule', async () => {
    h.outcome = null;
    expect(await checkScanRead('o1', page)).toBeNull();
  });

  it('no text, a text past the cap, or a picture Jev cannot read: no call', async () => {
    h.outcome = outcome('live', 0.9);
    expect(await checkScanRead('o1', { ...page, text: '  ' })).toBeNull();
    expect(
      await checkScanRead('o1', { ...page, text: 'x'.repeat(SCAN_READ_CHECK_MAX_CHARS + 1) }),
    ).toBeNull();
    const noShrink = vi.fn(async () => null);
    expect(await checkScanRead('o1', { ...page, picture: png(100, 100) }, noShrink)).toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it('a page picture past 1,568 pixels is shrunk first', async () => {
    h.outcome = outcome('shadow', 0.8);
    const shrink = vi.fn(async () => png(1109, 1568));
    await checkScanRead('o1', { ...page, picture: png(1240, 1754) }, shrink);
    expect(shrink).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', 1568);
    expect(h.calls).toHaveLength(1);
  });
});
