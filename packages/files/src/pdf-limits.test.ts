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
import { PDFParse } from 'pdf-parse';
import {
  assemblePdf,
  helveticaPdf,
  imagePagePdf,
  imagePagesPdf,
  type FixtureImage,
} from './pdf-fixtures.test-helper';
import { extractPdfImages, parsePdf, pdfPageCount } from './pdf';
import { countOversizeImages, PDF_MAX_BYTES, PDF_MAX_IMAGE_PIXELS, withPdf } from './pdf-open';
import {
  declaresOversizeImage,
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

/** Declared past the cap with a few bytes of samples: pdfjs drops it before
 *  decoding, so its stream contents never matter. */
const OVERSIZE: FixtureImage = {
  width: 10_000,
  height: 10_000,
  flate: zlib.deflateSync(Buffer.alloc(16)),
};

describe('a page whose only content is an image over the cap', () => {
  it('is too large, not a blank scan: one such page throws PdfLimitError', async () => {
    expect(OVERSIZE.width * OVERSIZE.height).toBeGreaterThan(PDF_MAX_IMAGE_PIXELS);
    const pdf = imagePagesPdf({ images: [OVERSIZE], pages: [{ draw: [0], caption: null }] });
    const err = await rasterizePdfToPngs(pdf).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPdfLimitError(err)).toBe(true);
    expect((err as Error).message).toMatch(/page 1 draws nothing once an embedded image over/);
  });

  it('skips only that page: the normal scan page beside it still renders', async () => {
    const pdf = imagePagesPdf({
      images: [gradient(320, 240), OVERSIZE],
      pages: [
        { draw: [0], caption: null },
        { draw: [1], caption: null },
      ],
    });
    const pages = await rasterizePdfToPngs(pdf);
    expect(pages.map((p) => p.pageNumber)).toEqual([1]);
  });

  it('finds the declared size in the raw bytes, and only a direct one', () => {
    const one = (img: FixtureImage) =>
      imagePagesPdf({ images: [img], pages: [{ draw: [0], caption: null }] });
    expect(declaresOversizeImage(one(OVERSIZE))).toBe(true);
    expect(declaresOversizeImage(one(gradient(320, 240)))).toBe(false);
    expect(declaresOversizeImage(helveticaPdf())).toBe(false);
    // An indirect size (here the width) is not followed.
    const indirect = assemblePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [] /Count 0 >>',
      [
        '<< /Type /XObject /Subtype /Image /Width 4 0 R /Height 100000 /BitsPerComponent 8 /Length 1 >>',
        Buffer.alloc(1),
      ],
      '100000',
    ]);
    expect(declaresOversizeImage(indirect)).toBe(false);
  });

  it('takes a lower threshold, and counts', () => {
    const mid: FixtureImage = { ...OVERSIZE, width: 6_000, height: 6_000 };
    const pdf = imagePagesPdf({
      images: [mid, OVERSIZE, gradient(32, 32)],
      pages: [{ draw: [0, 1, 2], caption: null }],
    });
    expect(countOversizeImages(pdf, PDF_MAX_IMAGE_PIXELS)).toBe(1);
    expect(countOversizeImages(pdf, 30_000_000)).toBe(2);
    expect(countOversizeImages(pdf, 30_000_000, 1)).toBe(1);
    const onlyMid = imagePagesPdf({ images: [mid], pages: [{ draw: [0], caption: null }] });
    expect(declaresOversizeImage(onlyMid)).toBe(false);
    expect(declaresOversizeImage(onlyMid, 30_000_000)).toBe(true);
  });

  it("does not count an image's soft mask as an image of its own", () => {
    // One big transparent photo: the photo (object 3) and its alpha, an
    // image of the same size that only the photo's /SMask names (object 4).
    // Counted twice, a brochure with one such photo read as a scan.
    const pdf = assemblePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [] /Count 0 >>',
      [
        '<< /Type /XObject /Subtype /Image /Width 6000 /Height 6000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 4 0 R /Length 1 >>',
        Buffer.alloc(1),
      ],
      [
        '<< /Type /XObject /Subtype /Image /Width 6000 /Height 6000 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>',
        Buffer.alloc(1),
      ],
    ]);
    expect(countOversizeImages(pdf, 30_000_000)).toBe(1);
  });
});

describe('the pictures pass and a scan page over its own cap', () => {
  /** 36 M pixels: over the pictures pass's 30 M cap, under the render's
   *  75 M, so only the pictures pass drops it. Never decoded there, so its
   *  stream contents never matter. */
  const BIG_SCAN_PAGE: FixtureImage = {
    width: 6_000,
    height: 6_000,
    flate: zlib.deflateSync(Buffer.alloc(16)),
  };

  it('still sees a scan when one page holds an image pdfjs drops', async () => {
    // Four scan pages, the third one a 6000x6000 image: dropped from its
    // operator list, it read as a page with no image, broke the scan shape
    // and the other three pages came back as figures (three vision calls).
    const pdf = imagePagesPdf({
      images: [gradient(320, 240), gradient(321, 240), BIG_SCAN_PAGE, gradient(322, 240)],
      pages: [0, 1, 2, 3].map((i) => ({ draw: [i], caption: null })),
    });
    expect(await extractPdfImages(pdf)).toEqual([]);
  });

  it('allows one image-less page per over-cap image, no more', async () => {
    // Text pages and figures plus one big photo: the second text page breaks
    // the shape, and every figure still comes out.
    const pdf = imagePagesPdf({
      images: [gradient(320, 240), BIG_SCAN_PAGE, gradient(321, 240)],
      pages: [
        { draw: [0], caption: 'Figure 1: first' },
        { draw: [], caption: 'Text only' },
        { draw: [], caption: 'More text' },
        { draw: [1], caption: 'Figure 2: the big photo' },
        { draw: [2], caption: 'Figure 3: last' },
      ],
    });
    const images = await extractPdfImages(pdf);
    expect(images.map((i) => i.location)).toEqual([{ page: 1 }, { page: 5 }]);
  });
});

describe('the size limit', () => {
  it(`refuses a PDF over ${PDF_MAX_BYTES / (1024 * 1024)} MB before pdfjs sees it`, async () => {
    // Zero-filled, so the pages are never touched and cost no memory.
    const big = Buffer.alloc(PDF_MAX_BYTES + 1);
    const err = await withPdf(big, {}, async () => 'opened').catch((e: unknown) => e);
    expect(isPdfLimitError(err)).toBe(true);
    expect(isPdfLimitError(await rasterizePdfToPngs(big).catch((e: unknown) => e))).toBe(true);
    expect(isPdfLimitError(await parsePdf(big).catch((e: unknown) => e))).toBe(true);
    expect(await pdfPageCount(big)).toBeNull();
  });
});

describe('the passes side by side', () => {
  // One job per process in the parser: no process-wide decode slot any more
  // (the container's memory limit is the bound). Two passes on one document
  // in one process still both read.
  it('reads the pictures and renders the pages at once', async () => {
    const pdf = imagePagePdf({ caption: 'Figure 9: both', images: [gradient(320, 240)] });
    const [images, pages] = await Promise.all([extractPdfImages(pdf), rasterizePdfToPngs(pdf)]);
    expect(images).toHaveLength(1);
    expect(pages).toHaveLength(1);
    expect(await parsePdf(pdf)).toContain('Figure 9');
    expect(await pdfPageCount(pdf)).toBe(1);
  });
});

describe('the text layer is read exactly as pdf-parse reads it', () => {
  it('matches pdf-parse opening the document itself', async () => {
    const pdf = imagePagesPdf({
      images: [gradient(32, 32)],
      pages: [
        { draw: [0], caption: 'Figure 1: first page' },
        { draw: [], caption: 'Second page, no picture' },
        { draw: [0], caption: 'Third (and last) page' },
      ],
    });
    const parser = new PDFParse({ data: new Uint8Array(pdf) });
    const direct = (await parser.getText()).text.trim();
    // pdf-parse's own destroy() calls a doc.destroy() pdfjs 6 no longer has;
    // tear its loading task down by hand.
    await (
      parser as unknown as { doc: { loadingTask: { destroy(): Promise<void> } } }
    ).doc.loadingTask.destroy();
    expect(direct).toContain('Third (and last) page');
    expect(await parsePdf(pdf)).toBe(direct);
  });
});
