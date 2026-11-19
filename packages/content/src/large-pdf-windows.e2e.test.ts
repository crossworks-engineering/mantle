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
 *   gen_test_pdfs.py finish   $DIR                        (the finish set)
 *
 * What is pinned:
 *  - a scanned book is read in windows of at most 50 pages and 10 MB here,
 *    several of them; every page of the file is in exactly one window, in
 *    order, none lost; the first and the last page of each window, read by
 *    the local OCR inside the step, print the page number the request
 *    names on the ORIGINAL file;
 *  - the scanned book read with a window stage (a real read) and stopped
 *    before its last window reads on from that window, and gives the rows,
 *    text and counts of the read in one go (./window-stage.ts; that the
 *    kept windows are not read again is pinned in window-stage.test.ts);
 *  - a PDF past the 256 MB pdfjs opens gives its pictures window by window:
 *    500 kept of 520 found, in reading order with their true pages, so the
 *    file says "500 of 520 pictures kept"; a cap of 600 then finds the 20
 *    it did not have, and nothing is left out.
 *  - the large-PDF finish (2026-11-19): a 1-page and a 7-page typed PDF and
 *    a 7-page scan are books, every page read (text layer, local OCR), the
 *    Tables tab, no vision for a typed page; a scanned book's reader writes
 *    no page picture, and the Agent's step draws each marked page (G1: the
 *    Agent owns the page pictures), its scans painted over the page; a
 *    typed PDF of over 1,000,000 characters keeps every page whole; every
 *    picture of the 520 is kept, a small job size only paces the read.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { envDynamic } from '@mantle/config';
import {
  BUILTIN_PIPELINES,
  IMAGE_PAGE_COVER,
  MAX_EMBEDDED_IMAGES_CEILING,
  PDF_MAX_BYTES,
  effectiveOptions,
  extractionOf,
  fileDbsDir,
  parserImages,
} from '@mantle/files';
import { TEST_PIPELINES } from '@mantle/files/pipelines/pkg-test';
import { picturesByWindows, picturesLeftOutOf } from './pdf-picture-windows';
import { pagesText } from './page-passages';
import {
  agentStep,
  pagesReadOf,
  pdfWindows,
  pdfWindowsAt,
  runPackaged,
  runWindowed,
  stepFileOf,
} from './pipeline-runner';
import { windowRunKey } from './window-stage';

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

      // The same read with a window stage: every window kept as it ends.
      // Then the last one is taken out, as a run stopped before it, and a
      // run again reads that window only and gives the read in one go.
      const root = mkdtempSync(path.join(tmpdir(), 'mantle-e2e-stage-'));
      vi.stubEnv('MANTLE_FILES_ROOT', root);
      try {
        const file = stepFileOf(bytes, 'pdf');
        const stage = {
          fileId: '11111111-1111-4111-8111-111111111111',
          sha256: file.sha256,
          runKey: windowRunKey(`test-window:${file.sha256}`, { kind: 'book' }, window),
        };
        const pipeline = { ...reader, needs: { ...reader.needs, window } } as never;
        const opts = { options: {}, kind: 'book', state: { core: true }, stage };
        const kept = await runWindowed(pipeline, bytes, file, opts);
        expect(kept.write).toEqual(run.write);
        const files = readdirSync(fileDbsDir()).filter((n) => n.includes('.stage-'));
        expect(files).toHaveLength(spans.length);
        const lastFrom = spans.at(-1)![0];
        rmSync(
          path.join(
            fileDbsDir(),
            files.find((n) => n.endsWith(`-${lastFrom}.json`))!,
          ),
        );
        const resumed = await runWindowed(pipeline, bytes, file, opts);
        expect(resumed.write).toEqual(run.write);
        expect(resumed.counts).toEqual(run.counts);
        expect(resumed.windows).toEqual(run.windows);
        // The window read again is kept again.
        expect(readdirSync(fileDbsDir()).filter((n) => n.includes('.stage-'))).toHaveLength(
          spans.length,
        );
      } finally {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    },
    LONG,
  );

  // The large-PDF finish (2026-11-19): every office PDF takes the book
  // reader, whatever its size. The set of `gen_test_pdfs.py finish $DIR`.
  const ROUTER = BUILTIN_PIPELINES.find((p) => p.id === 'pdf-router')!;
  const PAGES = BUILTIN_PIPELINES.find((p) => p.id === 'pdf-pages')!;
  const has = (name: string) => existsSync(path.join(DIR!, name));
  async function routed(name: string) {
    const bytes = readFileSync(path.join(DIR!, name));
    const file = stepFileOf(bytes, 'pdf');
    const named = await runPackaged(ROUTER, bytes, file, { options: {} });
    return { bytes, file, kind: named.kind };
  }
  async function readBook(bytes: Buffer, file: ReturnType<typeof stepFileOf>) {
    return runWindowed(PAGES as never, bytes, file, {
      options: effectiveOptions(PAGES, {}),
      kind: 'book',
    });
  }
  const tab = (run: Awaited<ReturnType<typeof readBook>>, name: string) =>
    run.write!.tabs.find((t) => t.name === name);
  const col = (run: Awaited<ReturnType<typeof readBook>>, tabName: string, column: string) => {
    const t = tab(run, tabName)!;
    const i = t.columns.findIndex((c) => c.name === column);
    return t.rows.map((r) => r[i]);
  };

  it.skipIf(!DIR || !has('one.pdf'))(
    'a 1-page typed PDF is a book: its one page read from the text layer, no vision, no picture',
    async () => {
      const { bytes, file, kind } = await routed('one.pdf');
      expect(kind).toBe('book');
      const run = await readBook(bytes, file);
      expect(run.status).toBe('ok');
      expect(run.windows).toEqual({ pagesTotal: 1, failed: [] });
      expect(col(run, 'Pages', 'Method')).toEqual(['text']);
      expect(run.write!.pictures ?? []).toEqual([]);
      expect(run.write!.text).toMatch(/GENERAL NOTES/);
    },
    LONG,
  );

  it.skipIf(!DIR || !has('typed7.pdf'))(
    'a 7-page typed PDF with tables: every page from the text layer, the Tables tab, each row with its page, no vision',
    async () => {
      const { bytes, file, kind } = await routed('typed7.pdf');
      expect(kind).toBe('book');
      const run = await readBook(bytes, file);
      expect(col(run, 'Pages', 'Page')).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(col(run, 'Pages', 'Method')).toEqual(Array(7).fill('text'));
      expect(run.counts).toMatchObject({ vision: 0, scan: 0 });
      expect(run.write!.pictures ?? []).toEqual([]);
      const index = tab(run, 'Tables')!;
      expect(index.rows.length).toBeGreaterThanOrEqual(3);
      // Each table's tab: its rows start with the page of the original file.
      for (const name of col(run, 'Tables', 'Tab') as string[]) {
        const t = tab(run, name)!;
        expect(t.columns[0]!.name).toBe('Page');
        for (const r of t.rows) expect(r[0]).toBeGreaterThanOrEqual(2);
      }
    },
    LONG,
  );

  it.skipIf(!DIR || !has('scanned7.pdf'))(
    'a 7-page scanned PDF: a book, every page marked for the Scan reader with its lines, no local OCR',
    async () => {
      const { bytes, file, kind } = await routed('scanned7.pdf');
      expect(kind).toBe('book');
      const run = await readBook(bytes, file);
      expect(run.windows).toEqual({ pagesTotal: 7, failed: [] });
      expect(col(run, 'Pages', 'Page')).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(col(run, 'Pages', 'Method')).toEqual(Array(7).fill('vision'));
      expect(col(run, 'Pages', 'Why')).toEqual(Array(7).fill('scan'));
      for (const n of col(run, 'Pages', 'Lines') as number[]) expect(n).toBeGreaterThanOrEqual(10);
      expect(run.counts).toMatchObject({ scan: 7, vision: 7 });
      // A scanned page's tables are in its Scan reader text, not in tabs.
      expect(tab(run, 'Tables')).toBeFalsy();
    },
    LONG,
  );

  it.skipIf(!DIR || !has('scanbook.pdf'))(
    "a scanned book: the reader marks its scanned pages and writes no picture; the Agent's step draws each and cuts it as a one-page PDF",
    async () => {
      const { bytes, file, kind } = await routed('scanbook.pdf');
      expect(kind).toBe('book');
      const run = await readBook(bytes, file);
      const pages = col(run, 'Pages', 'Page') as number[];
      expect(pages).toEqual(Array.from({ length: 108 }, (_, i) => i + 1));
      const methods = col(run, 'Pages', 'Method');
      const vision = pages.filter((_, i) => methods[i] === 'vision');
      // Every scanned page with ink is marked (the blank ones are not).
      expect(vision.length).toBeGreaterThanOrEqual(96);
      // G1: no page picture from the reader.
      expect(run.write!.pictures ?? []).toEqual([]);
      expect(run.pictures.size).toBe(0);
      // Render: the Agent's step on the first window that holds a marked
      // page draws each marked page of it, one ask a page, before any call.
      const AGENT = BUILTIN_PIPELINES.find((p) => p.id === 'pdf-page-read')!;
      const first = await pdfWindowsAt(bytes, file.sha256, AGENT.needs.window!, vision).next();
      const part = first.value!.part!;
      const here = vision.filter((n) => n >= part.pageFrom && n <= part.pageTo);
      const step = await agentStep(AGENT as never, part.bytes, file, effectiveOptions(AGENT, {}), {
        kind: 'book',
        state: { readerOptions: {}, visionPages: vision, scanPages: vision },
        window: { pageFrom: part.pageFrom, pageTo: part.pageTo, pagesTotal: part.pagesTotal },
      });
      expect(step.status).toBe('ok');
      const asked = step.asks.map((a) => (a.input as { page: number }).page);
      expect(asked).toEqual(here);
      for (const a of step.asks) {
        const input = a.input as { picture: string; pdf?: string };
        const picture = step.pictures.get(input.picture);
        expect(picture!.length).toBeGreaterThan(1024);
        // Each scanned page also goes as a one-page PDF (qpdf), for the Scan
        // reader.
        const pdf = step.pictures.get(input.pdf ?? '');
        expect(pdf!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      }
      // The core's picture read of the same window: each scan is painted
      // over its page (pageCover), so a book leaves it out where the Agent
      // pictures the page.
      const read = await parserImages(part.bytes, 'pdf', { maxImages: 60, notScan: true });
      const covers = read.images.map((i) => i.pageCover ?? 0);
      expect(covers.length).toBeGreaterThan(0);
      expect(covers.every((c) => c >= IMAGE_PAGE_COVER)).toBe(true);
    },
    LONG,
  );

  it.skipIf(!DIR || !has('longtext.pdf'))(
    'a typed PDF of over 1,000,000 characters: every page in full in its Pages tab, none cut',
    async () => {
      const { bytes, file, kind } = await routed('longtext.pdf');
      expect(kind).toBe('book');
      const run = await readBook(bytes, file);
      const pages = col(run, 'Pages', 'Page') as number[];
      const texts = col(run, 'Pages', 'Text') as string[];
      expect(pages).toEqual(Array.from({ length: 460 }, (_, i) => i + 1));
      // Each page is whole: its own head line is in it.
      texts.forEach((t, i) => expect(t, `page ${i + 1}`).toMatch(new RegExp(`PAGE ${i + 1}\\b`)));
      const joined = pagesText(pages.map((page, i) => ({ page, text: texts[i]! })));
      expect(joined.length).toBeGreaterThan(1_000_000);
      expect(joined).toMatch(/## Page 460\n/);
    },
    LONG,
  );

  it(
    'gives a PDF past 256 MB every one of its pictures window by window, with no cap: a small job size only paces it',
    async () => {
      const bytes = readFileSync(path.join(DIR!, 'pictures.pdf'));
      expect(bytes.length).toBeGreaterThan(PDF_MAX_BYTES);
      // Jason, 2026-11-19: "Yes, no cap". Every picture is kept.
      const all = await picturesByWindows(bytes, MAX_EMBEDDED_IMAGES_CEILING, null);
      expect(all.windowsFailed).toBe(0);
      expect(all.images).toHaveLength(520);
      expect(picturesLeftOutOf(all)).toBe(0);
      // Reading order over every window, each with its page of the file
      // (four a page); the bytes on disk, read when asked for.
      expect(all.images.map((i) => i.ordinal)).toEqual(
        Array.from({ length: 520 }, (_, i) => i + 1),
      );
      expect(all.images.map((i) => i.location?.page)).toEqual(
        Array.from({ length: 520 }, (_, i) => Math.floor(i / 4) + 1),
      );
      expect(all.spool!.size).toBe(520);
      expect(all.images[519]!.bytes.length).toBeGreaterThan(0);
      all.spool!.drop();
      // A job of 60 pictures at most (a window of 50 pages holds 200): each
      // window is read again in halves, and still every picture is kept.
      const paced = await picturesByWindows(bytes, 60, null);
      expect(paced.images).toHaveLength(520);
      expect(picturesLeftOutOf(paced)).toBe(0);
      expect(new Set(paced.images.map((i) => i.sha256))).toEqual(
        new Set(all.images.map((i) => i.sha256)),
      );
      paced.spool!.drop();
      // The honest status of a file that truly left some out (a window lost).
      const status = extractionOf({
        extract_completed_at: '2026-11-18T00:00:00.000Z',
        images: { kept: 500, found: 520 },
      });
      expect(status.state).toBe('partial');
      expect(status.hint).toMatch(/^500 of 520 pictures kept\./);
    },
    LONG,
  );
});
