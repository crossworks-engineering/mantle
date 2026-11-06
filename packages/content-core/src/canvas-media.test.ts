import { describe, expect, it } from 'vitest';
import { canvasAssets, canvasLoadProblems } from './canvas';
import {
  CANVAS_ASSETS_MAX,
  canvasAssetProblems,
  canvasMediaBytesMatch,
  canvasMediaMime,
  readCanvasMediaMessage,
} from './canvas-media';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const doc = (assets: string, body = '') =>
  `<!doctype html><html><head><title>t</title><meta name="canvas:assets" content="${assets}"></head><body>${body}</body></html>`;

describe('canvasAssets', () => {
  it('reads the head tag: lower case, de-duplicated, in order', () => {
    expect(canvasAssets(doc(`${B} ${A.toUpperCase()}\n${B}`)).ids).toEqual([B, A]);
  });

  it('a canvas with no tag declares nothing', () => {
    expect(canvasAssets('<html><head><title>t</title></head></html>')).toEqual({
      ids: [],
      bad: [],
      over: false,
    });
  });

  it('keeps what is not a file id apart, for the save to refuse', () => {
    const d = canvasAssets(doc(`${A} nope ../x`));
    expect(d.ids).toEqual([A]);
    expect(d.bad).toEqual(['nope', '../x']);
  });

  it('caps the list, and says it went over', () => {
    const many = Array.from(
      { length: CANVAS_ASSETS_MAX + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const d = canvasAssets(doc(many.join(' ')));
    expect(d.ids).toHaveLength(CANVAS_ASSETS_MAX);
    expect(d.over).toBe(true);
  });

  it("reads a template canvas's data fileId fields (the D5 pictures)", () => {
    const html =
      '<html><head><meta name="diagram:template" content="flow"></head><body>' +
      `<script type="application/json" id="diagram-data">{"template":"flow","nodes":[{"picture":{"fileId":"${A}"}},{"fileId":"x"}]}</script>` +
      '</body></html>';
    const d = canvasAssets(html);
    expect(d.ids).toEqual([A]);
    expect(d.bad).toEqual(['x']);
  });
});

describe('canvasAssetProblems', () => {
  it('a bad token or too many is a problem; an undeclared literal id a warning', () => {
    const html = doc(
      `${A} nope`,
      `<script>mantle.media.url('${B}');mantle.media.url("${A}")</script>`,
    );
    const r = canvasAssetProblems(html, canvasAssets(html));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("'nope'");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(B);
    expect(r.warnings[0]).not.toContain(A);
  });

  it('a clean declaration has neither', () => {
    const html = doc(A, `<script>mantle.media.url('${A}')</script>`);
    expect(canvasAssetProblems(html, canvasAssets(html))).toEqual({ problems: [], warnings: [] });
  });
});

describe('canvasLoadProblems and file URLs', () => {
  it('a file URL is refused with the way to play it instead', () => {
    for (const url of [`/api/files/files/${A}?raw=1`, `/s/tok/a/${A}`]) {
      const p = canvasLoadProblems(`<html><body><audio src="${url}"></audio></body></html>`, []);
      expect(p).toHaveLength(1);
      expect(p[0]).toContain("mantle.media.url('<file id>')");
      expect(p[0]).toContain('canvas:assets');
    }
  });
});

describe('canvasMediaMime', () => {
  it('takes mp3, ogg, png, jpeg and webp, parameters dropped; nothing else', () => {
    expect(canvasMediaMime('audio/mpeg')).toBe('audio/mpeg');
    expect(canvasMediaMime('Audio/Ogg; codecs=opus')).toBe('audio/ogg');
    expect(canvasMediaMime('image/webp')).toBe('image/webp');
    for (const t of ['image/svg+xml', 'text/html', 'application/octet-stream', '', null]) {
      expect(canvasMediaMime(t)).toBeNull();
    }
  });
});

describe('canvasMediaBytesMatch', () => {
  const b = (...parts: (string | number[])[]) =>
    new Uint8Array(
      parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
    );
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  it('takes the bytes of each type', () => {
    expect(canvasMediaBytesMatch('audio/mpeg', b('ID3', [4, 0]))).toBe(true);
    expect(canvasMediaBytesMatch('audio/mpeg', b([0xff, 0xfb, 0x90]))).toBe(true);
    // Zero padding before the first frame, as some encoders write.
    expect(canvasMediaBytesMatch('audio/mpeg', b(new Array(600).fill(0), [0xff, 0xfb]))).toBe(true);
    expect(canvasMediaBytesMatch('audio/mpeg', b(new Array(5000).fill(0), [0xff, 0xfb]))).toBe(
      false,
    );
    expect(canvasMediaBytesMatch('audio/ogg', b('OggS', [0]))).toBe(true);
    expect(canvasMediaBytesMatch('image/png', b(png, 'IHDR'))).toBe(true);
    expect(canvasMediaBytesMatch('image/jpeg; x=1', b([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(canvasMediaBytesMatch('image/webp', b('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toBe(true);
  });

  it('refuses bytes of another type, too few bytes, and a type not handed out', () => {
    expect(canvasMediaBytesMatch('image/png', b('ID3', [4, 0]))).toBe(false);
    expect(canvasMediaBytesMatch('audio/mpeg', b('%PDF-1.7'))).toBe(false);
    expect(canvasMediaBytesMatch('image/webp', b('RIFF', [1, 2, 3, 4], 'WAVE'))).toBe(false);
    expect(canvasMediaBytesMatch('image/png', b(png.slice(0, 4)))).toBe(false);
    expect(canvasMediaBytesMatch('audio/ogg', new Uint8Array())).toBe(false);
    expect(canvasMediaBytesMatch('image/svg+xml', b('<svg'))).toBe(false);
    expect(canvasMediaBytesMatch(null, b('ID3'))).toBe(false);
  });
});

describe('readCanvasMediaMessage', () => {
  it('takes a call id and a file id, lower case', () => {
    expect(readCanvasMediaMessage({ id: 3, file: A.toUpperCase() })).toEqual({
      ok: true,
      req: { id: 3, file: A },
    });
  });

  it('refuses a bad file with its call id, and drops what has no call id', () => {
    expect(readCanvasMediaMessage({ id: 4, file: '../etc' })).toEqual({ ok: false, id: 4 });
    expect(readCanvasMediaMessage({ id: 4, file: { toString: () => A } })).toEqual({
      ok: false,
      id: 4,
    });
    for (const raw of [null, [], { file: A }, { id: 0, file: A }, { id: 1.5, file: A }]) {
      expect(readCanvasMediaMessage(raw)).toEqual({ ok: false, id: null });
    }
  });
});
