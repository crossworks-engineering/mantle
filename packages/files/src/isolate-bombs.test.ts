/**
 * The PDF and DWF bombs of the round-3 audit, each read the way the server
 * reads it, with this process's peak resident memory and its longest event
 * loop stall measured while the read runs. Each bomb is built BEFORE the
 * measurement starts, so only the read is counted.
 *
 *  - A 747 KB PDF holding one 16,000 x 16,000 picture: the pictures pass
 *    peaked at 1.9 GB (24,000 x 24,000: 3.9 GB), and the OCR render at
 *    5.4 GB with a 2 s stall, all outside the V8 heap cap.
 *  - A 3.5 MB DWF whose entries claim 1 KB and inflate to 400 MB each:
 *    3.7 GB on the main thread.
 *
 * The numbers are printed (`[bomb]` lines) for the round's report. Run this
 * file on its own for clean numbers: other files' workers share the process.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { dwfBomb, pdfPictureBomb } from './bombs.test-helper';
import { isDocumentLimitError } from './document-limit';
import { extractEmbeddedImages } from './embedded-images';
import { sniffImage } from './image-probe';
import { parseDocumentBytes } from './parse';
import { rasterizePdfToPngs } from './rasterize';
import { PDF_MAX_CANVAS_PIXELS } from './pdfjs';
import { helveticaPdf } from './pdf-fixtures.test-helper';

const MB = 1024 * 1024;

/** `fn`'s outcome, the most this process's resident memory rose above
 *  where it started while `fn` ran, and the longest event-loop stall. */
async function measure<T>(
  fn: () => Promise<T>,
): Promise<{ result: PromiseSettledResult<T>; peakMb: number; lagMs: number }> {
  const base = process.memoryUsage.rss();
  let peak = base;
  let lagMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lagMs = Math.max(lagMs, now - last - 5);
    last = now;
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 5);
  const [result] = await Promise.allSettled([fn()]);
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage.rss());
  return { result: result!, peakMb: Math.round((peak - base) / MB), lagMs: Math.round(lagMs) };
}

/** A read's peak, as the report prints it. */
const report: string[] = [];
function note(name: string, m: { peakMb: number; lagMs: number }, sizeBytes: number): void {
  report.push(
    `[bomb] ${name} (${(sizeBytes / 1024).toFixed(0)} KB): peak +${m.peakMb} MB resident, longest stall ${m.lagMs} ms`,
  );
}
afterAll(() => {
  for (const line of report) console.log(line);
});

/** The most a bomb's read may add to this process's resident memory: the
 *  thread's start-up (tsx, pdfjs) and one capped picture or canvas. The
 *  bombs took 1.9 to 5.4 GB. */
const MAX_PEAK_MB = 700;
/** Event-loop stalls allowed while a read runs in its thread. */
const MAX_LAG_MS = 500;

describe('PDF picture bombs (HIGH 1, HIGH 2)', () => {
  const p16 = pdfPictureBomb(16_000);
  const p24 = pdfPictureBomb(24_000);

  it('builds the audit fixtures at their sizes', () => {
    expect(p16.length).toBeLessThan(800 * 1024);
    expect(p24.length).toBeLessThan(2 * MB);
  });

  it('the control: a one-page text PDF, the cost of a read thread starting', async () => {
    const pdf = helveticaPdf();
    const m = await measure(() => extractEmbeddedImages(pdf, 'pdf'));
    note('control, a one-page text pdf, pictures', m, pdf.length);
    expect(m.result.status).toBe('fulfilled');
    expect(m.peakMb).toBeLessThan(MAX_PEAK_MB);
  }, 60_000);

  it('the pictures pass leaves a 16,000 x 16,000 picture out, unread', async () => {
    const m = await measure(() => extractEmbeddedImages(p16, 'pdf'));
    note('pdf 16000^2, pictures', m, p16.length);
    expect(m.result.status).toBe('fulfilled');
    expect((m.result as PromiseFulfilledResult<{ images: unknown[] }>).value.images).toEqual([]);
    expect(m.peakMb).toBeLessThan(MAX_PEAK_MB);
    expect(m.lagMs).toBeLessThan(MAX_LAG_MS);
  }, 60_000);

  it('and a 24,000 x 24,000 one', async () => {
    const m = await measure(() => extractEmbeddedImages(p24, 'pdf'));
    note('pdf 24000^2, pictures', m, p24.length);
    expect(m.result.status).toBe('fulfilled');
    expect(m.peakMb).toBeLessThan(MAX_PEAK_MB);
    expect(m.lagMs).toBeLessThan(MAX_LAG_MS);
  }, 60_000);

  it('the text pass reads it as no text layer', async () => {
    const m = await measure(() => parseDocumentBytes(p16, 'pdf'));
    note('pdf 16000^2, text', m, p16.length);
    expect(m.result).toEqual({ status: 'fulfilled', value: '' });
    expect(m.peakMb).toBeLessThan(MAX_PEAK_MB);
    expect(m.lagMs).toBeLessThan(MAX_LAG_MS);
  }, 60_000);

  it('the OCR render draws the page without the picture, off the main thread', async () => {
    const m = await measure(() => rasterizePdfToPngs(p16, { maxPages: 10 }));
    note('pdf 16000^2, OCR render', m, p16.length);
    expect(m.result.status).toBe('fulfilled');
    const pages = (
      m.result as PromiseFulfilledResult<Awaited<ReturnType<typeof rasterizePdfToPngs>>>
    ).value;
    expect(pages).toHaveLength(1);
    expect(m.peakMb).toBeLessThan(MAX_PEAK_MB);
    expect(m.lagMs).toBeLessThan(MAX_LAG_MS);
  }, 60_000);

  it('the OCR render scales a page larger than the canvas limit down to fit', async () => {
    // A 200,000-point page at scale 2 asks for a 5.5-million-pixel-wide canvas.
    const huge = pdfPictureBomb(100, { page: 200_000 });
    const m = await measure(() => rasterizePdfToPngs(huge, { maxPages: 1 }));
    note('pdf 200000-pt page, OCR render', m, huge.length);
    expect(m.result.status).toBe('fulfilled');
    const [page] = (
      m.result as PromiseFulfilledResult<Awaited<ReturnType<typeof rasterizePdfToPngs>>>
    ).value;
    const probed = sniffImage(page!.png);
    expect(probed?.width).toBeGreaterThan(1_000);
    expect(probed!.width! * probed!.height!).toBeLessThanOrEqual(PDF_MAX_CANVAS_PIXELS);
    expect(m.peakMb).toBeLessThan(MAX_PEAK_MB);
    expect(m.lagMs).toBeLessThan(MAX_LAG_MS);
  }, 60_000);

  it('a soft mask past the picture limit costs the read, not the process', async () => {
    // The picture is 100 x 100; its soft mask is the 16,000 x 16,000 one,
    // which pdfjs's picture limit does not look at. The memory watch
    // (isolate.ts) or pdfjs's own handling ends it.
    const bomb = pdfPictureBomb(16_000, { smask: true });
    const m = await measure(() => rasterizePdfToPngs(bomb, { maxPages: 1 }));
    note('pdf 16000^2 soft mask, OCR render', m, bomb.length);
    report.push(
      `[bomb]   soft mask 16000^2 outcome: ${m.result.status === 'rejected' ? String(m.result.reason) : 'rendered'}`,
    );
    if (m.result.status === 'rejected') expect(isDocumentLimitError(m.result.reason)).toBe(true);
    expect(m.peakMb).toBeLessThan(1_600);
  }, 120_000);

  it('a soft mask far past it is stopped by the memory watch', async () => {
    const bomb = pdfPictureBomb(32_000, { smask: true });
    const m = await measure(() => rasterizePdfToPngs(bomb, { maxPages: 1 }));
    note('pdf 32000^2 soft mask, OCR render', m, bomb.length);
    report.push(
      `[bomb]   soft mask 32000^2 outcome: ${m.result.status === 'rejected' ? String(m.result.reason) : 'rendered'}`,
    );
    expect(m.result.status).toBe('rejected');
    expect(isDocumentLimitError((m.result as PromiseRejectedResult).reason)).toBe(true);
    expect(m.peakMb).toBeLessThan(1_600);
    expect(m.lagMs).toBeLessThan(MAX_LAG_MS);
  }, 120_000);
});

describe('DWF bombs (HIGH 3)', () => {
  const bomb = dwfBomb();

  it('builds the audit fixture at its size', () => {
    expect(bomb.length).toBeLessThan(4 * MB);
  });

  it('the text pass reads the sheets, each W2D stream stopped at its cap', async () => {
    const m = await measure(() => parseDocumentBytes(bomb, 'dwf'));
    note('dwf 8 x 400 MB, text', m, bomb.length);
    expect(m.result.status).toBe('fulfilled');
    const text = (m.result as PromiseFulfilledResult<string>).value;
    expect(text).toContain('## Sheet Sheet 1');
    expect(text).not.toContain('Layers (');
    expect(m.peakMb).toBeLessThan(MAX_PEAK_MB);
    expect(m.lagMs).toBeLessThan(MAX_LAG_MS);
  }, 120_000);

  it('the pictures pass keeps no thumbnail past its cap', async () => {
    const m = await measure(() => extractEmbeddedImages(bomb, 'dwf'));
    note('dwf 8 x 400 MB, pictures', m, bomb.length);
    expect(m.result.status).toBe('fulfilled');
    expect((m.result as PromiseFulfilledResult<{ candidates: number }>).value.candidates).toBe(0);
    expect(m.peakMb).toBeLessThan(MAX_PEAK_MB);
    expect(m.lagMs).toBeLessThan(MAX_LAG_MS);
  }, 120_000);
});
