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
import { createCanvas } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import {
  extractDwfImages,
  parseDwf,
  parseDwfStructured,
  parseDwfToGrids,
  scrapeW2d,
  sniffDwf,
} from './dwf';
import { extractEmbeddedImages, passesGate } from './embedded-images';
import { parseDocumentBytes } from './parse';
import { INGESTABLE_EXTS, exportHintForExt, mimeForExt, parserRouteForExt } from './slug';

const SECTION = 'com.autodesk.dwf.ePlot_AAAA0000-0000-0000-0000-000000000001';

/** A real, sniffable PNG at the exact shape AutoCAD writes DWF thumbnails
 *  (262×170 — under the generic 200 px decoration floor on purpose). Drawn
 *  with enough content to clear the absolute byte floor. */
function thumbnailPng(): Buffer {
  const canvas = createCanvas(262, 170);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 262, 170);
  ctx.strokeStyle = '#333333';
  for (let i = 0; i < 24; i += 1) {
    ctx.strokeRect(4 + i * 3, 4 + (i % 7) * 9, 40 + i, 20 + (i % 5) * 7);
  }
  return canvas.toBuffer('image/png');
}

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
    // UTF-8 bytes on the wire: a German layer tag and a fully Cyrillic label.
    // The scraper must re-decode them, and the Cyrillic one must survive the
    // word-character filter despite having no ASCII alphanumerics.
    Buffer.from("'Kühlkreis'V", 'utf8'),
    Buffer.from("'Отвод'V", 'utf8'),
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
        // Entity in the value, and value BEFORE name on Author: the parser
        // must decode entities and not depend on attribute order.
        `<ePlot:Property name="File Name" value="A&amp;B 90-10-01 Rev 2.dwg" category="AutoCAD Drawing"/>` +
        `<ePlot:Property value="drafter1" name="Author" category="AutoCAD Drawing"/>` +
        `</ePlot:Section>`,
    );
    zip.file(`${SECTION}\\thumb.png`, thumbnailPng());
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
  it('dedupes layers, counts labels, decodes UTF-8, drops artifacts and non-label quotes', () => {
    const { layers, labels, labelTotal } = scrapeW2d(w2dStream());
    expect(layers).toEqual(['Circuit 90000-001-01', 'Circuit 90000-001-01-DL', 'Level 12']);
    expect(labels).toEqual([
      { text: '2"', count: 2 },
      { text: 'DN150', count: 1 },
      { text: 'Kühlkreis', count: 1 },
      { text: 'Отвод', count: 1 },
    ]);
    expect(labelTotal).toBe(5);
  });
});

describe('parseDwfStructured', () => {
  it('reads sheet identity, source DWG, paper and thumbnail through backslash paths', async () => {
    const parsed = await parseDwfStructured(await buildFixture());
    expect(parsed.version).toBe('V06.20');
    expect(parsed.sheets).toHaveLength(1);
    const s = parsed.sheets[0]!;
    expect(s.title).toBe('90-10-01 Rev 2');
    expect(s.sourceFile).toBe('A&B 90-10-01 Rev 2.dwg');
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
    expect(digest).toContain('source drawing: A&B 90-10-01 Rev 2.dwg');
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

  it('a ZIP without the DWF magic (renamed DWFx) is sniff-rejected to ""', async () => {
    const fixture = await buildFixture();
    const bareZip = fixture.subarray('(DWF V06.20)'.length);
    expect(await parseDocumentBytes(bareZip, 'dwf')).toBe('');
  });
});

describe('extractDwfImages (sheet thumbnails)', () => {
  it('yields one essential image per sheet, located by sheet title', async () => {
    const images = await extractDwfImages(await buildFixture());
    expect(images).toHaveLength(1);
    const img = images[0]!;
    expect(img.location?.sheet).toBe('90-10-01 Rev 2');
    expect(img.altText).toBe('Sheet 90-10-01 Rev 2');
    expect(img.essential).toBe(true);
    expect(img.ext).toBe('png');
    expect(img.width).toBe(262);
    expect(img.height).toBe(170);
  });

  it('survives the shared gate despite being under the 200px decoration floor', async () => {
    const { images, rejected } = await extractEmbeddedImages(await buildFixture(), 'dwf');
    expect(images).toHaveLength(1);
    expect(rejected.too_small ?? 0).toBe(0);
    // The same bytes WITHOUT the essential flag are decoration-filtered —
    // the flag, not a loophole, is what keeps the thumbnail.
    const img = images[0]!;
    expect(passesGate({ ...img, essential: false }, new Set())).toEqual({
      keep: false,
      reason: 'too_small',
    });
  });

  it('returns [] for bytes without the DWF magic', async () => {
    expect(await extractDwfImages(Buffer.from('PK\x03\x04nope'))).toEqual([]);
  });

  it('prefers complete sidecar renders, stamps provenance, falls back typed', async () => {
    const renderPng = thumbnailPng();
    vi.stubEnv('MEDIA_SIDECAR_URL', 'http://media.test:8095');
    vi.stubEnv('MEDIA_SIDECAR_TOKEN', 'secret');
    const fetchMock = vi.fn(async (url: unknown, _init?: unknown) => {
      if (String(url).endsWith('/healthz')) {
        return Response.json({
          ok: true,
          versions: { yt_dlp: null, ffmpeg: '8.1', ezdwf: '0.0.3' },
        });
      }
      return Response.json({
        ok: true,
        dpi: 300,
        sheet_count: 1,
        skipped: 0,
        capped: false,
        truncated: false,
        sheets: [{ name: 'wire-name-ignored', index: 0, png_base64: renderPng.toString('base64') }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const images = await extractDwfImages(await buildFixture());
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls).toContain('http://media.test:8095/dwf/render');
      expect(images).toHaveLength(1);
      expect(images[0]!.bytes.equals(renderPng)).toBe(true);
      // Sheet identity comes from the MANIFEST (mapped by index), not the
      // sidecar's own name, so titles are tier-independent.
      expect(images[0]!.location?.sheet).toBe('90-10-01 Rev 2');
      expect(images[0]!.provenance).toBe('sidecar_render');
      expect(images[0]!.essential).toBe(true);

      // A PARTIAL render (skipped sheet) must NOT replace the complete
      // thumbnail set — completeness gate falls back.
      fetchMock.mockResolvedValueOnce(
        Response.json({
          ok: true,
          dpi: 300,
          sheet_count: 2,
          skipped: 1,
          capped: false,
          truncated: true,
          sheets: [{ name: 'x', index: 0, png_base64: renderPng.toString('base64') }],
        }),
      );
      const partial = await extractDwfImages(await buildFixture());
      expect(partial).toHaveLength(1);
      expect(partial[0]!.provenance).toBe('embedded_thumbnail');

      // Sidecar down → typed failure inside the client → thumbnail fallback,
      // never a throw.
      fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const fallback = await extractDwfImages(await buildFixture());
      expect(fallback).toHaveLength(1);
      expect(fallback[0]!.location?.sheet).toBe('90-10-01 Rev 2');
      expect(fallback[0]!.provenance).toBe('embedded_thumbnail');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe('parseDwfToGrids (registry workbook)', () => {
  it('emits Sheets / Layers / Labels tabs with cross-sheet aggregation', async () => {
    const grids = await parseDwfToGrids(await buildFixture());
    expect(grids.map((g) => g.name)).toEqual(['Sheets', 'Layers', 'Labels']);

    const sheetsTab = grids[0]!;
    expect(sheetsTab.rows).toHaveLength(1);
    expect(sheetsTab.rows[0]!.slice(0, 4)).toEqual([
      '90-10-01 Rev 2',
      'A&B 90-10-01 Rev 2.dwg',
      'Model',
      'drafter1',
    ]);

    const layersTab = grids[1]!;
    expect(layersTab.rows).toContainEqual(['Circuit 90000-001-01', '90-10-01 Rev 2', 1]);

    const labelsTab = grids[2]!;
    expect(labelsTab.rows).toContainEqual(['2"', 2, '90-10-01 Rev 2']);
    expect(labelsTab.rows).toContainEqual(['DN150', 1, '90-10-01 Rev 2']);
  });

  it('returns [] for a container with no 2D sheets', async () => {
    expect(await parseDwfToGrids(await buildFixture({ sheets: false }))).toEqual([]);
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
