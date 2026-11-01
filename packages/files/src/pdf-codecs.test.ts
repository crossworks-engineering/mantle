/**
 * A scan's image draws in every codec a scan comes in. JPX, CCITT and JBIG2 are
 * decoded by WebAssembly modules pdfjs loads from the directory `wasmUrl` names
 * (pdf-open.ts). Open a document without it and pdfjs drops the image with no
 * error: the page renders white, OCR reads nothing, and the extractor files
 * the document as a blank scan. So the checks here are on the pixels. A page
 * that merely rendered proves nothing.
 *
 * The image is black on the left and white on the right (the fixture's
 * `scanSampleIsBlack`), so a page drawn inverted fails too. `flate` needs no
 * decoder module: it is the control that the check itself can pass.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { extractPdfImages } from './pdf';
import { scanPdf, SCAN_SIZE, type ScanCodec } from './pdf-fixtures.test-helper';
import { rasterizePdfToPngs } from './rasterize';

/** A pixel is dark when all three channels are below the middle. */
async function darkShares(png: Buffer): Promise<{ left: number; right: number; width: number }> {
  const image = await loadImage(png);
  const { width, height } = image;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, width, height);
  // Clear of the edges where black meets stripes (a third of the way in) and
  // stripes meet white (two thirds of the way in).
  const leftEnd = Math.floor(width * 0.3);
  const rightStart = Math.ceil(width * 0.7);
  let left = 0;
  let right = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (data[o]! >= 128 || data[o + 1]! >= 128 || data[o + 2]! >= 128) continue;
      if (x < leftEnd) left++;
      if (x >= rightStart) right++;
    }
  }
  return {
    left: left / (leftEnd * height),
    right: right / ((width - rightStart) * height),
    width,
  };
}

const CODECS: ScanCodec[] = ['flate', 'jpx', 'ccitt', 'jbig2'];

describe('scan images draw in every codec', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(CODECS)('renders a %s scan with its dark pixels where the image has them', async (c) => {
    const [page] = await rasterizePdfToPngs(scanPdf(c), { maxPages: 1 });
    const { left, right, width } = await darkShares(page!.png);
    expect(width).toBe(SCAN_SIZE.width * 2);
    expect(left).toBeGreaterThan(0.95);
    expect(right).toBeLessThan(0.02);
  });

  it.each(CODECS)('reads the %s decoder from disk, with no network', async (c) => {
    // The parser has no route out. pdfjs reads through `fetch` when it is told
    // to fetch in its worker, which on Node it must not be.
    const fetch = vi.fn(() => Promise.reject(new Error('no route out')));
    vi.stubGlobal('fetch', fetch);
    const [page] = await rasterizePdfToPngs(scanPdf(c), { maxPages: 1 });
    expect((await darkShares(page!.png)).left).toBeGreaterThan(0.95);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hands a JPX picture to the pictures pass', async () => {
    // One page, so not read as a scan. The 1-bit codecs are not tried here:
    // the pass leaves bilevel images to OCR on purpose (`toPngBytes`).
    const [picture, ...rest] = await extractPdfImages(scanPdf('jpx'));
    expect(rest).toEqual([]);
    expect(picture).toMatchObject({ width: SCAN_SIZE.width, height: SCAN_SIZE.height });
    expect((await darkShares(picture!.bytes)).left).toBeGreaterThan(0.95);
  });
});
