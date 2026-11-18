/**
 * Large PDFs through page windows, end to end against the parser IMAGE
 * (task 8d40932a: P1, P3, G2, G4, G5). Skipped unless LARGE_PDF_E2E_DIR
 * names a folder of made-up PDFs and PARSER_URL a parser built from this
 * tree with PARSER_TEST_PIPELINES=1 (qpdf, Tesseract and the CAD venv are in
 * the image only). The PDFs are made by scripts/large-pdf/gen_test_pdfs.py,
 * never a client file:
 *
 *   gen_test_pdfs.py scans    $DIR/scans.pdf 140          (about 80 MB)
 *   gen_test_pdfs.py pictures $DIR/pictures.pdf 520 260   (past 256 MB)
 *
 * What is pinned:
 *  - a scanned book is read in windows of at most 50 pages and 10 MB here,
 *    several of them; every page of the file is in exactly one window, in
 *    order, none lost; the first and the last page of each window, read by
 *    the local OCR inside the step, print the page number the request
 *    names on the ORIGINAL file;
 *  - a PDF past the 256 MB pdfjs opens gives its pictures window by window:
 *    500 kept of 520 found, in reading order with their true pages, so the
 *    file says "500 of 520 pictures kept"; a cap of 600 then finds the 20
 *    it did not have, and nothing is left out.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { envDynamic } from '@mantle/config';
import { PDF_MAX_BYTES, extractionOf } from '@mantle/files';
import { TEST_PIPELINES } from '@mantle/files/pipelines/pkg-test';
import { picturesByWindows, picturesLeftOutOf } from './pdf-picture-windows';
import { pagesReadOf, pdfWindows, runWindowed, stepFileOf } from './pipeline-runner';

const DIR = envDynamic('LARGE_PDF_E2E_DIR');
const LONG = 30 * 60_000;

describe.skipIf(!DIR)('large PDFs through page windows (the parser image)', () => {
  it(
    'reads a scanned book window by window: every page once, true page numbers, no page lost',
    async () => {
      const bytes = readFileSync(path.join(DIR!, 'scans.pdf'));
      const truth = readFileSync(path.join(DIR!, 'scans.truth.jsonl'), 'utf8').trim().split('\n');
      const total = truth.length;
      const window = { pages: 50, mb: 10 };
      // The windows the parser cuts: at most 50 pages and 10 MB each (a
      // single page may pass the MB), several, covering every page once.
      const spans: [number, number][] = [];
      for await (const w of pdfWindows(bytes, stepFileOf(bytes, 'pdf').sha256, window)) {
        expect(w.part, 'a window the parser could not cut').not.toBeNull();
        const part = w.part!;
        expect(part.pagesTotal).toBe(total);
        expect(part.pageTo - part.pageFrom + 1).toBeLessThanOrEqual(50);
        if (part.pageTo > part.pageFrom) {
          expect(part.bytes.length).toBeLessThanOrEqual(10 * 1024 * 1024);
        }
        spans.push([part.pageFrom, part.pageTo]);
      }
      expect(spans.length).toBeGreaterThan(2);
      expect(spans[0]![0]).toBe(1);
      expect(spans.at(-1)![1]).toBe(total);
      for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBe(spans[i - 1]![1] + 1);

      // The windowed run of the test Reader: one Pages row a page.
      const reader = TEST_PIPELINES.find((p) => p.id === 'test-window')!;
      const run = await runWindowed(
        { ...reader, needs: { ...reader.needs, window } } as never,
        bytes,
        stepFileOf(bytes, 'pdf'),
        { options: {}, kind: 'book', state: { core: true } },
      );
      expect(run.status).toBe('ok');
      expect(run.windows).toEqual({ pagesTotal: total, failed: [] });
      expect(pagesReadOf(run.windows!)).toBe(total);
      const rows = run.write!.tabs.find((t) => t.name === 'Pages')!.rows;
      expect(rows.map((r) => r[0])).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      expect(run.counts).toMatchObject({ windows: spans.length, pages: total });
      // The OCR of each window's first and last page prints its page of the
      // original file: never another page, and read on nearly every one.
      const printed = rows.filter((r) => r[2] !== null);
      for (const r of printed) expect(r[2], `page ${r[0]}`).toBe(r[0]);
      expect(printed.length).toBeGreaterThanOrEqual(Math.floor(spans.length * 2 * 0.9));
    },
    LONG,
  );

  it(
    'gives a PDF past 256 MB its pictures window by window, says what it left out, and fetches the rest at a raised cap',
    async () => {
      const bytes = readFileSync(path.join(DIR!, 'pictures.pdf'));
      expect(bytes.length).toBeGreaterThan(PDF_MAX_BYTES);
      const first = await picturesByWindows(bytes, 500, null);
      expect(first.windowsFailed).toBe(0);
      expect(first.images).toHaveLength(500);
      expect(picturesLeftOutOf(first)).toBe(20);
      // Reading order over every window, each with its page of the file
      // (four a page).
      expect(first.images.map((i) => i.ordinal)).toEqual(
        Array.from({ length: 500 }, (_, i) => i + 1),
      );
      expect(first.images.map((i) => i.location?.page)).toEqual(
        Array.from({ length: 500 }, (_, i) => Math.floor(i / 4) + 1),
      );
      const status = extractionOf({
        extract_completed_at: '2026-11-18T00:00:00.000Z',
        images: {
          kept: first.images.length,
          found: first.images.length + picturesLeftOutOf(first),
        },
      });
      expect(status.state).toBe('partial');
      expect(status.hint).toMatch(/^500 of 520 pictures kept\./);

      // A raised cap: the 20 it did not have, and nothing left out.
      const again = await picturesByWindows(bytes, 600, null);
      expect(again.images).toHaveLength(520);
      expect(picturesLeftOutOf(again)).toBe(0);
      const had = new Set(first.images.map((i) => i.sha256));
      expect(again.images.filter((i) => !had.has(i.sha256))).toHaveLength(20);
    },
    LONG,
  );
});
