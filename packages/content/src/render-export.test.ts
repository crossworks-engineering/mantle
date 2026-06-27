/**
 * Renderer smoke/regression tests for the Office-export path: a page/note
 * ProseMirror doc → valid .docx, and a typed TableDoc → valid .xlsx that
 * re-opens with the right cells, number formats, and totals row.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { renderDocx } from './render-docx';
import { renderXlsx } from './render-xlsx';
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
    ].join('\n');
    const buf = await renderDocx(markdownToDoc(md), { title: 'Quarterly Plan' });
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 2).equals(PK)).toBe(true);
  });

  it('handles an empty doc without throwing', async () => {
    const buf = await renderDocx({ type: 'doc', content: [] }, { title: 'Empty' });
    expect(buf.subarray(0, 2).equals(PK)).toBe(true);
  });
});

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
