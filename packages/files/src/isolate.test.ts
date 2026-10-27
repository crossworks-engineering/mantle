/**
 * The resource limits on document reads (./isolate.ts): every hostile file
 * here ends as a DocumentLimitError (the extractor's terminal
 * `document_too_large` skip) while this process stays alive and its event
 * loop keeps turning. The bombs are built in memory (./bombs.test-helper.ts);
 * each is built BEFORE the lag is measured, so only the read is timed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { biffXls } from './biff.test-helper';
import { docxBomb, odsBomb, sparseXlsx, vsdxBomb } from './bombs.test-helper';
import { isDocumentLimitError, isRetryableReadError } from './document-limit';
import {
  MAX_CONCURRENT_READS,
  MAX_WAITING_READS,
  readBudget,
  readSlots,
  runIsolated,
} from './isolate';
import { MAX_READ_TEXT_CHARS } from './isolate-jobs';
import {
  MAX_LEGACY_CELLS,
  convertLegacySheetToXlsx,
  legacySheetFromXhtmlInProcess,
  legacySheetInProcess,
} from './legacy-sheet';
import { measureLegacyWorkbook } from './sheet-extent';
import { parseDocumentBytes } from './parse';
import { xlsbFile } from './xlsb.test-helper';

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

  it('a .vsdx that lies about its page size is stopped at the inflate cap', async () => {
    // 300 MB of page behind a header claiming 1 KB: inflated with an output
    // cap (zip-guard.ts), it stops at 128 MB instead of filling memory the
    // heap limit does not count.
    const bomb = vsdxBomb(300_000_000, 1_000);
    const before = process.memoryUsage().heapUsed;
    const { result, lagMs } = await lagWhile(() => parseDocumentBytes(bomb, 'vsdx'));
    expect(limitReason(result)).toBe('too_large');
    expect(String((result as PromiseRejectedResult).reason.message)).toContain(
      'visio/pages/page1.xml',
    );
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
    // This heap never held the page.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(100_000_000);
  }, 60_000);

  it('a read past its heap runs its thread out of heap, not the server', async () => {
    // A million cells of Tika-shaped XHTML rebuilt with a 32 MB heap, so the
    // test stays light; the default heap stops a larger read the same way.
    const row = `<tr>${'<td>12345</td>'.repeat(5)}</tr>`;
    const xhtml = `<html><body><h1>Big</h1><table>${row.repeat(199_999)}</table></body></html>`;
    const { result, lagMs } = await lagWhile(() =>
      runIsolated('legacySheetFromXhtml', [xhtml], { heapMb: 32 }),
    );
    expect(limitReason(result)).toBe('memory');
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
  }, 60_000);

  it('a .docx whose document part lies about its size never reaches mammoth', async () => {
    const bomb = docxBomb();
    expect(bomb.length).toBeLessThan(1_000_000);
    const { result, lagMs } = await lagWhile(() => parseDocumentBytes(bomb, 'docx'));
    expect(limitReason(result)).toBe('too_large');
    expect(String((result as PromiseRejectedResult).reason.message)).toContain('word/document.xml');
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
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

  it('a read past its time limit is retried once, then refused; the next read works', async () => {
    const bomb = odsBomb();
    const first = await runIsolated('anydocMarkdown', [bomb, 'ods'], { timeoutMs: 100 }).catch(
      (e: unknown) => e,
    );
    // The first time-out may be a slow box: retryable, not terminal.
    expect(isRetryableReadError(first)).toBe(true);
    expect(isDocumentLimitError(first)).toBe(false);
    // The same bytes again: the document.
    const second = await lagWhile(() =>
      runIsolated('anydocMarkdown', [bomb, 'ods'], { timeoutMs: 100 }),
    );
    expect(limitReason(second.result)).toBe('timeout');
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
   *  the format anydoc lays out as a full rectangle. `dimensions` is what
   *  its DIMENSIONS record claims (default: the truth; null: none). */
  function biffGrid(
    rows: number,
    cols: number,
    dimensions?: { rows: number; cols: number } | null,
  ): Buffer {
    const grid: (string | number)[][] = [['a']];
    const last: string[] = [];
    last[cols - 1] = 'b';
    grid[rows - 1] = last;
    return biffXls([{ name: 'Grid', rows: grid, dimensions }]);
  }

  it('refuses a binary .xls grid bomb from its cells, before anydoc lays it out', async () => {
    const bomb = biffGrid(10_000, 200);
    expect((await measureLegacyWorkbook(bomb))?.extents).toEqual([
      { name: 'Grid', rows: 10_000, cols: 200 },
    ]);
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

  it('measures a sheet whose DIMENSIONS record lies (1 x 1) from its cells, and refuses it', async () => {
    // The 6 KB file that made anydoc peak at 1.5 GB: DIMENSIONS claims one
    // cell, the cells reach row 19,000, column 200.
    const bomb = biffGrid(19_001, 201, { rows: 1, cols: 1 });
    expect(bomb.length).toBeLessThan(10_000);
    expect((await measureLegacyWorkbook(bomb))?.extents).toEqual([
      { name: 'Grid', rows: 19_001, cols: 201 },
    ]);
    const { result, lagMs } = await lagWhile(() => parseDocumentBytes(bomb, 'xls'));
    expect(limitReason(result)).toBe('too_large');
    expect(String((result as PromiseRejectedResult).reason.message)).toContain(
      'sheet "Grid" (19,001 rows x 201 columns)',
    );
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
  }, 30_000);

  it('measures a sheet with no DIMENSIONS record from its cells, and refuses it', async () => {
    const bomb = biffGrid(19_001, 201, null);
    expect((await measureLegacyWorkbook(bomb))?.extents).toEqual([
      { name: 'Grid', rows: 19_001, cols: 201 },
    ]);
    const err = await legacySheetInProcess(bomb).catch((e: unknown) => e);
    expect(isDocumentLimitError(err)).toBe(true);
  });

  it('reads a small sheet with no DIMENSIONS record, or a lying one, as usual', async () => {
    for (const dimensions of [null, { rows: 60_000, cols: 250 }]) {
      const xls = biffXls([
        {
          name: 'Orders',
          rows: [
            ['Tag', 'Qty'],
            ['P-101', 4],
          ],
          dimensions,
        },
      ]);
      expect((await measureLegacyWorkbook(xls))?.extents).toEqual([
        { name: 'Orders', rows: 2, cols: 2 },
      ]);
      // A one-sheet workbook comes back unnamed from anydoc.
      expect(await parseDocumentBytes(xls, 'xls')).toBe('# Sheet: Sheet1\nTag,Qty\nP-101,4');
    }
  }, 30_000);

  it('never gives anydoc a file whose sheets cannot be measured', async () => {
    // A compound file with no Workbook stream, and bytes that are neither a
    // compound file nor a zip.
    const noWorkbook = biffXls([{ name: 'S', rows: [['x']] }]);
    noWorkbook.write('Workbool', 512 * 3, 'utf16le');
    expect(await measureLegacyWorkbook(noWorkbook)).toBeNull();
    expect(await legacySheetInProcess(noWorkbook)).toBeNull();
    expect(await measureLegacyWorkbook(Buffer.from('<html>not a workbook</html>'))).toBeNull();
  });

  it("does not read a binary .xls's pictures with anydoc (its sheet reader carries none)", async () => {
    const { extractEmbeddedImages } = await import('./embedded-images');
    const start = performance.now();
    const result = await extractEmbeddedImages(biffGrid(19_001, 201, { rows: 1, cols: 1 }), 'xls');
    expect(result).toEqual({ images: [], rejected: {}, candidates: 0 });
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it('measures an .xlsb from its cell records, not BrtWsDim, and refuses past the budget', async () => {
    const far: [number, number, number] = [18_999, 199, 4];
    for (const dimension of [{ rows: 1, cols: 1 }, null]) {
      const xlsb = await xlsbFile([{ name: 'Grid', cells: [[0, 0, 1], far], dimension }]);
      expect((await measureLegacyWorkbook(xlsb))?.extents).toEqual([
        { name: 'Grid', rows: 19_000, cols: 200 },
      ]);
      const { result, lagMs } = await lagWhile(() => parseDocumentBytes(xlsb, 'xlsb'));
      expect(limitReason(result)).toBe('too_large');
      expect(lagMs).toBeLessThan(MAX_LAG_MS);
    }
  }, 30_000);

  it('reads a small .xlsb through the rebuilt container, hidden sheets left out', async () => {
    const xlsb = await xlsbFile([
      {
        name: 'Orders',
        cells: [
          [0, 0, 1],
          [1, 1, 2.5],
        ],
        dimension: null,
      },
      { name: 'Hidden', cells: [[0, 0, 9]], hidden: true },
    ]);
    expect((await measureLegacyWorkbook(xlsb))?.extents).toEqual([
      { name: 'Orders', rows: 2, cols: 2 },
    ]);
    expect(await parseDocumentBytes(xlsb, 'xlsb')).toBe('# Sheet: Sheet1\n1\n,2.5');
  }, 30_000);

  it('converts one upload once: the text and the grid passes share it', async () => {
    const xls = biffXls([{ name: 'Orders', rows: [['Tag'], ['P-101']] }]);
    const a = convertLegacySheetToXlsx(xls, 'application/vnd.ms-excel');
    const b = convertLegacySheetToXlsx(xls, 'application/vnd.ms-excel');
    expect(b).toBe(a);
    await a;
    expect(convertLegacySheetToXlsx(xls, 'application/vnd.ms-excel')).toBe(a);
    // Another upload of the same bytes is its own read.
    expect(convertLegacySheetToXlsx(Buffer.from(xls), 'application/vnd.ms-excel')).not.toBe(a);
  }, 30_000);

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

describe('the read budget and the wait', () => {
  const GiB = 1024 * 1024 * 1024;

  it('sizes the heap and the reads at once from the memory the process may use', () => {
    // A 3 GB container (the api and web caps): one read at a time.
    expect(readBudget(3 * GiB)).toEqual({ limitMb: 3072, heapMb: 768, concurrency: 1 });
    // A small box: the least heap, one read.
    expect(readBudget(2 * GiB)).toMatchObject({ heapMb: 256, concurrency: 1 });
    // Room for two.
    expect(readBudget(8 * GiB)).toMatchObject({ heapMb: 768, concurrency: 2 });
    expect(readBudget(64 * GiB)).toMatchObject({ heapMb: 768, concurrency: 2 });
  });

  it('a read that waits past its deadline, or finds the queue full, is retryable', async () => {
    // Hold every slot with reads of a bomb (each a different document: the
    // same bytes timing out twice is terminal), stopped by a limit or by a
    // 1.5 s time limit.
    const held = Array.from({ length: MAX_CONCURRENT_READS }, (_, i) =>
      runIsolated('anydocMarkdown', [odsBomb(4_001 + i), 'ods'], { timeoutMs: 1_500 }).catch(
        (e: unknown) => e,
      ),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(readSlots().active).toBe(MAX_CONCURRENT_READS);

    const late = await runIsolated('markup', [Buffer.from('<p>hi</p>'), 'html'], {
      waitMs: 100,
    }).catch((e: unknown) => e);
    expect(isRetryableReadError(late)).toBe(true);
    expect(isDocumentLimitError(late)).toBe(false);

    const queued = Array.from({ length: MAX_WAITING_READS }, () =>
      runIsolated('markup', [Buffer.from('<p>hi</p>'), 'html'], { waitMs: 30_000 }).catch(
        (e: unknown) => e,
      ),
    );
    const full = await runIsolated('markup', [Buffer.from('<p>hi</p>'), 'html']).catch(
      (e: unknown) => e,
    );
    expect(isRetryableReadError(full)).toBe(true);

    // The held reads end (refused, or a first time-out), their threads
    // exit, and the queue drains through the freed slots.
    for (const r of await Promise.all(held)) expect(r).toBeInstanceOf(Error);
    for (const r of await Promise.all(queued)) expect(r).toBe('hi');
    // A slot is the thread's: it frees when the thread has exited, just
    // after the answer.
    await vi.waitFor(() => expect(readSlots()).toEqual({ active: 0, waiting: 0 }), {
      timeout: 5_000,
    });
  }, 60_000);
});
