/**
 * Spreadsheet-aware retrieval chunking — summarize-before-embed for grids.
 *
 * Embedding a flattened workbook row-by-row poisons passage retrieval: a
 * corpus audit found grid chunks at 74% of one production brain's chunk table,
 * crowding the vector space and riding into the responder's auto-context as
 * numeric noise (19% of injected passages). The rows carry almost no semantic
 * signal an embedding can use — what retrieval needs is "which sheet, which
 * columns, what kind of values".
 *
 * So spreadsheet-flattened text (the `# Sheet: <name>` format `parseXlsx`
 * emits, or a bare CSV body) is chunked as one PROFILE per sheet: the sheet
 * name, its header row, a small sample of data rows, and an honest coverage
 * note pointing at `file_read` for the full grid. The complete text is still
 * persisted on the node (data.text), so nothing is lost — it just stops being
 * embedded wholesale. Mirrors the summarize-before-embed decision for meeting
 * transcripts: store verbatim, embed the distilled form.
 */

import type { DocChunk } from './chunk';

const SHEET_MARKER_RE = /^# Sheet: (.+)$/;

/** Data rows sampled into a sheet's profile chunk (after the header row). */
const PROFILE_SAMPLE_ROWS = Number(process.env.MANTLE_SHEET_PROFILE_ROWS ?? 8);
/** Hard cap per profile chunk — matches chunkDocText's default budget. */
const PROFILE_MAX_CHARS = 2750;

/** Does this flattened body look like `parseXlsx` output (sheet markers)? */
export function hasSheetMarkers(text: string): boolean {
  const firstLine = text.trimStart().split('\n', 1)[0] ?? '';
  return SHEET_MARKER_RE.test(firstLine.trim());
}

/** File extensions whose flattened bodies are grids worth profiling. */
export function isSpreadsheetTitle(title: string): boolean {
  return /\.(xlsx|xls|xlsm|xlsb|csv)$/i.test(title.trim());
}

type Sheet = { name: string; lines: string[] };

function splitSheets(text: string, fallbackName: string): Sheet[] {
  const sheets: Sheet[] = [];
  let current: Sheet | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    const m = line.trim().match(SHEET_MARKER_RE);
    if (m) {
      current = { name: m[1]!.trim(), lines: [] };
      sheets.push(current);
      continue;
    }
    if (!line.trim()) continue;
    if (!current) {
      // Markerless body (a bare .csv): the whole file is one sheet.
      current = { name: fallbackName, lines: [] };
      sheets.push(current);
    }
    current.lines.push(line);
  }
  return sheets.filter((s) => s.lines.length > 0);
}

/**
 * Build one profile chunk per sheet. `fileTitle` names the markerless-CSV
 * fallback sheet and appears nowhere else. Returns [] for an empty body —
 * same contract as `chunkDocText` (caller then clears the node's chunks).
 */
export function chunkSpreadsheetProfile(
  text: string,
  opts: { fileTitle?: string; sampleRows?: number; maxChars?: number } = {},
): DocChunk[] {
  const sampleRows = Math.max(1, opts.sampleRows ?? PROFILE_SAMPLE_ROWS);
  const maxChars = Math.max(200, opts.maxChars ?? PROFILE_MAX_CHARS);
  const sheets = splitSheets(text, opts.fileTitle?.replace(/\.[a-z0-9]+$/i, '') ?? 'data');

  return sheets.map((sheet) => {
    const [header, ...rows] = sheet.lines;
    const sample = rows.slice(0, sampleRows);
    const omitted = rows.length - sample.length;
    const parts = [
      `# Sheet: ${sheet.name}`,
      `Columns: ${header ?? ''}`,
      ...sample,
      omitted > 0
        ? `[grid profile — ${sample.length} of ${rows.length} data rows shown; the full grid is available via file_read]`
        : `[grid profile — all ${rows.length} data rows shown]`,
    ];
    let body = parts.join('\n');
    if (body.length > maxChars) body = `${body.slice(0, maxChars - 1)}…`;
    return { text: body, headingPath: `Sheet: ${sheet.name}` };
  });
}
