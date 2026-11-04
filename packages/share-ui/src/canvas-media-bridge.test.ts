import { describe, expect, it } from 'vitest';
import { CANVAS_MEDIA_MAX_BYTES, CANVAS_MEDIA_NO_ACCESS } from '@mantle/content-core/canvas-media';
import { fetchCanvasMedia, ownerCanvasMediaSource, readTicketAssets } from './canvas-media-bridge';

const A = '11111111-1111-4111-8111-111111111111';

describe('ownerCanvasMediaSource', () => {
  it("is the brain's file route beside the canvas API, relative or absolute", () => {
    expect(ownerCanvasMediaSource(`/api/presents/${A}`)!(A)).toBe(`/api/files/files/${A}?raw=1`);
    expect(ownerCanvasMediaSource(`https://brain.example/api/presents/${A}`)!(A)).toBe(
      `https://brain.example/api/files/files/${A}?raw=1`,
    );
  });

  it('a base of another shape (an open link) has none', () => {
    expect(ownerCanvasMediaSource('/s/tok/canvas')).toBeNull();
  });
});

describe('readTicketAssets', () => {
  it('keeps uuids only, lower case', () => {
    expect([...readTicketAssets([A.toUpperCase(), 'x', 7, null])]).toEqual([A]);
    expect(readTicketAssets('nope').size).toBe(0);
  });
});

describe('fetchCanvasMedia', () => {
  const answer = (res: Response) => async () => res;

  it('hands over the bytes and their type', async () => {
    const r = await fetchCanvasMedia(
      answer(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }),
      ),
      'u',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mime).toBe('audio/mpeg');
      expect([...new Uint8Array(r.bytes)]).toEqual([1, 2, 3]);
    }
  });

  it('any refusal of the route is the one "no access"', async () => {
    for (const status of [401, 403, 404, 500]) {
      const r = await fetchCanvasMedia(answer(new Response('x', { status })), 'u');
      expect(r).toEqual({ ok: false, error: CANVAS_MEDIA_NO_ACCESS });
    }
  });

  it('refuses a type outside the list (SVG, HTML, anything sniffable)', async () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream']) {
      const r = await fetchCanvasMedia(
        answer(new Response('<svg/>', { headers: { 'content-type': type } })),
        'u',
      );
      expect(r.ok).toBe(false);
    }
  });

  it('refuses a file over the cap, by its length or as it streams', async () => {
    const big = await fetchCanvasMedia(
      answer(
        new Response('x', {
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': String(CANVAS_MEDIA_MAX_BYTES + 1),
          },
        }),
      ),
      'u',
    );
    expect(big.ok).toBe(false);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(CANVAS_MEDIA_MAX_BYTES));
        c.enqueue(new Uint8Array(1));
        c.close();
      },
    });
    const streamed = await fetchCanvasMedia(
      answer(new Response(stream, { headers: { 'content-type': 'audio/mpeg' } })),
      'u',
    );
    expect(streamed.ok).toBe(false);
  });

  it('a failed fetch is said, never thrown', async () => {
    const r = await fetchCanvasMedia(async () => {
      throw new Error('down');
    }, 'u');
    expect(r).toEqual({ ok: false, error: 'the file could not be reached' });
  });
});
