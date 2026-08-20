/**
 * Renderer smoke/regression tests for the Office-export path: a page/note
 * ProseMirror doc → valid .docx, and a typed TableDoc → valid .xlsx that
 * re-opens with the right cells, number formats, and totals row.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { renderDocx } from './render-docx';
import { renderXlsx, renderXlsxWorkbook } from './render-xlsx';
import { markdownToDoc } from './markdown-to-doc';
import { tableDocFromGrid } from './table-model';

const PK = Buffer.from('PK'); // OOXML files are zip archives

describe('renderDocx', () => {
  it('produces a valid .docx from a markdown-derived doc', async () => {
    const md = [
      '# Quarterly Plan',
      '',
      'Some **bold** and *italic* and `code` and a [link](https://example.com).',
      '',
      '- one',
      '- two',
      '  - nested',
      '',
      '1. first',
      '2. second',
      '',
      '> a quote',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[Draft] --> B[Ship]',
      '```',
    ].join('\n');
    const buf = await renderDocx(markdownToDoc(md), { title: 'Quarterly Plan' });
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 2).equals(PK)).toBe(true);
  });

  it('handles an empty doc without throwing', async () => {
    const buf = await renderDocx({ type: 'doc', content: [] }, { title: 'Empty' });
    expect(buf.subarray(0, 2).equals(PK)).toBe(true);
  });

  // A drawing's stored snapshot is SVG, which ImageRun cannot embed, so it
  // reaches Word only through `loadDraw`. Zip entry names are stored
  // uncompressed, so the presence of an embedded picture is readable straight
  // off the archive bytes without unpacking it.
  const DRAW_DOC = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
      { type: 'image', attrs: { drawId: 'd-1', alt: 'Architecture' } },
    ],
  };
  const hasMedia = (buf: Buffer) => buf.includes('word/media/');

  it('embeds an embedded drawing as a raster when loadDraw supplies one', async () => {
    const calls: string[] = [];
    const buf = await renderDocx(DRAW_DOC, {
      loadDraw: async (drawId) => {
        calls.push(drawId);
        return { bytes: fakePng(1200, 800), width: 600, height: 400 };
      },
    });
    expect(calls).toEqual(['d-1']);
    expect(hasMedia(buf)).toBe(true);
  });

  it('degrades to the placeholder when no loadDraw is injected', async () => {
    const buf = await renderDocx(DRAW_DOC, {});
    expect(buf.subarray(0, 2).equals(PK)).toBe(true);
    expect(hasMedia(buf)).toBe(false);
  });

  it('degrades to the placeholder when the drawing has nothing to raster', async () => {
    // A drawing with no committed snapshot, and a loader that throws (the
    // sidecar being down): both must produce a document, not an exception.
    expect(hasMedia(await renderDocx(DRAW_DOC, { loadDraw: async () => null }))).toBe(false);
    expect(
      hasMedia(
        await renderDocx(DRAW_DOC, {
          loadDraw: async () => {
            throw new Error('sidecar unreachable');
          },
        }),
      ),
    ).toBe(false);
  });

  it('resolves a drawing embedded twice only once', async () => {
    const calls: string[] = [];
    await renderDocx(
      { type: 'doc', content: [...DRAW_DOC.content, DRAW_DOC.content[1]] },
      {
        loadDraw: async (drawId) => {
          calls.push(drawId);
          return { bytes: fakePng(100, 100) };
        },
      },
    );
    // One browser session per drawing, not per occurrence.
    expect(calls).toEqual(['d-1']);
  });
});

/** Smallest thing the renderer's dimension probe accepts as a PNG: the
 *  signature plus an IHDR carrying the size. The bytes are never decoded —
 *  docx stores the picture verbatim. */
function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('renderXlsx', () => {
  it('produces a valid .xlsx with typed cells and a totals row', async () => {
    const doc = tableDocFromGrid({
      columns: [
        { name: 'Item', type: 'text' },
        { name: 'Price', type: 'currency' },
      ],
      rows: [
        ['Widget', 9.5],
        ['Gadget', 12],
      ],
    });
    doc.aggregates = { [doc.columns[1]!.id]: 'sum' };

    const buf = await renderXlsx(doc, { title: 'Stock list' });
    expect(buf.subarray(0, 2).equals(PK)).toBe(true);

    // Re-open and assert structure.
    const wb = new ExcelJS.Workbook();
    // Cast to ExcelJS's expected buffer type: @types/node's generic `Buffer<…>`
    // resolves differently across the tree's multiple @types/node versions, so
    // a plain Buffer trips the checker even though it's correct at runtime.
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.getWorksheet('Stock list')!;
    expect(ws).toBeTruthy();
    expect(ws.getRow(1).getCell(1).value).toBe('Item');
    expect(ws.getRow(1).getCell(2).value).toBe('Price');
    // Data rows keep numbers numeric.
    expect(ws.getRow(2).getCell(2).value).toBe(9.5);
    // Totals row sums the currency column.
    const last = ws.lastRow!;
    expect(last.getCell(1).value).toBe('Totals');
    expect(last.getCell(2).value).toBe(21.5);
    // Currency cells carry a number format.
    expect(String(ws.getRow(2).getCell(2).numFmt)).toContain('USD');
  });

  it('handles a table with no columns', async () => {
    const doc = tableDocFromGrid({ columns: [], rows: [] });
    const buf = await renderXlsx(doc);
    expect(buf.subarray(0, 2).equals(PK)).toBe(true);
  });
});

/** Re-open rendered bytes as a workbook. The cast is the same one the suite
 *  already uses: @types/node's generic `Buffer<…>` resolves differently across
 *  the tree's multiple @types/node versions. */
async function reopen(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

function fillOf(cell: ExcelJS.Cell): string | undefined {
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  return fill?.type === 'pattern' ? (fill.fgColor?.argb ?? undefined) : undefined;
}

describe('renderXlsxWorkbook — a table is a workbook, not a worksheet', () => {
  const grid = (label: string) =>
    tableDocFromGrid({ columns: [{ name: label, type: 'text' }], rows: [[`${label}-1`]] });

  it('writes one worksheet per tab, in order', async () => {
    const wb = await reopen(
      await renderXlsxWorkbook([
        { name: 'Income', doc: grid('Source') },
        { name: 'Expenses', doc: grid('Item') },
        { name: 'Notes', doc: grid('Note') },
      ]),
    );
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Income', 'Expenses', 'Notes']);
    expect(wb.getWorksheet('Expenses')!.getRow(1).getCell(1).value).toBe('Item');
  });

  it('suffixes tabs that collide after sanitising, rather than throwing', async () => {
    // Excel forbids `/` and caps names at 31 chars, so these three distinct tab
    // names all sanitise to the same thing. Excel also refuses duplicate sheet
    // names, so without the suffix the whole download would fail.
    const wb = await reopen(
      await renderXlsxWorkbook([
        { name: 'Q1/Q2', doc: grid('a') },
        { name: 'Q1?Q2', doc: grid('b') },
        { name: 'Q1[Q2]', doc: grid('c') },
      ]),
    );
    const names = wb.worksheets.map((w) => w.name);
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toBe('Q1 Q2');
  });

  it('still produces a valid workbook when there are no sheets at all', async () => {
    const wb = await reopen(await renderXlsxWorkbook([]));
    expect(wb.worksheets).toHaveLength(1);
  });
});

describe('renderXlsx — house style', () => {
  const styled = () => {
    const doc = tableDocFromGrid({
      columns: [
        { name: 'Item', type: 'text' },
        { name: 'Qty', type: 'number' },
        { name: 'Done', type: 'checkbox' },
        { name: 'When', type: 'date' },
        { name: 'Link', type: 'url' },
      ],
      rows: [
        ['Widget', 2, true, '2026-01-15', 'https://example.com/a'],
        ['Gadget', 3, false, '2026-02-20', 'not a url'],
        ['Doohickey', 4, true, '2026-03-25', 'https://example.com/c'],
      ],
    });
    return doc;
  };

  it('freezes and filters the header, and paints it', async () => {
    const ws = (await reopen(await renderXlsx(styled()))).worksheets[0]!;
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    // Filter spans the header + 3 data rows, never the totals row. exceljs
    // hands the range back as an A1 string once it has been through a file.
    expect(ws.autoFilter).toBe('A1:E4');
    const header = ws.getRow(1).getCell(1);
    expect(header.font?.bold).toBe(true);
    expect(fillOf(header)).toBe('FF1F2937');
  });

  it('bands alternate data rows and leaves the rest unfilled', async () => {
    const ws = (await reopen(await renderXlsx(styled()))).worksheets[0]!;
    expect(fillOf(ws.getRow(2).getCell(1))).toBeUndefined(); // first data row
    expect(fillOf(ws.getRow(3).getCell(1))).toBe('FFF5F6F8'); // second, banded
    expect(fillOf(ws.getRow(4).getCell(1))).toBeUndefined();
  });

  it('gives dates a real date cell with an unambiguous format', async () => {
    const ws = (await reopen(await renderXlsx(styled()))).worksheets[0]!;
    const cell = ws.getRow(2).getCell(4);
    expect(cell.value).toBeInstanceOf(Date);
    expect(String(cell.numFmt)).toBe('yyyy-mm-dd');
  });

  it('makes a navigable url clickable and leaves anything else as text', async () => {
    const ws = (await reopen(await renderXlsx(styled()))).worksheets[0]!;
    expect(ws.getRow(2).getCell(5).value).toMatchObject({ hyperlink: 'https://example.com/a' });
    expect(ws.getRow(3).getCell(5).value).toBe('not a url');
  });

  it('aligns by type — numbers right, checkboxes centred, text left', async () => {
    const ws = (await reopen(await renderXlsx(styled()))).worksheets[0]!;
    expect(ws.getRow(2).getCell(1).alignment?.horizontal).toBe('left');
    expect(ws.getRow(2).getCell(2).alignment?.horizontal).toBe('right');
    expect(ws.getRow(2).getCell(3).alignment?.horizontal).toBe('center');
  });

  it('sizes a money column for what it DISPLAYS, not what it stores', async () => {
    // Regression: `12500` is 5 characters stored and `USD 12,500.00` is 13
    // displayed. Sized to the stored value the column shows ####### on open,
    // and the totals row is wider still than any row it sums.
    const doc = tableDocFromGrid({
      columns: [
        { name: 'Ref', type: 'text' },
        { name: 'Amount', type: 'currency' },
      ],
      rows: [
        ['a', 12500],
        ['b', 33100],
      ],
    });
    doc.aggregates = { [doc.columns[1]!.id]: 'sum' };
    const ws = (await reopen(await renderXlsx(doc))).worksheets[0]!;
    // 'USD 45,600.00' is 13 chars; the column must clear that, not 'Amount'.
    expect(ws.getColumn(2).width!).toBeGreaterThanOrEqual(13);
  });

  it('sizes columns from their contents, within bounds', async () => {
    const doc = tableDocFromGrid({
      columns: [
        { name: 'id', type: 'text' },
        { name: 'notes', type: 'text' },
      ],
      rows: [['1', 'x'.repeat(300)]],
    });
    const ws = (await reopen(await renderXlsx(doc))).worksheets[0]!;
    expect(ws.getColumn(1).width).toBe(10); // short content clamps up to the floor
    expect(ws.getColumn(2).width).toBe(60); // a 300-char cell clamps to the ceiling
  });
});

describe('renderXlsx — totals row', () => {
  it('labels the first column WITHOUT an aggregate, so a leading total survives', async () => {
    // Regression: the label was written on a falsy check, so a first column
    // whose sum came to 0 had its total replaced by the word "Totals".
    const doc = tableDocFromGrid({
      columns: [
        { name: 'Delta', type: 'number' },
        { name: 'Name', type: 'text' },
      ],
      rows: [
        [5, 'a'],
        [-5, 'b'],
      ],
    });
    doc.aggregates = { [doc.columns[0]!.id]: 'sum' };
    const ws = (await reopen(await renderXlsx(doc))).worksheets[0]!;
    const last = ws.lastRow!;
    expect(last.getCell(1).value).toBe(0); // the total, not the label
    expect(last.getCell(2).value).toBe('Totals');
  });

  it('does not give a row COUNT the money format of its column', async () => {
    const doc = tableDocFromGrid({
      columns: [
        { name: 'Item', type: 'text' },
        { name: 'Price', type: 'currency' },
      ],
      rows: [
        ['Widget', 9.5],
        ['Gadget', 12],
      ],
    });
    doc.aggregates = { [doc.columns[1]!.id]: 'count' };
    const ws = (await reopen(await renderXlsx(doc))).worksheets[0]!;
    const last = ws.lastRow!;
    expect(last.getCell(2).value).toBe(2);
    expect(String(last.getCell(2).numFmt ?? '')).not.toContain('USD');
  });

  it('writes no totals row when every aggregate is none', async () => {
    const doc = tableDocFromGrid({
      columns: [{ name: 'Item', type: 'text' }],
      rows: [['Widget']],
    });
    doc.aggregates = { [doc.columns[0]!.id]: 'none' };
    const ws = (await reopen(await renderXlsx(doc))).worksheets[0]!;
    expect(ws.rowCount).toBe(2); // header + the one data row
  });
});
