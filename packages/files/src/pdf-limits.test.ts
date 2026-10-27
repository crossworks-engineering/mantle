/**
 * The pdfjs limits (pdf-open.ts, rasterize.ts) bound what one PDF can cost.
 *
 * Before them a 747 KB PDF holding one 16000x16000 image peaked at ~1.9 GB
 * in the pictures pass and ~5.2 GB in the scanned-PDF render, against an api
 * container capped at 3 GB. The fixtures here are synthetic and built in the
 * test: an all-zero image compresses to almost nothing, which is exactly what
 * makes it dangerous.
 *
 * Peak memory is read from `process.resourceUsage().maxRSS`, the process's
 * high-water mark: it only ever rises, so a rise across one call is a lower
 * bound on what that call allocated. Decoded pixels and canvases live outside
 * the V8 heap, so `heapUsed` would not see them.
 */

import { once } from 'node:events';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  assemblePdf,
  helveticaPdf,
  imagePagePdf,
  type FixtureImage,
} from './pdf-fixtures.test-helper';
import { extractPdfImages, parsePdf, pdfPageCount } from './pdf';
import { PDF_MAX_IMAGE_PIXELS } from './pdf-open';
import {
  isPdfLimitError,
  MAX_RENDER_PIXELS,
  pageRenderScale,
  rasterizePdfToPngs,
} from './rasterize';

/** An all-zero RGB image, compressed a megabyte at a time so the raw samples
 *  (768 MB at 16000x16000) never exist in this process. */
async function zeroImage(side: number): Promise<FixtureImage> {
  const deflate = zlib.createDeflate();
  const out: Buffer[] = [];
  deflate.on('data', (c: Buffer) => out.push(c));
  const ended = once(deflate, 'end');
  const chunk = Buffer.alloc(1 << 20);
  for (let left = side * side * 3; left > 0; left -= chunk.length) {
    if (!deflate.write(chunk.subarray(0, Math.min(chunk.length, left)))) {
      await once(deflate, 'drain');
    }
  }
  deflate.end();
  await ended;
  return { width: side, height: side, flate: Buffer.concat(out) };
}

/** A small, recognisable picture: each pixel's colour is a function of where
 *  it is, so a decoded copy can be checked pixel by pixel. */
function gradient(width: number, height: number): FixtureImage {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      raw[o] = x & 255;
      raw[o + 1] = y & 255;
      raw[o + 2] = (x + y) & 255;
    }
  }
  return { width, height, flate: zlib.deflateSync(raw) };
}

/** PNG width and height from the IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** MB the process high-water mark rose by while `fn` ran. */
async function peakRiseMb<T>(fn: () => Promise<T>): Promise<{ value: T; riseMb: number }> {
  const before = process.resourceUsage().maxRSS;
  const value = await fn();
  return { value, riseMb: (process.resourceUsage().maxRSS - before) / 1024 };
}

describe('pageRenderScale', () => {
  it('keeps the asked-for scale for a normal page', () => {
    expect(pageRenderScale(595, 842, 2)).toBe(2); // A4
    expect(pageRenderScale(200, 200, 2)).toBe(2);
  });

  it('lowers the scale of a big sheet to fit the canvas cap', () => {
    const scale = pageRenderScale(2384, 3370, 2); // A0
    expect(scale).not.toBeNull();
    expect(scale!).toBeLessThan(2);
    expect(Math.floor(2384 * scale!) * Math.floor(3370 * scale!)).toBeLessThanOrEqual(
      MAX_RENDER_PIXELS,
    );
  });

  it('skips a page past any real page size, and a page with no area', () => {
    expect(pageRenderScale(100_000, 100_000, 2)).toBeNull();
    expect(pageRenderScale(0, 842, 2)).toBeNull();
    expect(pageRenderScale(Number.NaN, 842, 2)).toBeNull();
    expect(pageRenderScale(Number.POSITIVE_INFINITY, 842, 2)).toBeNull();
  });
});

describe('a PDF with one huge embedded image', () => {
  it('stays bounded in the pictures pass and the render, and still reads', async () => {
    const huge = await zeroImage(16_000);
    expect(huge.width * huge.height).toBeGreaterThan(PDF_MAX_IMAGE_PIXELS);
    const pdf = imagePagePdf({ caption: 'Figure 1: huge', images: [huge] });
    expect(pdf.length).toBeLessThan(1_000_000);

    // Pictures pass: the image is dropped before decoding, not decoded then
    // refused. ~1.5 GB over the baseline before the limit.
    const pictures = await peakRiseMb(() => extractPdfImages(pdf));
    expect(pictures.value).toEqual([]);
    expect(pictures.riseMb).toBeLessThan(400);

    // Scanned-PDF render: the page still renders (blank where the image was).
    // ~4.7 GB over the baseline and a 2 s event-loop block before the limit.
    const render = await peakRiseMb(() => rasterizePdfToPngs(pdf, { maxPages: 1 }));
    expect(render.value).toHaveLength(1);
    expect(pngSize(render.value[0]!.png)).toEqual({ width: 1224, height: 1584 });
    expect(render.riseMb).toBeLessThan(400);

    // The text layer is untouched by any of it.
    expect(await parsePdf(pdf)).toContain('Figure 1: huge');
    expect(await pdfPageCount(pdf)).toBe(1);
  }, 60_000);

  it('drops only the huge image: the normal picture beside it still comes out', async () => {
    // Declared 20000x20000 with a few bytes of samples: past the limit it is
    // never decoded, so its stream contents never matter.
    const huge: FixtureImage = {
      width: 20_000,
      height: 20_000,
      flate: zlib.deflateSync(Buffer.alloc(16)),
    };
    const pdf = imagePagePdf({ caption: 'Figure 2: mixed', images: [gradient(320, 240), huge] });
    const images = await extractPdfImages(pdf);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ width: 320, height: 240, location: { page: 1 } });
    expect(await parsePdf(pdf)).toContain('Figure 2: mixed');
  });
});

describe('normal PDFs are unchanged', () => {
  it('extracts a picture pixel for pixel', async () => {
    const pdf = imagePagePdf({ caption: 'Figure 3: gradient', images: [gradient(320, 240)] });
    const [img] = await extractPdfImages(pdf);
    expect(img).toMatchObject({ width: 320, height: 240, caption: 'Figure 3: gradient' });

    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const decoded = await loadImage(img!.bytes);
    const canvas = createCanvas(320, 240);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(decoded, 0, 0);
    const px = ctx.getImageData(0, 0, 320, 240).data;
    for (const [x, y] of [
      [0, 0],
      [17, 3],
      [319, 239],
      [200, 100],
    ] as const) {
      const o = (y * 320 + x) * 4;
      expect([px[o], px[o + 1], px[o + 2], px[o + 3]]).toEqual([
        x & 255,
        y & 255,
        (x + y) & 255,
        255,
      ]);
    }
  });

  it('reads the text layer and renders a page at the asked-for scale', async () => {
    const pdf = helveticaPdf('Hello Mantle');
    expect(await parsePdf(pdf)).toContain('Hello Mantle');
    const pages = await rasterizePdfToPngs(pdf);
    expect(pages.map((p) => p.pageNumber)).toEqual([1]);
    expect(pngSize(pages[0]!.png)).toEqual({ width: 400, height: 400 });
  });

  it('renders a big sheet at a lower scale instead of a bigger canvas', async () => {
    const pdf = imagePagePdf({ pageWidth: 2384, pageHeight: 3370, images: [gradient(32, 32)] });
    const [page] = await rasterizePdfToPngs(pdf, { maxPages: 1 });
    const { width, height } = pngSize(page!.png);
    expect(width * height).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
    expect(width).toBeGreaterThan(2384); // still above scale 1
  });
});

describe('a page too large to render', () => {
  /** One text page with the given MediaBox side, in points. */
  function bigPage(side: number): Buffer {
    const stream = 'BT /F1 12 Tf 20 100 Td (big) Tj ET';
    return assemblePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${side} ${side}] ` +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]);
  }

  it('throws a PdfLimitError naming the page, without allocating its canvas', async () => {
    const { value: err, riseMb } = await peakRiseMb(() =>
      rasterizePdfToPngs(bigPage(100_000)).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(isPdfLimitError(err)).toBe(true);
    expect((err as Error).message).toMatch(/page 1 is 100000x100000 pt/);
    expect(riseMb).toBeLessThan(200);
  });

  it('still reads the text of such a page', async () => {
    expect(await parsePdf(bigPage(100_000))).toContain('big');
  });
});
