/**
 * Pictures in a decision's state: the part, its limits, its token cost and
 * the shrink by the parser (stood in). Made-up headers only: nothing is
 * decoded here, as nothing is in production.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  decisionPictureOf,
  measurePicture,
  pictureRefusal,
  pictureTokens,
  statePictures,
} from './picture';
import { requestChars, requestOverLimit, requestTokens } from './request-limits';

/** A PNG header of `w` x `h` (all a header probe reads). */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** A JPEG header of `w` x `h`: SOI, then one SOF0 segment. */
function jpg(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(b, 0);
  b.writeUInt16BE(h, 7);
  b.writeUInt16BE(w, 9);
  return b;
}

const part = (b: Buffer, mime = 'image/png') => ({
  type: 'image_url' as const,
  image_url: { url: `data:${mime};base64,${b.toString('base64')}` },
});

describe('pictureTokens and pictureRefusal', () => {
  it('a page picture costs about 5,800 tokens (counts high over the measured 5,000)', () => {
    expect(pictureTokens(1108, 1568)).toBe(5792);
  });

  it('takes a PNG or JPEG from 256 to 1,568 pixels a side', () => {
    expect(pictureRefusal({ ext: 'png', width: 1108, height: 1568, bytes: 900_000 })).toBeNull();
    expect(pictureRefusal({ ext: 'jpg', width: 1568, height: 1568, bytes: 1 })).toBeNull();
    expect(pictureRefusal({ ext: 'png', width: 1240, height: 1754, bytes: 1 })).toMatch(/over/);
    expect(pictureRefusal({ ext: 'png', width: 200, height: 1000, bytes: 1 })).toMatch(/under/);
    expect(pictureRefusal({ ext: 'webp', width: 800, height: 800, bytes: 1 })).toMatch(/PNG/);
    expect(pictureRefusal({ ext: 'png', bytes: 1 })).toMatch(/no size/);
    expect(pictureRefusal({ ext: 'png', width: 800, height: 800, bytes: 17e6 })).toMatch(/16 MiB/);
  });
});

describe('statePictures', () => {
  it('finds pictures anywhere in the state and stands each in for the text', () => {
    const state = [
      'text',
      { page: part(png(1000, 1400)), more: [part(jpg(600, 800), 'image/jpeg')] },
    ];
    const { pictures, text } = statePictures(state);
    expect(pictures.map((p) => [p.ext, p.width, p.height, p.refusal])).toEqual([
      ['png', 1000, 1400, null],
      ['jpg', 600, 800, null],
    ]);
    expect(text).toEqual(['text', { page: '[picture]', more: ['[picture]'] }]);
  });

  it('a state with no picture comes back as it is', () => {
    const state = { a: 1, b: ['x'] };
    expect(statePictures(state)).toEqual({ pictures: [], text: state });
  });

  it('an image URL that is no PNG or JPEG data URL is refused', () => {
    expect(
      measurePicture({ type: 'image_url', image_url: { url: 'https://example.invalid/p.png' } })
        .refusal,
    ).toMatch(/data URL/);
  });
});

describe('request size with pictures', () => {
  // A picture's base64 would count about 1.4 M characters at 3 a token; the
  // header here is tiny, so pad it to a page picture's size.
  const big = Buffer.concat([png(1108, 1568), Buffer.alloc(1_000_000)]);
  const q = { faithful: { type: 'noul' as const, instructions: 'x' } };

  it('counts a picture at its token cost, not its base64 length', () => {
    const state = ['transcription:\nPAGE 7', part(big)];
    const { tokens } = requestTokens(state, q);
    expect(tokens).toBeGreaterThan(5792);
    expect(tokens).toBeLessThan(5792 + 100);
    expect(requestChars(state, q)).toBeLessThan(200);
  });

  it('a picture past the limits is never sent, whatever the model limits', () => {
    const over = requestOverLimit(
      { maxQuestions: null, maxInputTokens: null, cutAt: null, source: 'profile' },
      [part(png(1240, 1754))],
      q,
    );
    expect(over?.reason).toMatch(/over 1568/);
  });

  it('the careful limits refuse a request whose picture tokens pass them', () => {
    const over = requestOverLimit(
      { maxQuestions: 16, maxInputTokens: 4_000, cutAt: 4_000, source: 'careful' },
      [part(big)],
      q,
    );
    expect(over?.estimatedTokens).toBeGreaterThan(4_000);
  });
});

describe('decisionPictureOf', () => {
  it('a PNG within the limits is the part as it is, with no shrink', async () => {
    const shrink = vi.fn();
    const got = await decisionPictureOf(png(1108, 1568), 'image/png', shrink);
    expect(shrink).not.toHaveBeenCalled();
    expect(got).toMatchObject({ width: 1108, height: 1568, tokens: 5792 });
    expect(got!.part.image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('a page picture past 1,568 pixels is shrunk by the parser to a JPEG', async () => {
    const shrink = vi.fn(async () => jpg(1109, 1568));
    const got = await decisionPictureOf(png(1240, 1754), 'image/png', shrink);
    expect(shrink).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', 1568);
    expect(got).toMatchObject({ width: 1109, height: 1568 });
    expect(got!.part.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('a WebP is made a JPEG by the parser', async () => {
    const webp = Buffer.from('RIFF0000WEBPVP8 made-up');
    const shrink = vi.fn(async () => jpg(800, 600));
    expect(await decisionPictureOf(webp, 'image/webp', shrink)).toMatchObject({ width: 800 });
  });

  it('too small a picture, nothing the parser can read, or no bytes: null', async () => {
    const shrink = vi.fn(async () => null);
    expect(await decisionPictureOf(png(200, 200), 'image/png', shrink)).toBeNull();
    expect(shrink).not.toHaveBeenCalled();
    expect(await decisionPictureOf(png(4000, 5000), 'image/png', shrink)).toBeNull();
    expect(await decisionPictureOf(Buffer.alloc(0), 'image/png', shrink)).toBeNull();
  });

  it('a shrink that still breaks the limits is not used', async () => {
    const shrink = vi.fn(async () => jpg(1568, 100));
    expect(await decisionPictureOf(png(9000, 600), 'image/png', shrink)).toBeNull();
  });
});
