/**
 * The pictures pass reads a PDF one page at a time (`extractPdfImages` in
 * pdf.ts): pdfjs keeps a page's decoded images until the page is cleaned up,
 * and the pass used to hold every page until the document closed, so twenty
 * pages of 3000x3000 photos cost about 2.4 GB at once.
 *
 * Its own file, and the photo test first in it: the peak is read from
 * `process.resourceUsage().maxRSS`, the process high-water mark, which only
 * ever rises, so anything heavier earlier in the same process would hide it.
 */

import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { imagePagesPdf, type FixtureImage } from './pdf-fixtures.test-helper';
import { extractPdfImages } from './pdf';

/** A 3000x3000 RGB photo-sized image (27 MB decoded). All zero, so the
 *  fixture is small; pdfjs decodes it at full size all the same. */
function photo(): FixtureImage {
  const side = 3000;
  return { width: side, height: side, flate: zlib.deflateSync(Buffer.alloc(side * side * 3)) };
}

/** A small picture whose pixels depend on `seed`, so no two seeds dedupe
 *  and every one passes the gate. */
function figure(seed: number): FixtureImage {
  const width = 320;
  const height = 240;
  const raw = Buffer.alloc(width * height * 3);
  // Noise from a seeded generator: it does not compress, so the PNG clears
  // the gate's byte floor.
  let x = (seed + 1) * 2654435761;
  for (let i = 0; i < raw.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    raw[i] = x >>> 24;
  }
  return { width, height, flate: zlib.deflateSync(raw) };
}

/** MB the process high-water mark rose by while `fn` ran, and how long it took. */
async function measure<T>(fn: () => Promise<T>): Promise<{ value: T; riseMb: number; ms: number }> {
  const before = process.resourceUsage().maxRSS;
  const started = performance.now();
  const value = await fn();
  return {
    value,
    riseMb: (process.resourceUsage().maxRSS - before) / 1024,
    ms: performance.now() - started,
  };
}

describe('the pictures pass, page by page', () => {
  it('reads a 20-page PDF of photos with one page of pixels alive at a time', async () => {
    // Two photos a page, each its own object (one shared object would be
    // cached document-wide by pdfjs, which is a different case), so the
    // document is not scan-shaped and every image is fetched and encoded.
    const pages = 20;
    const one = photo();
    const pdf = imagePagesPdf({
      images: Array.from({ length: pages * 2 }, () => one),
      pages: Array.from({ length: pages }, (_, p) => ({ draw: [p * 2, p * 2 + 1] })),
    });
    // All forty encode to the same PNG, so the gate keeps one and the pass
    // walks every page rather than stopping at the cap.
    const run = await measure(() => extractPdfImages(pdf, { maxImages: 1000 }));
    console.info(
      `[pdf-pages] 20 pages x 2 photos: +${Math.round(run.riseMb)} MB, ${Math.round(run.ms)} ms`,
    );
    expect(run.value).toHaveLength(pages * 2);
    expect(run.value.map((i) => i.location?.page)).toEqual(
      Array.from({ length: pages * 2 }, (_, i) => Math.floor(i / 2) + 1),
    );
    // One page is two decoded photos (2 x 27 MB) plus their RGBA copies and
    // canvases while encoding; twenty pages at once was ~2.4 GB.
    expect(run.riseMb).toBeLessThan(500);
    // The memory bound is the guard; the time bound only catches a pass gone
    // badly slow (a shared CI runner took 31 to 33 s on good runs).
    expect(run.ms).toBeLessThan(45_000);
  }, 60_000);

  it('reads a 40-page scan-shaped PDF bounded, and returns nothing for it', async () => {
    const pages = 40;
    const one = photo();
    const pdf = imagePagesPdf({
      images: Array.from({ length: pages }, () => one),
      pages: Array.from({ length: pages }, (_, p) => ({ draw: [p] })),
    });
    const run = await measure(() => extractPdfImages(pdf));
    console.info(
      `[pdf-pages] 40-page scan: +${Math.round(run.riseMb)} MB, ${Math.round(run.ms)} ms`,
    );
    expect(run.value).toEqual([]);
    expect(run.riseMb).toBeLessThan(500);
    expect(run.ms).toBeLessThan(45_000);
  }, 60_000);

  it('stops once the cap holds enough real pictures', async () => {
    const pdf = imagePagesPdf({
      images: Array.from({ length: 80 }, (_, i) => figure(i)),
      pages: Array.from({ length: 40 }, (_, p) => ({ draw: [p * 2, p * 2 + 1] })),
    });
    const images = await extractPdfImages(pdf, { maxImages: 3 });
    expect(images.map((i) => i.location?.page)).toEqual([1, 1, 2]);
  });

  it('fetches an image shared across pages from the document-wide store, without stalling', async () => {
    // One logo object drawn on every page beside that page's own figure.
    // pdfjs caches such an image document-wide under a `g_` id; asking the
    // page's own store for it waited out the 15 s timeout on every page.
    const pages = 6;
    const pdf = imagePagesPdf({
      images: [figure(999), ...Array.from({ length: pages }, (_, i) => figure(i))],
      pages: Array.from({ length: pages }, (_, p) => ({ draw: [0, p + 1] })),
    });
    const run = await measure(() => extractPdfImages(pdf, { maxImages: 1000 }));
    expect(run.value).toHaveLength(pages * 2);
    expect(run.ms).toBeLessThan(10_000);
  }, 60_000);
});
