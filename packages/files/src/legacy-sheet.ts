/**
 * Legacy spreadsheet → modern `.xlsx`, converted at the door.
 *
 * exceljs reads OOXML only: `.xlsx` and `.xlsm`. It cannot read the old binary
 * formats — BIFF `.xls` (Excel 97-2003) or `.xlsb`. SheetJS could, and that
 * auto-detection was the one capability we lost by dropping it.
 *
 * Rather than keep a second spreadsheet engine alive for two formats, we
 * CONVERT them on ingest: legacy bytes in, real `.xlsx` bytes out, and from
 * that point the whole system has exactly one spreadsheet reader. `./parse.ts`
 * and `./sheet-to-grid.ts` both run the converted buffer through the ordinary
 * exceljs path, so legacy files get the same caps, the same cell coercion and
 * the same output shape as anything else — no parallel code path to keep in
 * step.
 *
 * ## The converter is Apache Tika, which we already run
 *
 * Tika is Apache POI underneath, which reads BIFF and `.xlsb` properly, and it
 * is already a service in docker-compose (tier 2 of `parseDocumentBytes`).
 * Using it here costs no new dependency, no new container, and no LibreOffice
 * in the image. We ask for Tika's XHTML rendering — one `<div class="page">`
 * per sheet, with an `<h1>` sheet name and a `<table>` of `<tr>`/`<td>` — and
 * rebuild that as a workbook with exceljs.
 *
 * ## What conversion costs, honestly
 *
 * Tika's XHTML is a RENDERING, not the cell model, so type fidelity is
 * reduced:
 *
 *   - **Booleans are dropped.** A `TRUE`/`FALSE` cell renders as an empty
 *     `<td/>`. Column alignment survives (verified — the placeholder cell is
 *     still emitted), so nothing shifts; the value is simply lost.
 *   - **Dates arrive as display text** ("1/15/26"), not as date cells, so
 *     downstream type inference will usually call such a column text.
 *   - Numbers survive as numeric-looking text and re-infer cleanly.
 *
 * That is a real loss and it is why this path is reserved for the two formats
 * that cannot be read any other way. It is also, in practice, theoretical:
 * across the dev, prod and NATREF brains there is not a single `.xls` or
 * `.xlsb` (NATREF's spreadsheet corpus is 60 `.xlsx` + 13 `.xlsm`). If a real
 * one ever lands, this comment is the record of exactly what degrades.
 *
 * Never-throws, matching `./tika.ts`: any failure — Tika down, unreadable
 * bytes, no tables in the output — returns `null`, and the caller degrades to
 * whatever it would have done for an unreadable file.
 */

import ExcelJS from 'exceljs';
import { SaxesParser } from 'saxes';
import { parseTikaBytes } from './tika';

/** Extensions exceljs cannot read, which this module converts first. */
const LEGACY_SHEET_EXTS = new Set<string>(['xls', 'xlsb']);

/** True when this extension needs converting before the exceljs path. */
export function isLegacySheetExt(ext: string): boolean {
  return LEGACY_SHEET_EXTS.has(ext.toLowerCase());
}

/** One sheet lifted out of Tika's XHTML: a name and a rectangle of strings. */
type LegacySheet = { name: string; rows: string[][] };

/**
 * Strip Tika's `<head>` and any control-character references.
 *
 * Tika emits the workbook's own metadata into `<head>`, and a real `.xls`
 * written by SheetJS produced `<title>&#0;</title>` — a NUL character
 * reference, which is not legal XML and which a strict parser (saxes) rejects
 * outright. The `<body>` is well-formed; the junk is confined to metadata we
 * do not want. So we take the body and neutralise stray control references
 * rather than trying to parse the document whole.
 */
function bodyXml(xhtml: string): string | null {
  const open = xhtml.indexOf('<body');
  if (open === -1) return null;
  const start = xhtml.indexOf('>', open);
  const end = xhtml.lastIndexOf('</body>');
  if (start === -1 || end === -1 || end <= start) return null;
  const inner = xhtml.slice(start + 1, end);
  // Drop numeric refs to C0 controls (except tab/LF/CR, which are legal).
  return `<body>${inner.replace(/&#x?0*(?:[0-8bcefBCEF]|1[0-9a-fA-F]);/g, '')}</body>`;
}

/**
 * Pull `{ sheet name, rows }` out of Tika's spreadsheet XHTML.
 *
 * Shape Tika produces per sheet:
 *   `<div class="page"><h1>Orders</h1><table><tbody><tr><td>…</td>…</tr>…`
 *
 * The `<h1>` is optional in principle, so sheets fall back to positional
 * names. Returns `[]` if the markup does not parse or holds no tables.
 */
function sheetsFromXhtml(xhtml: string): LegacySheet[] {
  const body = bodyXml(xhtml);
  if (!body) return [];

  const sheets: LegacySheet[] = [];
  let pendingName: string | null = null;
  let rows: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string | null = null;
  let inHeading = false;
  let heading = '';

  const flush = () => {
    if (rows && rows.length > 0) {
      sheets.push({ name: pendingName ?? `Sheet${sheets.length + 1}`, rows });
    }
    rows = null;
    pendingName = null;
  };

  const parser = new SaxesParser({ fragment: false });
  parser.on('opentag', (node) => {
    switch (node.name) {
      case 'h1':
        inHeading = true;
        heading = '';
        break;
      case 'table':
        // A second <table> in the same page div starts a new sheet rather
        // than silently merging into the previous one.
        if (rows) flush();
        rows = [];
        break;
      case 'tr':
        if (rows) row = [];
        break;
      case 'td':
      case 'th':
        if (row) cell = '';
        break;
    }
  });
  parser.on('text', (t) => {
    if (inHeading) heading += t;
    else if (cell !== null) cell += t;
  });
  parser.on('closetag', (node) => {
    switch (node.name) {
      case 'h1':
        inHeading = false;
        // The heading names the sheet whose table comes NEXT, so a table
        // already open belongs to the previous heading — close it first.
        if (rows) flush();
        pendingName = heading.trim() || null;
        break;
      case 'td':
      case 'th':
        if (row && cell !== null) row.push(cell.trim());
        cell = null;
        break;
      case 'tr':
        if (rows && row) rows.push(row);
        row = null;
        break;
      case 'table':
        flush();
        break;
    }
  });

  try {
    parser.write(body).close();
  } catch {
    // Partial parse: keep whatever complete tables we already collected.
    flush();
  }
  return sheets.filter((s) => s.rows.some((r) => r.some((c) => c !== '')));
}

/**
 * Convert legacy spreadsheet bytes to a real `.xlsx` buffer, or `null` when
 * the file cannot be converted.
 *
 * `mimeType` should be the legacy type for the extension (see `mimeForExt`) so
 * Tika does not have to guess from the bytes.
 *
 * Cells are written as numbers where the rendered text is unambiguously
 * numeric and as strings otherwise — that keeps a numeric column numeric
 * through the round trip, which is the type that matters most downstream (it
 * drives both the grid's column type and Excel's own alignment/formatting).
 */
export async function convertLegacySheetToXlsx(
  bytes: Buffer,
  mimeType: string,
): Promise<Buffer | null> {
  const xhtml = await parseTikaBytes(bytes, { mimeType, accept: 'text/html' });
  if (!xhtml) return null;
  const sheets = sheetsFromXhtml(xhtml);
  if (sheets.length === 0) return null;

  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    // Excel caps sheet names at 31 chars and forbids \ / ? * [ ] :
    const name = (sheet.name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet';
    const ws = wb.addWorksheet(name);
    for (const row of sheet.rows) {
      ws.addRow(row.map(numericOrText));
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** `"12.5"` → `12.5`; anything else stays the string (empty → null). */
function numericOrText(text: string): string | number | null {
  if (text === '') return null;
  // Deliberately strict: no thousands separators, no currency symbols. A
  // rendered "1,234" stays text here and is re-inferred downstream by
  // sheet-to-grid, which already knows how to strip separators.
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return text;
  const n = Number(text);
  return Number.isFinite(n) ? n : text;
}
