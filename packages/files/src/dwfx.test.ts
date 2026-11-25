/**
 * The DWFx fixtures below are MADE UP with jszip in the test, never a client
 * file: a real DWFx names its plant's drawings and tags, and this repo is
 * public. They follow the XPS package layout of a DWFx: a `.fdseq` naming a
 * `.fdoc`, the `.fdoc` naming its `.fpage` parts, a DWF `manifest.xml` whose
 * Sections give the sheet titles, a `descriptor.xml` beside each page, and
 * the page text in `Glyphs` `UnicodeString` attributes.
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  dwfxToGrids,
  glyphRuns,
  parseDwfx,
  parseDwfxStructured,
} from './pipelines/pkg/plot-dwf/dwfx';
import { DWFX_DESCRIPTION, step } from './pipelines/pkg/plot-dwf/step';
import { readDocumentText } from './read-document';
import { withReadCutSink } from './read-cut-sink';
import {
  INGESTABLE_EXTS,
  exportHintForExt,
  extractWeightOfExt,
  isDrawingExt,
  mimeForExt,
  parserRouteForExt,
} from './slug';

const DOC = 'dwf/documents/DOC1';
const sec = (i: number) => `com.autodesk.dwf.ePlot_S${i}`;
const pagePath = (i: number) => `sections/${sec(i)}/S${i}.fpage`;

function fpage(runs: string[]): string {
  const glyphs = runs
    .map((r) => `<Glyphs FontUri="/Resources/Fonts/F1.odttf" OriginX="10" UnicodeString="${r}"/>`)
    .join('');
  return `<FixedPage xmlns="http://schemas.microsoft.com/xps/2005/06" Width="1000" Height="700"><Canvas><Path Data="M 0,0 L 100,100"/>${glyphs}</Canvas></FixedPage>`;
}

type Opts = {
  pages?: number;
  /** Runs on page i (1-based). */
  runs?: (i: number) => string[];
  seq?: boolean;
  fdoc?: boolean;
  manifest?: boolean;
  /** Pages the fdoc names that are not in the package. */
  missing?: number[];
  /** A page part outside the fdoc's names. */
  stray?: boolean;
};

async function dwfx(opts: Opts = {}): Promise<Buffer> {
  const n = opts.pages ?? 2;
  const runs = opts.runs ?? ((i: number) => [`SHEET ${i} TEXT`]);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('_rels/.rels', '<Relationships/>');
  zip.file('Resources/Fonts/F1.odttf', Buffer.alloc(64, 1));
  if (opts.stray) zip.file('stray/S0.fpage', fpage(['STRAY']));
  if (opts.seq !== false) {
    zip.file(
      'FixedDocumentSequence.fdseq',
      `<FixedDocumentSequence><DocumentReference Source="/${DOC}/FixedDocument.fdoc"/></FixedDocumentSequence>`,
    );
  }
  // The fdoc names the pages last first, so the order is the fdoc's, not
  // the part names'.
  const order = Array.from({ length: n }, (_v, k) => n - k);
  if (opts.fdoc !== false) {
    const refs = [...order, ...(opts.missing ?? [])]
      .map((i) => `<PageContent Source="${pagePath(i)}"/>`)
      .join('');
    zip.file(`${DOC}/FixedDocument.fdoc`, `<FixedDocument>${refs}</FixedDocument>`);
  }
  if (opts.manifest !== false) {
    // Sheet 1 is found by its resource href, every other sheet by its
    // Section name as the page's folder.
    const sections = order
      .map((i) => {
        const res =
          i === 1
            ? `<dwf:Resources><dwf:Resource role="2d vector graphics" href="${pagePath(i)}"/></dwf:Resources>`
            : '<dwf:Resources/>';
        return `<dwf:Section type="com.autodesk.dwf.ePlot" name="${sec(i)}" title="M-10${i} Rev ${i}">${res}</dwf:Section>`;
      })
      .join('');
    zip.file(
      `${DOC}/manifest.xml`,
      `<dwf:Manifest xmlns:dwf="DWF-Manifest:7.0"><dwf:Sections>${sections}</dwf:Sections></dwf:Manifest>`,
    );
  }
  for (let i = 1; i <= n; i += 1) {
    zip.file(`${DOC}/${pagePath(i)}`, fpage(runs(i)));
    zip.file(
      `${DOC}/sections/${sec(i)}/descriptor.xml`,
      `<ePlot:Page><ePlot:Properties><ePlot:Property name="File Name" value="plant-${i}.dwg"/>` +
        `<ePlot:Property value="Layout${i}" name="Layout Name"/><ePlot:Property name="Author" value="drafter"/></ePlot:Properties></ePlot:Page>`,
    );
    zip.file(`${DOC}/sections/${sec(i)}/S${i}.tif`, Buffer.alloc(256, 7));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('glyphRuns', () => {
  it('reads every UnicodeString in order, decoded', () => {
    const xml =
      '<FixedPage><Glyphs UnicodeString="DRAWING NO."/><Glyphs UnicodeString="{}{TAG-1}"/>' +
      '<Glyphs UnicodeString=\'P&amp;ID 100-A\'/><Glyphs UnicodeString="A>B &#x2205; 50"/>' +
      '<Glyphs Indices="1;2;3"/><Glyphs UnicodeString="   "/><Path Data="M 0,0"/></FixedPage>';
    expect(glyphRuns(xml)).toEqual(['DRAWING NO.', '{TAG-1}', 'P&ID 100-A', 'A>B ∅ 50']);
  });
});

describe('parseDwfx digest', () => {
  it('gives each sheet its title, facts and text, in the fdoc page order', async () => {
    const text = await parseDwfx(await dwfx());
    expect(text).toContain('DWFx drawing set, 2 sheets.');
    // Sheet 2 by its folder, sheet 1 by its href; the fdoc names 2 first.
    expect(text.indexOf('## Sheet M-102 Rev 2')).toBeGreaterThan(0);
    expect(text.indexOf('## Sheet M-101 Rev 1')).toBeGreaterThan(text.indexOf('M-102'));
    expect(text).toContain('source drawing: plant-1.dwg · layout: Layout1 · author: drafter');
    expect(text).toContain('Text (1 runs): SHEET 1 TEXT');
    expect(text).not.toContain('—');
  });

  it('is what the text read gives for a .dwfx', async () => {
    const bytes = await dwfx();
    expect(await readDocumentText(bytes, 'dwfx')).toBe(await parseDwfx(bytes));
  });

  it('with no sequence, reads the fdoc; with neither, every page by name', async () => {
    const noSeq = await parseDwfx(await dwfx({ seq: false }));
    expect(noSeq.indexOf('M-102')).toBeLessThan(noSeq.indexOf('M-101'));
    const byName = await parseDwfx(
      await dwfx({ seq: false, fdoc: false, manifest: false, pages: 10 }),
    );
    // Numeric name order: page 2 before page 10.
    expect(byName.indexOf('SHEET 2 TEXT')).toBeLessThan(byName.indexOf('SHEET 10 TEXT'));
    expect(byName).toContain('## Sheet 1\n');
  });

  it('names a sheet with no text, and gives nothing for a set with no text or title', async () => {
    const some = await parseDwfx(await dwfx({ runs: (i) => (i === 1 ? [] : ['X']) }));
    expect(some).toContain('No text on this sheet');
    expect(await parseDwfx(await dwfx({ manifest: false, runs: () => [] }))).toBe('');
  });

  it("gives '' for bytes that are not a DWFx", async () => {
    expect(await parseDwfx(Buffer.from('not a zip at all'))).toBe('');
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    expect(await parseDwfx(await zip.generateAsync({ type: 'nodebuffer' }))).toBe('');
    expect(await readDocumentText(Buffer.from('plain'), 'dwfx')).toBe('');
  });
});

describe('a damaged DWFx', () => {
  it('a zip that cannot be opened throws a named error', async () => {
    const bytes = await dwfx();
    await expect(parseDwfx(bytes.subarray(0, Math.floor(bytes.length / 2)))).rejects.toThrow(
      /dwfx: no readable ZIP archive/,
    );
    const junk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 9)]);
    await expect(readDocumentText(junk, 'dwfx')).rejects.toThrow(/dwfx: no readable ZIP/);
  });

  it('a missing page is said on the sheet and in the cuts', async () => {
    const bytes = await dwfx({ missing: [9] });
    const { value, cuts } = await withReadCutSink(() => parseDwfx(bytes));
    expect(value).toContain('DWFx drawing set, 3 sheets.');
    expect(value).toContain('This sheet could not be read');
    expect(cuts.dwfx_pages).toEqual({ what: 'sheets', read: 2, total: 3, limit: 256 });
  });

  it('a set whose every page is missing throws', async () => {
    // A page is in the package, but not where the fdoc says.
    const bytes = await dwfx({ pages: 0, missing: [1, 2], stray: true });
    await expect(parseDwfx(bytes)).rejects.toThrow(/dwfx: none of the 2 pages/);
  });
});

describe('DWFx caps say what was left out', () => {
  it('sheets past 256', async () => {
    const bytes = await dwfx({ pages: 260, manifest: false });
    const { value, cuts } = await withReadCutSink(() => parseDwfx(bytes));
    expect(value).toContain('DWFx drawing set, 260 sheets.');
    expect(value.match(/^## Sheet /gm)).toHaveLength(256);
    expect(cuts.dwfx_pages).toEqual({ what: 'sheets', read: 256, total: 260, limit: 256 });
  });

  it('text past 20,000 characters a sheet', async () => {
    const long = Array.from({ length: 300 }, (_v, k) => `RUN-${k}-${'x'.repeat(90)}`);
    const bytes = await dwfx({ pages: 1, runs: () => long });
    const { value, cuts } = await withReadCutSink(() => parseDwfx(bytes));
    expect(value).toMatch(/… and \d+ more$/);
    expect(cuts.dwfx_text?.total).toBe(300);
    expect(cuts.dwfx_text?.read).toBeLessThan(300);
  });

  it('a small set says nothing', async () => {
    expect((await withReadCutSink(async () => parseDwfx(await dwfx()))).cuts).toEqual({});
  });
});

describe('the plot-dwf step on a DWFx: the file database', () => {
  const run = async (bytes: Buffer) =>
    step({} as never, { bytes: async () => bytes } as never) as unknown as Promise<{
      status: string;
      calls?: Array<{ input: { tabs: unknown[]; description?: string } }>;
    }>;

  it('writes Sheets and Texts, every run in page order', async () => {
    const out = await run(await dwfx({ runs: (i) => [`A${i}`, `B${i}`] }));
    expect(out.status).toBe('ok');
    const input = out.calls![0]!.input;
    expect(input.description).toBe(DWFX_DESCRIPTION);
    const [sheets, texts] = input.tabs as Array<{ name: string; rows: unknown[][] }>;
    expect(sheets!.name).toBe('Sheets');
    expect(sheets!.rows).toEqual([
      ['M-102 Rev 2', 1, 'plant-2.dwg', 'Layout2', 'drafter', 2, 'read'],
      ['M-101 Rev 1', 2, 'plant-1.dwg', 'Layout1', 'drafter', 2, 'read'],
    ]);
    expect(texts!.name).toBe('Texts');
    expect(texts!.rows).toEqual([
      ['M-102 Rev 2', 1, 1, 'A2'],
      ['M-102 Rev 2', 1, 2, 'B2'],
      ['M-101 Rev 1', 2, 1, 'A1'],
      ['M-101 Rev 1', 2, 2, 'B1'],
    ]);
  });

  it('keeps every run, with no character budget', async () => {
    const long = Array.from({ length: 300 }, (_v, k) => `RUN-${k}-${'x'.repeat(90)}`);
    const parsed = await parseDwfxStructured(await dwfx({ pages: 1, runs: () => long }));
    expect(dwfxToGrids(parsed!.sheets)[1]!.rows).toHaveLength(300);
  });

  it('a missing page is a row that says so', async () => {
    const out = await run(await dwfx({ missing: [9] }));
    const [sheets] = out.calls![0]!.input.tabs as Array<{ rows: unknown[][] }>;
    expect(sheets!.rows[2]).toEqual(['Sheet 3', 3, null, null, null, 0, 'missing or damaged']);
  });

  it('not a DWFx: ok with no call; no text and no title: no tabs', async () => {
    expect(await run(Buffer.from('plain'))).toEqual({ status: 'ok' });
    const blank = await run(await dwfx({ manifest: false, runs: () => [] }));
    expect(blank.calls![0]!.input).toEqual({ tabs: [] });
  });

  it('a renamed DWFx (.dwf) is read as a DWFx, by the step and the text read', async () => {
    const bytes = await dwfx();
    const out = await run(bytes);
    expect(out.calls![0]!.input.description).toBe(DWFX_DESCRIPTION);
    expect(await readDocumentText(bytes, 'dwf')).toBe(await parseDwfx(bytes));
  });

  it('a damaged DWFx fails the job with a named error', async () => {
    const bytes = await dwfx();
    await expect(run(bytes.subarray(0, 100))).rejects.toThrow(/dwfx: no readable ZIP/);
  });
});

describe('dwfx routing', () => {
  it('is ingestable, on its own route, in the DWF lane, with no export hint', () => {
    expect(INGESTABLE_EXTS.has('dwfx')).toBe(true);
    expect(parserRouteForExt('dwfx')).toBe('dwfx');
    expect(exportHintForExt('dwfx')).toBeUndefined();
    expect(isDrawingExt('dwfx')).toBe(false);
    expect(extractWeightOfExt('dwfx')).toBe('heavy');
    expect(mimeForExt('dwfx')).toBe('model/vnd.dwfx+xps');
  });
});
