/**
 * The large-PDF finish (2026-11-19), the core's part with the parser's jobs
 * made up here: the Agent cuts only the windows that hold a marked page
 * (decision 4); every picture of a PDF is kept, a window whose answer left
 * pictures out read again in halves (Jason: "Yes, no cap"), each picture on
 * disk and read when it is asked for; a windowed run's pictures are on disk
 * (G1). The real qpdf, picture read and OCR run in
 * large-pdf-windows.e2e.test.ts against the parser image.
 */
import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Files from '@mantle/files';

const split = vi.fn();
const images = vi.fn();
vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof Files>()),
  parserPdfSplit: (...a: unknown[]) => split(...a),
  parserImages: (...a: unknown[]) => images(...a),
}));

const { pdfWindowsAt } = await import('./pipeline-runner');
const { picturesByWindows, picturesLeftOutOf, picturesNeedWindows } =
  await import('./pdf-picture-windows');
const { SpooledPictures } = await import('./picture-spool');

const TOTAL = 1679;

/** The made-up cut: `pages` from `from`, the bytes naming the window. */
function cut() {
  split.mockImplementation(async (_b: Buffer, o: { from: number; pages: number }) => {
    const pageTo = Math.min(TOTAL, o.from + o.pages - 1);
    return {
      bytes: Buffer.from(`${o.from}-${pageTo}`),
      pageFrom: o.from,
      pageTo,
      pagesTotal: TOTAL,
    };
  });
}

beforeEach(() => {
  split.mockReset();
  images.mockReset();
});

describe('the Agent cuts only the windows that hold a marked page', () => {
  it('one marked page of 1,679 is one cut; pages close together share a window', async () => {
    cut();
    const at = async (marked: number[]) => {
      split.mockClear();
      const spans: [number, number][] = [];
      for await (const w of pdfWindowsAt(
        Buffer.from('pdf'),
        'a'.repeat(64),
        { pages: 15, mb: 50 },
        marked,
      )) {
        spans.push([w.part!.pageFrom, w.part!.pageTo]);
      }
      return { spans, cuts: split.mock.calls.length };
    };
    expect(await at([900])).toEqual({ spans: [[900, 914]], cuts: 1 });
    expect(await at([3, 10, 17, 900, 1679, 900])).toEqual({
      spans: [
        [3, 17],
        [900, 914],
        [1679, 1679],
      ],
      cuts: 3,
    });
  });
});

/** A made-up picture: its bytes name it. */
const pic = (name: string, page: number) => ({
  bytes: Buffer.from(name.padEnd(2048, '.')),
  ext: 'png',
  sha256: name,
  ordinal: 1,
  location: { page },
});

describe('every picture of a PDF is kept: no cap, paced by windows', () => {
  it('a window whose answer left pictures out is read again in halves, down to a page', async () => {
    // A file of 4 pages, 3 pictures a page; one job keeps 4 pictures at most.
    const PAGES = 4;
    split.mockImplementation(async (_b: Buffer, o: { from: number; pages: number }) => {
      const pageTo = Math.min(PAGES, o.from + o.pages - 1);
      return {
        bytes: Buffer.from(`${o.from}-${pageTo}`),
        pageFrom: o.from,
        pageTo,
        pagesTotal: PAGES,
      };
    });
    images.mockImplementation(async (body: Buffer, _ext: string, o: { maxImages: number }) => {
      const [from, to] = body.toString().split('-').map(Number) as [number, number];
      const all = [];
      for (let p = from; p <= to; p++)
        for (let k = 1; k <= 3; k++) all.push(pic(`p${p}-${k}`, p - from + 1));
      const kept = all.slice(0, o.maxImages);
      return {
        images: kept,
        rejected: all.length > kept.length ? { over_cap: all.length - kept.length } : {},
        candidates: all.length,
      };
    });
    const read = await picturesByWindows(Buffer.from('pdf'), 4, null, { pages: 50, mb: 50 });
    expect(read.images.map((i) => i.sha256)).toEqual(
      [1, 2, 3, 4].flatMap((p) => [1, 2, 3].map((k) => `p${p}-${k}`)),
    );
    // The page of the original file and the order over every window.
    expect(read.images.map((i) => i.location?.page)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]);
    expect(read.images.map((i) => i.ordinal)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(picturesLeftOutOf(read)).toBe(0);
    // On disk, read when asked for.
    expect(read.spool!.size).toBe(12);
    expect(read.images[4]!.bytes.toString().startsWith('p2-2')).toBe(true);
    read.spool!.drop();
    expect(read.images[4]!.bytes.length).toBe(0);
  });

  it('a single page past one answer even alone is counted, never silently lost', async () => {
    split.mockImplementation(async () => ({
      bytes: Buffer.from('1-1'),
      pageFrom: 1,
      pageTo: 1,
      pagesTotal: 1,
    }));
    images.mockResolvedValue({
      images: [pic('a', 1)],
      rejected: { answer_budget: 2 },
      candidates: 3,
    });
    const read = await picturesByWindows(Buffer.from('pdf'), 2000, null);
    expect(read.images).toHaveLength(1);
    expect(picturesLeftOutOf(read)).toBe(2);
    read.spool!.drop();
  });

  it('a one-read result that left pictures out is read by windows', () => {
    const whole = { images: [], rejected: { over_cap: 3 }, candidates: 3 };
    expect(picturesNeedWindows(10, 100, whole)).toBe(true);
    expect(picturesNeedWindows(10, 100, { images: [], rejected: {}, candidates: 0 })).toBe(false);
  });
});

describe('pictures on disk', () => {
  it('a spool writes each picture to its folder, reads it back, and drops the folder', () => {
    const s = new SpooledPictures();
    s.put('w1-page-00001.png', Buffer.from('one'));
    s.put('w51-page-00051.png', Buffer.from('two'));
    expect([...s.keys()]).toEqual(['w1-page-00001.png', 'w51-page-00051.png']);
    expect(s.get('w51-page-00051.png')?.toString()).toBe('two');
    expect(s.diskBytes).toBe(6);
    const dir = (s as unknown as { folder: string }).folder;
    expect(existsSync(dir)).toBe(true);
    s.drop();
    expect(existsSync(dir)).toBe(false);
    expect(s.get('w1-page-00001.png')).toBeUndefined();
  });
});
