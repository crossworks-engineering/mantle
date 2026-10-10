/**
 * Audit H1 of the drawing PNG, as a regression test that runs against any
 * renderer behind `renderDrawSvgPng` (it decodes the PNG with zlib alone and
 * imports nothing else of the package): a snapshot that links a file on disk
 * in a way a namespace-aware parser resolves but a text search does not
 * (another prefix bound to the xlink namespace, a prefixed SVG element,
 * xml:base) must draw none of that file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { renderDrawSvgPng } from './draw-png';

const tmp = mkdtempSync(path.join(tmpdir(), 'mantle-draw-png-audit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function count(px: Uint8Array, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (test(px[i]!, px[i + 1]!, px[i + 2]!)) n++;
  return n;
}
const isRed = (r: number, g: number, b: number) => r > 180 && g < 120 && b < 120;

/** RGBA pixels of an 8-bit RGBA, non-interlaced PNG (what resvg writes),
 *  decoded with zlib alone, so this block runs against any renderer. */
function decodePng(png: Buffer): { pixels: Uint8Array; width: number } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred =
        f === 0
          ? 0
          : f === 1
            ? a
            : f === 2
              ? b
              : f === 3
                ? (a + b) >> 1
                : pa <= pb && pa <= pc
                  ? a
                  : pb <= pc
                    ? b
                    : c;
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { pixels: out, width };
}

describe('audit H1: a link the parser resolves but a text search does not', () => {
  it('draws nothing for a file on disk linked under another xlink prefix or a prefixed element', async () => {
    const red = await renderDrawSvgPng(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="#ff0000"/></svg>',
      { longEdge: 50 },
    );
    // The decoder sees red where there is red (a positive control).
    expect(count(decodePng(red.png).pixels, isRed)).toBeGreaterThan(2_000);
    const file = path.join(tmp, 'red-h1.png');
    writeFileSync(file, red.png);
    const open =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">';
    for (const body of [
      `<image xmlns:q="http://www.w3.org/1999/xlink" q:href="${file}" width="100" height="100"/>`,
      `<p:image xmlns:p="http://www.w3.org/2000/svg" href="${file}" width="100" height="100"/>`,
      `<g xml:base="${path.dirname(file)}/"><image href="red-h1.png" width="100" height="100"/></g>`,
    ]) {
      const out = await renderDrawSvgPng(`${open}${body}</svg>`, { longEdge: 100 });
      expect(count(decodePng(out.png).pixels, isRed), body).toBe(0);
    }
  });
});
