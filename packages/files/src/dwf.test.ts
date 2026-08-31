/**
 * The fixture below is SYNTHESISED with jszip, not a trimmed client file — a
 * real DWF names its plant's circuits and drawing numbers on every layer, and
 * this repo is public. It reproduces the container quirks observed on real
 * AutoCAD output, each noted where the fixture builds it:
 *
 *   - ASCII `(DWF V06.20)` magic BEFORE the ZIP archive;
 *   - backslash path separators inside the archive;
 *   - descriptor XML as flat `<ePlot:Property name value/>` attribute soup;
 *   - W2D streams that open with ASCII opcodes and carry annotation labels as
 *     quoted runs with a binary tail (`'2"'V…`).
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseDwf, parseDwfStructured, scrapeW2d, sniffDwf } from './dwf';
import { parseDocumentBytes } from './parse';
import { INGESTABLE_EXTS, exportHintForExt, mimeForExt, parserRouteForExt } from './slug';

const SECTION = 'com.autodesk.dwf.ePlot_AAAA0000-0000-0000-0000-000000000001';

function w2dStream(): Buffer {
  const asciiHead =
    "(W2D V06.00)(Author drafter1)(Creator 'AutoCAD 2026')" +
    "(Layer 1 'Circuit 90000-001-01')(Layer 2 'Circuit 90000-001-01-DL')(Layer 3 'Level 12')" +
    // Duplicate layer id re-selection — must not double-count the name.
    "(Layer 1 'Circuit 90000-001-01')";
  // Binary body stand-in: labels appear as 'text'V with opcode bytes around
  // them; '____'V is a leader-line artifact the scraper must drop, and the
  // quoted-without-V run is opcode payload, not a label.
  const body = Buffer.concat([
    Buffer.from([0x18, 0x02]),
    Buffer.from("'DN150'V", 'latin1'),
    Buffer.from([0x00, 0x7f]),
    Buffer.from("'2\"'V'2\"'V", 'latin1'),
    Buffer.from("'____'V", 'latin1'),
    Buffer.from("('NotALabel')", 'latin1'),
  ]);
  return Buffer.concat([Buffer.from(asciiHead, 'latin1'), body]);
}

async function buildFixture(opts?: { sheets?: boolean }): Promise<Buffer> {
  const zip = new JSZip();
  if (opts?.sheets !== false) {
    zip.file(
      'manifest.xml',
      `<?xml version="1.0"?><dwf:Manifest xmlns:dwf="x">` +
        `<dwf:Section name="com.autodesk.dwf.ePlotGlobal" title="com.autodesk.dwf.ePlotGlobal"/>` +
        `<dwf:Section name="${SECTION}" title="90-10-01 Rev 2"/></dwf:Manifest>`,
    );
    // Backslash separators, exactly as AutoCAD writes them.
    zip.file(
      `${SECTION}\\descriptor.xml`,
      `<ePlot:Section xmlns:ePlot="x">` +
        `<ePlot:Paper units="in" width="16.999999519408217" height="10.999999759704108"/>` +
        `<ePlot:Property name="Title" value="Model" category="AutoCAD Drawing"/>` +
        `<ePlot:Property name="Layout Name" value="Model" category="AutoCAD Drawing"/>` +
        `<ePlot:Property name="File Name" value="90-10-01 Rev 2.dwg" category="AutoCAD Drawing"/>` +
        `<ePlot:Property name="Author" value="drafter1" category="AutoCAD Drawing"/>` +
        `</ePlot:Section>`,
    );
    zip.file(`${SECTION}\\thumb.png`, Buffer.from('89504e47', 'hex'));
    zip.file(`${SECTION}\\sheet.w2d`, w2dStream());
  } else {
    zip.file('manifest.xml', `<dwf:Manifest xmlns:dwf="x"></dwf:Manifest>`);
  }
  const archive = await zip.generateAsync({ type: 'nodebuffer' });
  // The DWF magic sits BEFORE the archive; offsets inside stay archive-relative.
  return Buffer.concat([Buffer.from('(DWF V06.20)', 'latin1'), archive]);
}

describe('sniffDwf', () => {
  it('recognises the container magic and rejects other bytes', async () => {
    expect(sniffDwf(await buildFixture())).toBe(true);
    expect(sniffDwf(Buffer.from('PK\x03\x04rest'))).toBe(false);
  });
});

describe('scrapeW2d', () => {
  it('dedupes layers, counts labels, drops artifacts and non-label quotes', () => {
    const { layers, labels, labelTotal } = scrapeW2d(w2dStream());
    expect(layers).toEqual(['Circuit 90000-001-01', 'Circuit 90000-001-01-DL', 'Level 12']);
    expect(labels).toEqual([
      { text: '2"', count: 2 },
      { text: 'DN150', count: 1 },
    ]);
    expect(labelTotal).toBe(3);
  });
});

describe('parseDwfStructured', () => {
  it('reads sheet identity, source DWG, paper and thumbnail through backslash paths', async () => {
    const parsed = await parseDwfStructured(await buildFixture());
    expect(parsed.version).toBe('V06.20');
    expect(parsed.sheets).toHaveLength(1);
    const s = parsed.sheets[0]!;
    expect(s.title).toBe('90-10-01 Rev 2');
    expect(s.sourceFile).toBe('90-10-01 Rev 2.dwg');
    expect(s.author).toBe('drafter1');
    expect(s.layout).toBe('Model');
    expect(s.paper).toBe('17.0 × 11.0 in');
    expect(s.thumbnailPath).toBe(`${SECTION}/thumb.png`);
    expect(s.layers).toContain('Circuit 90000-001-01');
  });

  it('throws on bytes with no ZIP archive (corrupt, not silently empty)', async () => {
    await expect(parseDwfStructured(Buffer.from('(DWF V06.20)garbage'))).rejects.toThrow(/ZIP/);
  });
});

describe('parseDwf digest', () => {
  it('emits set header, per-sheet block and the cross-sheet layer registry', async () => {
    const digest = await parseDwf(await buildFixture());
    expect(digest).toContain('DWF drawing set (V06.20) — 1 sheet');
    expect(digest).toContain('## Sheet 90-10-01 Rev 2');
    expect(digest).toContain('source drawing: 90-10-01 Rev 2.dwg');
    expect(digest).toContain('2" (×2)');
    expect(digest).toContain('## Layer registry across sheets (3)');
    expect(digest).toContain('Circuit 90000-001-01 — on sheet 90-10-01 Rev 2');
  });

  it('returns "" for a DWF with no 2D sheets (the honest no-text skip)', async () => {
    expect(await parseDwf(await buildFixture({ sheets: false }))).toBe('');
  });

  it('is reachable through the shared dispatcher', async () => {
    const text = await parseDocumentBytes(await buildFixture(), 'dwf');
    expect(text).toContain('DWF drawing set');
  });
});

describe('dwf routing', () => {
  it('dwf is ingestable, routed to the dwf parser, with a model MIME', () => {
    expect(INGESTABLE_EXTS.has('dwf')).toBe(true);
    expect(parserRouteForExt('dwf')).toBe('dwf');
    expect(mimeForExt('dwf')).toBe('model/vnd.dwf');
  });

  it('dwfx stays unreadable but names its recovery move', () => {
    expect(parserRouteForExt('dwfx')).toBe('none');
    expect(exportHintForExt('dwfx')).toMatch(/DWF/);
  });
});
