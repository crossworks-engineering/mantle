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
