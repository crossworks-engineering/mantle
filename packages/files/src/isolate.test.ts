/**
 * The resource limits on document reads (./isolate.ts): every hostile file
 * here ends as a DocumentLimitError (the extractor's terminal
 * `document_too_large` skip) while this process stays alive and its event
 * loop keeps turning. The bombs are built in memory (./bombs.test-helper.ts);
 * each is built BEFORE the lag is measured, so only the read is timed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { biffXls } from './biff.test-helper';
import { odsBomb, sparseXlsx, vsdxBomb } from './bombs.test-helper';
import { isDocumentLimitError } from './document-limit';
import { runIsolated } from './isolate';
import { MAX_READ_TEXT_CHARS } from './isolate-jobs';
import {
  MAX_LEGACY_CELLS,
  legacySheetFromXhtmlInProcess,
  legacySheetInProcess,
} from './legacy-sheet';
import { legacySheetExtents } from './sheet-extent';
import { parseDocumentBytes } from './parse';

/** The longest the event loop went without a turn while `fn` ran. */
async function lagWhile<T>(
  fn: () => Promise<T>,
): Promise<{ result: PromiseSettledResult<T>; lagMs: number }> {
  let lagMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lagMs = Math.max(lagMs, now - last - 10);
    last = now;
  }, 10);
  const [result] = await Promise.allSettled([fn()]);
  clearInterval(timer);
  return { result: result!, lagMs };
}

/** The reason of a read that must have been stopped by a limit. */
function limitReason(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status !== 'rejected') return undefined;
  return isDocumentLimitError(result.reason)
    ? result.reason.reason
    : `not a limit: ${String(result.reason)}`;
}

/** Event-loop stalls allowed while a read runs elsewhere. A thread start and
 *  a few hundred KB copied cost tens of ms; the bombs used to stall it for
 *  seconds to tens of seconds. Generous for a loaded test box. */
const MAX_LAG_MS = 500;

const ORIGINAL_TIKA_URL = process.env.TIKA_URL;
beforeEach(() => {
  delete process.env.TIKA_URL;
});
afterEach(() => {
  if (ORIGINAL_TIKA_URL == null) delete process.env.TIKA_URL;
  else process.env.TIKA_URL = ORIGINAL_TIKA_URL;
});

describe('document reads under limits', () => {
  it('an ODS that unpacks to 77 MB of text is refused, the server untouched', async () => {
    const bomb = odsBomb();
    expect(bomb.length).toBeLessThan(1_000_000);
    const { result, lagMs } = await lagWhile(() => parseDocumentBytes(bomb, 'ods'));
    expect(limitReason(result)).toBe('too_large');
    expect(String((result as PromiseRejectedResult).reason.message)).toContain(
      MAX_READ_TEXT_CHARS.toLocaleString('en-US'),
    );
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
  }, 30_000);

  it("an ODS past anydoc's own node limit ends as its reader limit", async () => {
    const bomb = odsBomb(20_000, 64, 10);
    const { result, lagMs } = await lagWhile(() => parseDocumentBytes(bomb, 'ods'));
    expect(limitReason(result)).toBe('reader_limit');
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
  }, 30_000);

  it('a .vsdx whose page unpacks to 1.47 GB is refused before it is inflated', async () => {
    const bomb = vsdxBomb();
    const { result, lagMs } = await lagWhile(() => parseDocumentBytes(bomb, 'vsdx'));
    expect(limitReason(result)).toBe('too_large');
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
  }, 30_000);

  it('a .vsdx that lies about its page size runs its thread out of heap, not the server', async () => {
    // 300 MB of page behind a header claiming 1 KB, read with a small heap
    // so the test stays light; the default heap stops the 1.47 GB one the
    // same way.
    const bomb = vsdxBomb(300_000_000, 1_000);
    const before = process.memoryUsage().heapUsed;
    const { result, lagMs } = await lagWhile(() => runIsolated('vsdx', [bomb], { heapMb: 64 }));
    expect(limitReason(result)).toBe('memory');
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
    // This heap never held the page.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(100_000_000);
  }, 60_000);

  it('the .xls grid bomb (an .xlsx holding A1 and GR10000) is read as the .xlsx it is', async () => {
    const bomb = sparseXlsx();
    expect(bomb.length).toBeLessThan(2_000);
    const start = performance.now();
    const { result, lagMs } = await lagWhile(() => parseDocumentBytes(bomb, 'xls'));
    expect(result.status).toBe('fulfilled');
    expect((result as PromiseFulfilledResult<string>).value).toContain('# Sheet: Sheet1');
    // Was 18.7 s and 1.39 GB through the legacy rebuild.
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
  }, 30_000);

  it('a read past its time limit is stopped, and the next read works', async () => {
    const bomb = odsBomb();
    const { result } = await lagWhile(() =>
      runIsolated('anydocMarkdown', [bomb, 'ods'], { timeoutMs: 100 }),
    );
    expect(limitReason(result)).toBe('timeout');
    await expect(
      parseDocumentBytes(Buffer.from('{\\rtf1\\ansi still reading\\par}'), 'rtf'),
    ).resolves.toBe('still reading');
  }, 30_000);

  it("a reader's own error crosses the thread with its code, not as a limit", async () => {
    const err = await parseDocumentBytes(Buffer.from('not a document'), 'doc').catch((e) => e);
    expect(isDocumentLimitError(err)).toBe(false);
    expect(err).toMatchObject({ code: expect.any(String) });
  });
});

describe('the legacy-sheet cell budget', () => {
  /** A binary .xls holding A1 and the cell at (rows, cols): the grid bomb in
   *  the format anydoc lays out as a full rectangle. */
  function biffGrid(rows: number, cols: number): Buffer {
    const grid: (string | number)[][] = [['a']];
    const last: string[] = [];
    last[cols - 1] = 'b';
    grid[rows - 1] = last;
    return biffXls([{ name: 'Grid', rows: grid }]);
  }

  it('refuses a binary .xls grid bomb from its declared extent, before anydoc lays it out', async () => {
    const bomb = biffGrid(10_000, 200);
    expect(await legacySheetExtents(bomb)).toEqual([{ name: 'Grid', rows: 10_000, cols: 200 }]);
    const start = performance.now();
    const { result, lagMs } = await lagWhile(() => parseDocumentBytes(bomb, 'xls'));
    expect(limitReason(result)).toBe('too_large');
    expect(String((result as PromiseRejectedResult).reason.message)).toContain(
      'sheet "Grid" (10,000 rows x 200 columns)',
    );
    // Laid out, this sheet was 2,000,000 slots and about 1.4 GB resident.
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
  }, 30_000);

  it("refuses the same bomb's pictures pass before anydoc lays it out", async () => {
    const { extractEmbeddedImages } = await import('./embedded-images');
    const err = await extractEmbeddedImages(biffGrid(10_000, 200), 'xls').catch((e) => e);
    expect(isDocumentLimitError(err)).toBe(true);
  }, 30_000);

  it('reads an .xlsb sheet extent from its BrtWsDim record, and refuses past the budget', async () => {
    // BrtBeginSheet, then BrtWsDim: rows 0..9999, columns 0..199.
    const dim = Buffer.alloc(16);
    dim.writeUInt32LE(9_999, 4);
    dim.writeUInt32LE(199, 12);
    const sheet = Buffer.concat([Buffer.from([0x81, 0x01, 0x00, 0x94, 0x01, 0x10]), dim]);
    const zip = new JSZip();
    zip.file('xl/workbook.bin', Buffer.alloc(8));
    zip.file('xl/worksheets/sheet1.bin', sheet);
    const xlsb = await zip.generateAsync({ type: 'nodebuffer' });
    expect(await legacySheetExtents(xlsb)).toEqual([{ name: 'Sheet1', rows: 10_000, cols: 200 }]);
    const err = await legacySheetInProcess(xlsb).catch((e) => e);
    expect(isDocumentLimitError(err)).toBe(true);
  });

  /** Tika-shaped XHTML: one `<h1>` and `<table>` per sheet. */
  function xhtml(sheets: Array<{ name: string; rows: number; cols: number }>): string {
    const pages = sheets.map(({ name, rows, cols }) => {
      const row = `<tr>${'<td>1</td>'.repeat(cols)}</tr>`;
      return `<div class="page"><h1>${name}</h1><table><tbody>${row.repeat(rows)}</tbody></table></div>`;
    });
    return `<html><body>${pages.join('')}</body></html>`;
  }

  it('refuses a sheet past the budget by name, before building it, and keeps the rest', async () => {
    const cols = 1_000;
    const rows = MAX_LEGACY_CELLS / cols + 1;
    const out = await legacySheetFromXhtmlInProcess(
      xhtml([
        { name: 'Small', rows: 2, cols: 2 },
        { name: 'Huge', rows, cols },
      ]),
    );
    expect(out!.refused).toEqual([{ name: 'Huge', rows, cols }]);
    const text = await parseDocumentBytes(out!.xlsx, 'xlsx');
    expect(text).toContain('# Sheet: Small');
    expect(text).not.toContain('Huge');
  }, 30_000);

  it('throws the refusal when every sheet is past the budget', async () => {
    const err = await legacySheetFromXhtmlInProcess(
      xhtml([{ name: 'Huge', rows: MAX_LEGACY_CELLS / 500 + 1, cols: 500 }]),
    ).catch((e) => e);
    expect(isDocumentLimitError(err)).toBe(true);
    expect(err.message).toContain('sheet "Huge"');
  }, 30_000);
});
