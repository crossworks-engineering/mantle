/**
 * anydoc (./anydoc.ts) through the real native addon, on fixtures built here:
 * RTF is plain text, an ODT is a small zip, and a workbook comes from exceljs
 * (anydoc reads `.xls`/`.xlsb` with the same spreadsheet reader, so an
 * `.xlsx` exercises the sheet path). The legacy binaries themselves (.doc,
 * .ppt, BIFF .xls) were compared against Tika on real files outside the
 * suite; see the CHANGELOG entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { anydocSheets, parseAnydocBytes } from './anydoc';
import { convertLegacySheetToXlsx } from './legacy-sheet';
import { parseDocumentBytes } from './parse';
import { workbookBuffer } from './sheet-fixtures.test-helper';

const RTF = String.raw`{\rtf1\ansi{\fonttbl{\f0 Arial;}}\f0 Pump {\b P-101} seal replaced.\par Second line.\par}`;

async function odt(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
  );
  const body = paragraphs.map((p) => `<text:p>${p}</text:p>`).join('');
  zip.file(
    'content.xml',
    `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

const ORIGINAL_TIKA_URL = process.env.TIKA_URL;
beforeEach(() => {
  // Tika off: these tests are about the in-process path alone.
  delete process.env.TIKA_URL;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_TIKA_URL == null) delete process.env.TIKA_URL;
  else process.env.TIKA_URL = ORIGINAL_TIKA_URL;
});

describe('parseAnydocBytes', () => {
  it('reads RTF as Markdown, bold kept', async () => {
    const md = await parseAnydocBytes(Buffer.from(RTF), 'rtf');
    expect(md).toContain('**P-101**');
    expect(md).toContain('Second line.');
  });

  it('reads an ODT', async () => {
    const md = await parseAnydocBytes(await odt(['First.', 'Second.']), 'odt');
    expect(md).toBe('First.\n\nSecond.');
  });

  it('throws with a code on bytes it cannot read', async () => {
    await expect(parseAnydocBytes(Buffer.from('not a document'), 'doc')).rejects.toMatchObject({
      code: expect.any(String),
    });
  });

  it('refuses an extension it was not set up for', async () => {
    await expect(parseAnydocBytes(Buffer.from('x'), 'pdf')).rejects.toThrow(/no format/);
  });

  it('never calls the network (hosted OCR stays off)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await parseAnydocBytes(Buffer.from(RTF), 'rtf');
    await parseAnydocBytes(Buffer.from('junk'), 'doc').catch(() => null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('parseDocumentBytes on anydoc formats, Tika off', () => {
  it('reads them in-process', async () => {
    await expect(parseDocumentBytes(Buffer.from(RTF), 'rtf')).resolves.toContain('P-101');
    await expect(parseDocumentBytes(await odt(['Hello.']), 'odt')).resolves.toBe('Hello.');
  });

  it("throws anydoc's own error rather than an empty document", async () => {
    await expect(parseDocumentBytes(Buffer.from('junk'), 'doc')).rejects.toMatchObject({
      code: expect.any(String),
    });
  });
});

describe('anydocSheets and the legacy-sheet conversion', () => {
  it('gives each sheet its name and its rows', async () => {
    const bytes = await workbookBuffer({
      Orders: [
        ['Tag', 'Qty'],
        ['P-101', 4],
      ],
      Notes: [['Checked']],
    });
    const sheets = await anydocSheets(bytes, 'xls');
    expect(sheets.map((s) => s.name)).toEqual(['Orders', 'Notes']);
    expect(sheets[0]!.rows).toEqual([
      ['Tag', 'Qty'],
      ['P-101', '4'],
    ]);
  });

  it('converts without Tika, numbers kept numeric', async () => {
    const bytes = await workbookBuffer({
      Orders: [
        ['Tag', 'Qty'],
        ['P-101', 4],
      ],
    });
    const xlsx = await convertLegacySheetToXlsx(bytes, 'application/vnd.ms-excel');
    expect(xlsx).not.toBeNull();
    const text = await parseDocumentBytes(xlsx!, 'xlsx');
    expect(text).toContain('P-101');
    expect(text).toContain('4');
  });

  it('returns null for a file neither reader can open (Tika off)', async () => {
    expect(
      await convertLegacySheetToXlsx(Buffer.from('junk'), 'application/vnd.ms-excel'),
    ).toBeNull();
  });
});
