/**
 * The committed-snapshot renderer (draw-png.ts): an Excalidraw-shaped SVG with
 * an inlined woff2 font comes out as a PNG of the right size with the drawing
 * on it, a region zooms, and a link to a local file draws nothing.
 *
 * The font is one the repo already ships (OFL, licence beside it), inlined at
 * test time the way exportToSvg inlines Excalifont, under a DIFFERENT CSS
 * family name so the rename path runs too.
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  DRAW_PNG_LONG_EDGE,
  cacheDrawPng,
  cachedDrawPng,
  renderDrawSvgPng,
  validRegion,
} from './draw-png';
import { sfntFamilyName, unpackFonts } from './draw-png-render';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT = readFileSync(
  path.join(here, '../../../server/web/public/fonts/library/fredoka.woff2'),
);
const tmp = mkdtempSync(path.join(tmpdir(), 'mantle-draw-png-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A 400x200 scene shaped like exportToSvg's output: fonts in a
 *  `style-fonts` block, a background rect, a stroked shape and a label. */
function scene(extra = ''): string {
  return (
    '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
    '<!-- svg-source:excalidraw --><metadata></metadata><defs><style class="style-fonts">\n' +
    `      @font-face { font-family: Excalifont; src: url(data:font/woff2;base64,${FONT.toString('base64')}); }` +
    '</style></defs>' +
    '<rect x="0" y="0" width="400" height="200" fill="#ffffff"></rect>' +
    '<g stroke-linecap="round" transform="translate(10 10) rotate(0 90 50)">' +
    '<path d="M0 0 L180 0 L180 100 L0 100 Z" stroke="#1971c2" stroke-width="2" fill="none"></path></g>' +
    '<g transform="translate(100 60) rotate(0 0 0)"><text x="0" y="0" font-family="Excalifont, Xiaolai, Segoe UI Emoji" ' +
    'font-size="28px" fill="#e03131" text-anchor="middle" style="white-space: pre;" direction="ltr" ' +
    'dominant-baseline="alphabetic">Hello</text></g>' +
    extra +
    '</svg>'
  );
}

/** The RGBA pixels of a rendered picture, decoded by drawing it 1:1 into a
 *  bare SVG of its own size with resvg (no PNG decoder dependency). */
let wasmInit: Promise<void> | null = null;
async function rgba(out: { png: Buffer; width: number; height: number }): Promise<Uint8Array> {
  const { initWasm, Resvg } = await import('@resvg/resvg-wasm');
  const require = createRequire(import.meta.url);
  wasmInit ??= initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'))).catch(
    (err: unknown) => {
      if (!/already initialized/i.test(String(err))) throw err;
    },
  );
  await wasmInit;
  const { width: w, height: h } = out;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image width="${w}" height="${h}" href="data:image/png;base64,${out.png.toString('base64')}"/></svg>`;
  return new Resvg(svg, { fitTo: { mode: 'original' } }).render().pixels;
}

function count(px: Uint8Array, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (test(px[i]!, px[i + 1]!, px[i + 2]!)) n++;
  return n;
}
const isRed = (r: number, g: number, b: number) => r > 180 && g < 120 && b < 120;
const isBlue = (r: number, g: number, b: number) => r < 80 && g > 80 && g < 150 && b > 150;
const notWhite = (r: number, g: number, b: number) => r < 245 || g < 245 || b < 245;

describe('renderDrawSvgPng', () => {
  it('draws the whole scene as a PNG with the long edge at the target size', async () => {
    const out = await renderDrawSvgPng(scene());
    expect(out.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(out.width).toBe(DRAW_PNG_LONG_EDGE);
    expect(out.height).toBe(DRAW_PNG_LONG_EDGE / 2);
    expect([out.sceneWidth, out.sceneHeight]).toEqual([400, 200]);
    const pixels = await rgba(out);
    // The blue frame and the red label are both on it.
    expect(count(pixels, isBlue)).toBeGreaterThan(5_000);
    expect(count(pixels, isRed)).toBeGreaterThan(2_000);
  });

  it('a transparent scene lands on white, not black', async () => {
    const svg = scene().replace(
      '<rect x="0" y="0" width="400" height="200" fill="#ffffff"></rect>',
      '',
    );
    const pixels = await rgba(await renderDrawSvgPng(svg));
    expect(pixels[0]).toBe(255);
    expect(pixels[3]).toBe(255);
  });

  it('a tall scene fits its height to the target', async () => {
    const tall = scene().replace(
      'viewBox="0 0 400 200" width="400" height="200"',
      'viewBox="0 0 200 400" width="200" height="400"',
    );
    const out = await renderDrawSvgPng(tall);
    expect([out.width, out.height]).toEqual([DRAW_PNG_LONG_EDGE / 2, DRAW_PNG_LONG_EDGE]);
  });

  it('a region zooms into that part of the scene at the full size', async () => {
    // The right half holds no shape and no label: nothing but white.
    const right = await renderDrawSvgPng(scene(), {
      region: { x: 0.6, y: 0, width: 0.4, height: 1 },
    });
    expect([right.width, right.height]).toEqual([1600, DRAW_PNG_LONG_EDGE]);
    expect(count(await rgba(right), notWhite)).toBe(0);
    // The left half holds both.
    const left = await renderDrawSvgPng(scene(), {
      region: { x: 0, y: 0, width: 0.5, height: 1 },
    });
    expect(count(await rgba(left), isRed)).toBeGreaterThan(5_000);
  });

  it('never reads a local file through an image link', async () => {
    // A red picture on disk, linked by bare path: resvg would load it.
    const red = await renderDrawSvgPng(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>',
      { longEdge: 50 },
    );
    const file = path.join(tmp, 'red.png');
    writeFileSync(file, red.png);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100" width="100" height="100">' +
      `<image href="${file}" width="100" height="100"/><image xlink:href='${file}' width="100" height="100"/></svg>`;
    const out = await renderDrawSvgPng(svg, { longEdge: 100 });
    expect(count(await rgba(out), isRed)).toBe(0);
    // The same picture inlined is drawn: the blanking is of links, not images.
    const inline = svg.replaceAll(file, `data:image/png;base64,${red.png.toString('base64')}`);
    const shown = await renderDrawSvgPng(inline, { longEdge: 100 });
    expect(count(await rgba(shown), isRed)).toBeGreaterThan(5_000);
  });

  it('refuses a snapshot with no size', async () => {
    await expect(
      renderDrawSvgPng('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
    ).rejects.toThrow(/no usable size/);
  });
});

describe('fonts', () => {
  it('reads the family name a font file carries', async () => {
    const { decompress } = await import('wawoff2');
    expect(sfntFamilyName(await decompress(FONT))).toBe('Fredoka');
    expect(sfntFamilyName(new Uint8Array(8))).toBeNull();
  });

  it('refuses a font whose header says it unpacks too big, before unpacking', async () => {
    const huge = Buffer.from(FONT);
    huge.writeUInt32BE(50_000_000, 16); // woff2 totalSfntSize
    expect(await unpackFonts([{ family: 'X', base64: huge.toString('base64') }])).toEqual([]);
    const ok = await unpackFonts([{ family: 'X', base64: FONT.toString('base64') }]);
    expect(ok).toHaveLength(1);
  });
});

describe('the renderer itself cannot read the disk', () => {
  it('draws nothing for a file path even when handed an unsanitized document', async () => {
    const { renderJob } = await import('./draw-png-render');
    const red = await renderDrawSvgPng(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>',
      { longEdge: 50 },
    );
    const file = path.join(tmp, 'red-direct.png');
    writeFileSync(file, red.png);
    const require = createRequire(import.meta.url);
    const wasm = await WebAssembly.compile(
      readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')),
    );
    const out = await renderJob(
      {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><image href="${file}" width="100" height="100"/></svg>`,
        fonts: [],
        fallbackFont: new Uint8Array(0),
        longEdge: 100,
        landscape: true,
      },
      wasm,
    );
    const png = { png: Buffer.from(out.png), width: out.width, height: out.height };
    expect(count(await rgba(png), isRed)).toBe(0);
  });
});

describe('render limits', () => {
  it('stops a render past its deadline', async () => {
    await expect(renderDrawSvgPng(scene(), { timeoutMs: 1 })).rejects.toThrow(/longer than/);
  });

  it('refuses at once when the queue is full, instead of queueing without bound', async () => {
    const runs = Array.from({ length: 12 }, () =>
      renderDrawSvgPng(scene(), { longEdge: 200 }).then(
        () => 'ok',
        (e: Error) => e.message,
      ),
    );
    const results = await Promise.all(runs);
    expect(results.filter((r) => /busy/.test(r)).length).toBeGreaterThan(0);
    expect(results.filter((r) => r === 'ok').length).toBeGreaterThanOrEqual(2);
  });
});

describe('validRegion', () => {
  it('takes fractions inside the scene only', () => {
    expect(validRegion({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(validRegion({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 })).toBe(true);
    expect(validRegion({ x: 0.6, y: 0, width: 0.5, height: 1 })).toBe(false);
    expect(validRegion({ x: 0, y: 0, width: 0, height: 1 })).toBe(false);
    expect(validRegion({ x: -0.1, y: 0, width: 0.5, height: 1 })).toBe(false);
    expect(validRegion({ x: Number.NaN, y: 0, width: 0.5, height: 1 })).toBe(false);
  });
});

describe('cache', () => {
  it('returns what was stored under the key, and nothing for another key', () => {
    const png = {
      png: Buffer.from('x'),
      width: 1,
      height: 1,
      sceneWidth: 1,
      sceneHeight: 1,
    };
    cacheDrawPng('k1', png);
    expect(cachedDrawPng('k1')).toBe(png);
    expect(cachedDrawPng('k2')).toBeNull();
  });
});
