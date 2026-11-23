/**
 * Long sheets read in part, never refused whole (the ingest program):
 * the stream reader of a workbook past the size check, the row keeper of a
 * file database read, and a CSV read as a stream. Made-up data only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withReadCutSink } from './read-cut-sink';
import { loadWorkbook, streamWorkbookRows, worksheetToRows, type RawCell } from './sheet-read';
import { parseDelimited, RowKeeper } from './sheet-to-grid';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'pipelines/pkg/sheet/fixtures',
);

/** A workbook of `rows` rows of `cols` text cells, plus a second sheet. */
async function workbook(rows: number, cols = 2): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Big');
  for (let r = 0; r < rows; r++) ws.addRow(Array.from({ length: cols }, (_, c) => `v${r}-${c}`));
  wb.addWorksheet('Small').addRow(['a', 1, new Date(Date.UTC(2026, 0, 2))]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The rows of each sheet by the whole-workbook reader, trailing blanks
 *  dropped as the stream drops them. */
async function loadRows(buf: Buffer): Promise<Record<string, RawCell[][]>> {
  const wb = await loadWorkbook(buf);
  const out: Record<string, RawCell[][]> = {};
  for (const ws of wb.worksheets) {
    const rows = worksheetToRows(ws, { maxRows: 1e7, maxCols: 16_384 }).rows.map((r) => {
      const c = [...r];
      while (c.length > 0 && c[c.length - 1] === null) c.pop();
      return c;
    });
    const kept = rows.filter((r) => r.length > 0);
    if (kept.length > 0) out[ws.name] = kept;
  }
  return out;
}

async function streamRows(buf: Buffer): Promise<Record<string, RawCell[][]>> {
  const out: Record<string, RawCell[][]> = {};
  await streamWorkbookRows(buf, (name, cells) => {
    (out[name] ??= []).push(cells);
    return true;
  });
  return out;
}

afterEach(() => {
  vi.doUnmock('./sheet-read');
  vi.resetModules();
});

describe('streamWorkbookRows', () => {
  it('gives the cells the whole-workbook reader gives, on every golden workbook, but three kinds', async () => {
    // The kinds the stream leaves blank: a formula's cached error (#DIV/0!),
    // a NaN (the whole reader's NaN is no value in a grid either) and a
    // formula's empty text (both sides lose them here; typed.xlsx has
    // them), and a merged cell past its first (sheets.xlsx, its Merged).
    const lossy = (sheets: Record<string, RawCell[][]>) =>
      Object.fromEntries(
        Object.entries(sheets).map(([k, rows]) => [
          k,
          rows
            .map((r) => {
              const c = r.map((v) =>
                v === '' ||
                (typeof v === 'number' && Number.isNaN(v)) ||
                (typeof v === 'string' && /^#[A-Z/0!?]+[!?A]$/.test(v))
                  ? null
                  : v,
              );
              while (c.length > 0 && c[c.length - 1] === null) c.pop();
              return c;
            })
            .filter((r) => r.length > 0),
        ]),
      );
    const names = readdirSync(FIXTURES).filter((n) => /\.xls[xm]$/.test(n));
    expect(names.length).toBeGreaterThanOrEqual(7);
    let compared = 0;
    for (const name of names) {
      const buf = readFileSync(path.join(FIXTURES, name));
      const whole = await loadRows(buf).catch(() => null);
      if (whole === null) continue; // not a workbook (png bytes), or no readable one
      const streamed = await streamRows(buf);
      if (name === 'sheets.xlsx') {
        // Its merged cells: the whole reader fills each, the stream the
        // first only (the case below).
        expect(streamed.Merged).not.toEqual(whole.Merged);
        delete streamed.Merged;
        delete whole.Merged;
      }
      if (name === 'typed.xlsx') {
        expect(JSON.stringify(whole)).toContain('"#DIV/0!"');
        expect(JSON.stringify(streamed)).not.toContain('#DIV/0!');
      }
      expect(lossy(streamed), name).toEqual(lossy(whole));
      compared += 1;
    }
    expect(compared).toBeGreaterThanOrEqual(5);
  });

  it('reads a zip that names its workbook part last (the order the stream reader needs is fixed)', async () => {
    const zip = await JSZip.loadAsync(await workbook(3));
    const last = new JSZip();
    const files = last.files as Record<string, JSZip.JSZipObject>;
    const names = Object.keys(zip.files);
    for (const n of [
      'xl/sharedStrings.xml',
      'xl/_rels/workbook.xml.rels',
      ...names.filter((x) => x !== 'xl/workbook.xml'),
      'xl/workbook.xml',
    ]) {
      if (zip.files[n] && !(n in files)) files[n] = zip.files[n]!;
    }
    const buf = await last.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(Object.keys((await JSZip.loadAsync(buf)).files).at(-1)).toBe('xl/workbook.xml');
    expect(await streamRows(buf)).toEqual({
      Big: [
        ['v0-0', 'v0-1'],
        ['v1-0', 'v1-1'],
        ['v2-0', 'v2-1'],
      ],
      Small: [['a', 1, new Date(Date.UTC(2026, 0, 2))]],
    });
  });

  it('a merged cell: the whole reader fills it, the stream does not (why the size switch stays)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('M');
    ws.addRow(['head', null]);
    ws.mergeCells('A1:B1');
    ws.addRow(['x', 'y']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect((await loadRows(buf)).M![0]).toEqual(['head', 'head']);
    expect((await streamRows(buf)).M![0]).toEqual(['head']);
  });

  it('reads a workbook with no shared strings part, and says its sheet count', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('N').addRow([1, 2]);
    wb.addWorksheet('Empty');
    const zip = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()));
    zip.remove('xl/sharedStrings.xml');
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const seen: RawCell[][] = [];
    const { sheets } = await streamWorkbookRows(buf, (_n, cells) => (seen.push(cells), true));
    expect(seen).toEqual([[1, 2]]);
    expect(sheets).toBe(2);
  });

  it('a row of wide padding and multi-byte text counts its answer bytes', () => {
    const keep = new RowKeeper(100, 1e9);
    keep.take(['a', 'b', 'c']); // width 3
    keep.take(['é']); // 2 bytes + 3, and 2 blanks of 5
    expect(keep.cut()).toBeNull();
    const tight = new RowKeeper(100, 12 + 15);
    expect(tight.take(['a', 'b', 'c'])).toBe(true); // 12
    expect(tight.take(['é'])).toBe(true); // 5 + 10 = 15: 27
    expect(tight.take(['x'])).toBe(false); // 4 + 10 more
  });

  it('a wide row late counts the padding of every row kept before it', () => {
    const keep = new RowKeeper(100, 100);
    for (let i = 0; i < 10; i++) expect(keep.take(['a'])).toBe(true); // 40
    // 10 more columns: 10 rows x 10 x 5 = 500 bytes of padding.
    expect(keep.take(Array.from({ length: 11 }, () => 'b'))).toBe(false);
    expect(keep.cut()).toMatchObject({ database_size: { read: 10, total: 11 } });
  });

  it('stops when the visit says so', async () => {
    let seen = 0;
    await streamWorkbookRows(await workbook(500), () => ++seen < 10);
    expect(seen).toBe(10);
  });
});

/** The module with its size check failing for every workbook: the paths
 *  past 32 MB of sheet XML, on small made-up files. */
async function pastTheSizeCheck() {
  vi.resetModules();
  vi.doMock('./sheet-read', async (orig) => {
    const real = await orig<typeof import('./sheet-read')>();
    return {
      ...real,
      loadWorkbook: async () => {
        throw new real.SpreadsheetTooLargeError(40 * 1024 * 1024, real.MAX_SHEET_XML_BYTES);
      },
    };
  });
}

describe('a workbook past the size check', () => {
  it('its text is read as a stream to the first long sheet, and says both cuts', async () => {
    const buf = await workbook(6200);
    const whole = await withReadCutSink(async () => (await import('./xlsx')).parseXlsx(buf));
    await pastTheSizeCheck();
    // The modules again, after the mock: the sink of the fresh xlsx.ts.
    const sink = (await import('./read-cut-sink')).withReadCutSink;
    const streamed = await sink(async () => (await import('./xlsx')).parseXlsx(buf));
    // The same first sheet; the read stops in it, so the second is not read.
    const big = whole.value.slice(0, whole.value.indexOf('# Sheet: Small')).trim();
    expect(streamed.value.startsWith(big)).toBe(true);
    expect(streamed.value).not.toContain('# Sheet: Small');
    expect(streamed.cuts).toEqual({
      sheet_rows: { what: 'rows', read: 5000, total: 5001, atLeast: true, limit: 5000 },
      sheet_text: { what: 'sheets', read: 1, total: 2 },
    });
  });

  it('a file database read keeps its head and says the cut; an import still refuses it', async () => {
    const buf = await workbook(300);
    await pastTheSizeCheck();
    const { parseSheetToGrid } = await import('./sheet-grid');
    const { RowKeeper: Keeper } = await import('./sheet-to-grid');
    const keep = new Keeper(100, 1e9);
    const sheets = await parseSheetToGrid(buf, keep);
    expect(sheets.map((s) => [s.name, s.rows.length])).toEqual([['Big', 99]]);
    expect(sheets[0]!.rows[0]).toEqual(['v1-0', 'v1-1']);
    // The stream stops at the cut: the rows past it are not counted.
    expect(keep.cut()).toEqual({
      database_rows: { what: 'rows', read: 100, total: 101, atLeast: true, limit: 100 },
    });
    await expect(parseSheetToGrid(buf)).rejects.toThrow(/too large to read/);
  });
});

describe('RowKeeper', () => {
  it('keeps the head to the row limit, counts the rest', () => {
    const keep = new RowKeeper(2, 1e9);
    expect([1, 2, 3, 4].map((v) => keep.take([v]))).toEqual([true, true, false, false]);
    expect(keep.cut()).toEqual({
      database_rows: { what: 'rows', read: 2, total: 4, limit: 2 },
    });
  });

  it('keeps the head to the byte budget (a cell is its text plus 3), and stops there', () => {
    const keep = new RowKeeper(100, 10);
    expect(keep.take(['ab'])).toBe(true); // 5
    expect(keep.take(['a'])).toBe(true); // 9
    expect(keep.take(['a'])).toBe(false); // 13 > 10
    expect(keep.take([])).toBe(false); // stopped: every later row too
    expect(keep.cut()).toEqual({
      database_size: { what: 'rows', read: 2, total: 4, limit: 10 },
    });
  });

  it('says no cut when every row was kept', () => {
    const keep = new RowKeeper(5, 100);
    keep.take(['a']);
    expect(keep.cut()).toBeNull();
  });
});

describe('a CSV read as a stream', () => {
  it('bytes give what the text gives, on every golden CSV that reads', async () => {
    for (const name of readdirSync(FIXTURES).filter((n) => n.endsWith('.csv'))) {
      const buf = readFileSync(path.join(FIXTURES, name));
      const text = await parseDelimited(buf.toString('utf-8')).catch(() => 'throws');
      const bytes = await parseDelimited(buf).catch(() => 'throws');
      expect(bytes, name).toEqual(text);
    }
  });

  it('a CSV of many slices keeps its head and counts all its rows', async () => {
    const buf = Buffer.from('tag,n\n' + 'abcdefgh,1\n'.repeat(1_000_000)); // 11 MB
    const keep = new RowKeeper(2_000_000, 1024 * 1024);
    const [sheet] = await parseDelimited(buf, keep);
    const cut = keep.cut()!.database_size!;
    expect(cut.total).toBe(1_000_001);
    expect(sheet!.rows).toHaveLength(cut.read - 1);
    expect(sheet!.rows.at(-1)).toEqual(['abcdefgh', 1]);
  });
});

describe('markup read whole as a stream', () => {
  it('a page past one 32 MB window is read to its end, with no cut', async () => {
    // The modules of this point (other cases reset them): one sink.
    const { parseMarkupBytes } = await import('./markup');
    const { withReadCutSink: sink } = await import('./read-cut-sink');
    const row = '<p>filler text here</p>\n';
    const html = `<html><body>${row.repeat(Math.ceil((40 * 1024 * 1024) / row.length))}<p>THE-END</p></body></html>`;
    const { value, cuts } = await sink(async () => parseMarkupBytes(Buffer.from(html), 'html'));
    expect(value.endsWith('THE-END')).toBe(true);
    expect(cuts).toEqual({});
  }, 60_000);

  it('text past the cap in the last window is cut, and the cut is said', async () => {
    // The modules of this point (other cases reset them): one sink.
    const { parseMarkupBytes } = await import('./markup');
    const { withReadCutSink: sink } = await import('./read-cut-sink');
    const limit = 32 * 1024 * 1024;
    // Two windows of text, about 40 MB: the cap falls in the second.
    const html = `<p>${'w'.repeat(limit - 16)}</p><p>${'z'.repeat(8 * 1024 * 1024)}</p>`;
    const { value, cuts } = await sink(async () => parseMarkupBytes(Buffer.from(html), 'html'));
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(limit);
    expect(cuts.markup_bytes).toMatchObject({ what: 'bytes', total: html.length, limit });
  }, 60_000);

  it('an XML past one window is read through one parser, to its end', async () => {
    // The modules of this point (other cases reset them): one sink.
    const { parseMarkupBytes } = await import('./markup');
    const { withReadCutSink: sink } = await import('./read-cut-sink');
    const item = '<item><name>n</name></item>';
    const xml = `<?xml version="1.0"?><root>${item.repeat(Math.ceil((40 * 1024 * 1024) / item.length))}<last>THE-END</last></root>`;
    const { value, cuts } = await sink(async () => parseMarkupBytes(Buffer.from(xml), 'xml'));
    expect(value.endsWith('THE-END')).toBe(true);
    expect(value.split('\n')[0]).toBe('n');
    expect(cuts).toEqual({});
  }, 60_000);
});
