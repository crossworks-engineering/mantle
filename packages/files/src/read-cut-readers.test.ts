/**
 * Every reader that cuts says so (docs/files.md, "Read in part"): each input
 * type on generated data, read under a sink the way the parser job reads it,
 * and what the reader said. One case a type: past the cap it says the cut,
 * within it it says nothing.
 */
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { noteReadCut, noteReadCuts, withReadCutSink } from './read-cut-sink';
import { parseXlsx } from './xlsx';
import { parseMarkupBytes } from './markup';
import { parseDwf } from './pipelines/pkg/plot-dwf/dwf';
import { vsdxImages } from './vsdx';
import { notePicturesLeftOut } from './embedded-images';

/** A workbook of generated sheets: `rows` rows of `cols` columns each. */
async function workbook(
  sheets: Array<{ name: string; rows: number; cols: number; cell?: string }>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (let r = 0; r < s.rows; r++) {
      ws.addRow(Array.from({ length: s.cols }, (_, c) => `${s.cell ?? 'v'}${r}-${c}`));
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('xlsx: rows, columns and sheets past the text caps', () => {
  it('a sheet past 5,000 rows says how many of how many rows are in the text', async () => {
    const buf = await workbook([{ name: 'Big', rows: 6200, cols: 2 }]);
    const { value, cuts } = await withReadCutSink(() => parseXlsx(buf));
    expect(value).toContain('v4999-0');
    expect(value).not.toContain('v5000-0');
    expect(cuts).toEqual({ sheet_rows: { what: 'rows', read: 5000, total: 6200, limit: 5000 } });
  });

  it('a sheet past 256 columns says its columns', async () => {
    const buf = await workbook([{ name: 'Wide', rows: 2, cols: 300 }]);
    const { cuts } = await withReadCutSink(() => parseXlsx(buf));
    expect(cuts.sheet_columns).toEqual({ what: 'columns', read: 256, total: 300, limit: 256 });
  });

  it('sheets past the 1,000,000-character text say how many sheets are whole in it', async () => {
    const cell = 'x'.repeat(190);
    const buf = await workbook([
      { name: 'A', rows: 2000, cols: 1, cell },
      { name: 'B', rows: 2000, cols: 1, cell },
      { name: 'C', rows: 2000, cols: 1, cell },
    ]);
    const { cuts } = await withReadCutSink(() => parseXlsx(buf));
    // A and B are about 400,000 characters each: C goes in part.
    expect(cuts.sheet_text).toMatchObject({ what: 'sheets', read: 2, total: 3 });
  }, 60_000);

  it('a workbook within every cap says nothing', async () => {
    const buf = await workbook([{ name: 'Small', rows: 10, cols: 3 }]);
    expect((await withReadCutSink(() => parseXlsx(buf))).cuts).toEqual({});
  });
});

describe('legacy sheets: the sheets past the cell limit', () => {
  it('says the sheets read of the sheets there were', async () => {
    vi.resetModules();
    vi.doMock('./legacy-sheet', async (orig) => ({
      ...(await orig<typeof import('./legacy-sheet')>()),
      convertLegacySheetToXlsx: async () => ({
        xlsx: await workbook([{ name: 'Kept', rows: 3, cols: 2 }]),
        refused: [
          { name: 'Huge', rows: 2_000, cols: 1_000 },
          { name: 'Huger', rows: 3_000, cols: 1_000 },
        ],
        keptSheets: 1,
      }),
    }));
    try {
      const { readDocumentText } = await import('./read-document');
      const { withReadCutSink: sink } = await import('./read-cut-sink');
      const { value, cuts } = await sink(() => readDocumentText(Buffer.from('xls'), 'xls'));
      expect(value).toContain('[Left out for size:');
      expect(cuts.legacy_cells).toEqual({
        what: 'sheets',
        read: 1,
        total: 3,
        limit: 1_000_000,
      });
    } finally {
      vi.doUnmock('./legacy-sheet');
      vi.resetModules();
    }
  });
});

describe('html and xml: the bytes past 32 MB', () => {
  it('says the bytes read of the bytes there were', () => {
    const limit = 32 * 1024 * 1024;
    const bytes = Buffer.alloc(limit + 4096, 'a');
    let out = '';
    return withReadCutSink(async () => {
      out = parseMarkupBytes(bytes, 'html');
    }).then(({ cuts }) => {
      expect(out.length).toBeGreaterThan(0);
      expect(cuts.markup_bytes).toEqual({
        what: 'bytes',
        read: limit,
        total: limit + 4096,
        limit,
      });
    });
  }, 60_000);

  it('a page within it says nothing', async () => {
    const { cuts } = await withReadCutSink(async () =>
      parseMarkupBytes(Buffer.from('<p>small</p>'), 'html'),
    );
    expect(cuts).toEqual({});
  });
});

/** A DWF plot set of `sheets` sheets; `bigStream` sheets carry a drawing
 *  stream past the 16 MB scan. */
async function dwf(sheets: number, bigStream = 0): Promise<Buffer> {
  const zip = new JSZip();
  const name = (i: number) =>
    `com.autodesk.dwf.ePlot_AAAA0000-0000-0000-0000-${String(i).padStart(12, '0')}`;
  zip.file(
    'manifest.xml',
    `<?xml version="1.0"?><dwf:Manifest xmlns:dwf="x">` +
      Array.from(
        { length: sheets },
        (_, i) => `<dwf:Section name="${name(i)}" title="Sheet ${i + 1}"/>`,
      ).join('') +
      `</dwf:Manifest>`,
  );
  for (let i = 0; i < sheets; i++) {
    zip.file(`${name(i)}/descriptor.xml`, `<ePlot:Section xmlns:ePlot="x"></ePlot:Section>`);
    zip.file(
      `${name(i)}/sheet.w2d`,
      i < bigStream
        ? Buffer.alloc(17 * 1024 * 1024, 0x20)
        : Buffer.from(`(Layer 1 'L${i}')'TAG-${i}'V`, 'latin1'),
    );
  }
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return Buffer.concat([Buffer.from('(DWF V06.20)', 'latin1'), archive]);
}

describe('DWF: sheets past 64, and a stream past the scan', () => {
  it('says the sheets read of the sheets the set names', async () => {
    const { value, cuts } = await withReadCutSink(async () => parseDwf(await dwf(70)));
    expect(value).toContain('64 sheets');
    expect(cuts.dwf_sheets).toEqual({ what: 'sheets', read: 64, total: 70, limit: 64 });
  });

  it('says the sheets scanned in part', async () => {
    const { cuts } = await withReadCutSink(async () => parseDwf(await dwf(3, 1)));
    expect(cuts.dwf_scan).toEqual({ what: 'sheets', read: 2, total: 3 });
    expect(cuts.dwf_sheets).toBeUndefined();
  }, 60_000);

  it('a small set says nothing', async () => {
    expect((await withReadCutSink(async () => parseDwf(await dwf(2)))).cuts).toEqual({});
  });
});

describe('Visio: pictures past their size', () => {
  it('says the pictures left out for size', async () => {
    const zip = new JSZip();
    zip.file('visio/media/image1.png', Buffer.alloc(33 * 1024 * 1024, 0));
    zip.file('visio/media/image2.png', Buffer.from('not a big picture'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const { value, cuts } = await withReadCutSink(() => vsdxImages(bytes));
    expect(value).toHaveLength(1);
    expect(cuts.pictures_large).toEqual({ what: 'pictures', read: 1, total: 2 });
  }, 60_000);
});

describe('pictures: what the gate left out (the cap and the answer budget are data.images)', () => {
  it('one cut a reason, of the pictures but the duplicates', async () => {
    const result = {
      images: [],
      candidates: 20,
      rejected: { too_small: 5, metafile: 2, duplicate: 3, over_cap: 1, answer_budget: 1 },
    };
    const { value, cuts } = await withReadCutSink(async () => notePicturesLeftOut(result));
    expect(value).toBe(result);
    expect(cuts).toEqual({
      pictures_small: { what: 'pictures', read: 12, total: 17 },
      pictures_metafile: { what: 'pictures', read: 15, total: 17 },
    });
  });

  it('duplicates alone are no cut', async () => {
    const { cuts } = await withReadCutSink(async () =>
      notePicturesLeftOut({ images: [], candidates: 4, rejected: { duplicate: 3 } }),
    );
    expect(cuts).toEqual({});
  });
});

describe('the sink', () => {
  it('a key named like an inherited property is a cut of its own', async () => {
    const { cuts } = await withReadCutSink(async () => {
      noteReadCut('constructor', { what: 'rows', read: 1, total: 2 });
    });
    expect(cuts).toEqual({ constructor: { what: 'rows', read: 1, total: 2 } });
  });

  it('a note that left nothing out is no cut', async () => {
    const { cuts } = await withReadCutSink(async () => {
      noteReadCut('sheet_rows', { what: 'rows', read: 5, total: 5 });
      noteReadCuts({ markup_bytes: { what: 'bytes', read: 9, total: 3 } });
    });
    expect(cuts).toEqual({});
  });

  it('two reads at once keep their own cuts', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const [a, b] = await Promise.all([
      withReadCutSink(async () => {
        await tick();
        noteReadCut('sheet_rows', { what: 'rows', read: 1, total: 2 });
        await tick();
      }),
      withReadCutSink(async () => {
        noteReadCut('markup_bytes', { what: 'bytes', read: 3, total: 4 });
        await tick();
      }),
    ]);
    expect(Object.keys(a.cuts)).toEqual(['sheet_rows']);
    expect(Object.keys(b.cuts)).toEqual(['markup_bytes']);
  });
});
