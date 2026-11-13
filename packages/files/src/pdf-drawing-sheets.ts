/**
 * A PDF drawing read as the tabs of the file's read-only database (plan
 * page 11a16779, sections 10.4 and 10.7). Pure: the parser's answer and the
 * decider's answer in, sheets out.
 *
 * The kind lives here and nowhere else: the `File` tab holds it with where
 * it came from, the `Pages` tab holds each page's kind and facts. So the
 * database of a file's bytes is also the record that its kind was decided,
 * and a file with a database is never asked about again.
 */

import type { PdfDrawing } from './pdf-drawing';
import type { Box } from './pdf-primitives';
import { PDF_KINDS, type PdfKind } from './pdf-kind';
import { CONFIDENCE, type LineRow, type TagRow, type WordRow } from './pdf-rows';
import { SKETCH_MAX_PAGES, sketchPageRows, type SketchRead } from './pdf-sketch';
import type { ParsedSheet } from './sheet-to-grid';
import { SHAPES } from './pipelines/shapes';

/** The File tab as pdfFileTabOf reads it: the pdf-file-v1 shape, one home. */
const FILE_TAB = SHAPES['pdf-file-v1'].tabs.find((t) => t.name === 'File')!;

/** The version of the rules in ./pdf-kind.ts. Raise it when a threshold or
 *  a rule changes, so a database says which rules made it. */
export const PDF_KIND_RULES_VERSION = 1;

/** The decider's answer for an unsure file, as the caller heard it. */
export type PdfKindDecision = {
  /** The option it chose. */
  kind: string;
  confidence: number;
  model: string;
  mode: 'shadow' | 'live';
  /** True when the answer may be used: live mode, at or over the use's
   *  floor. A shadow answer and a weak one are recorded and not used. */
  used: boolean;
};

export type PdfDrawingSheets = {
  /** The file's kind: the rules', or the decider's for an unsure file when
   *  its answer may be used. */
  kind: PdfKind;
  sheets: ParsedSheet[];
  description: string;
};

const isPdfKind = (k: string): k is PdfKind => (PDF_KINDS as readonly string[]).includes(k);

/** A box as four cells: fractions of the shown page, origin top left. */
const BOX_COLUMNS = (prefix = '') =>
  ['X0', 'Y0', 'X1', 'Y1'].map((n) => ({ name: `${prefix}${n}`, type: 'number' as const }));
/** A coordinate, or null for one that is no number (a box that was sent
 *  as not finite arrives as null). */
const cell = (v: number | null) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e5) / 1e5 : null;
const boxCells = (b: Box | null) => (b ? b.map(cell) : [null, null, null, null]);

/**
 * The row tabs (plan 10.7), from the pages' rows: `Texts` a word a row,
 * `Tags`, `Lines` (line numbers) and `Markups`; and from the sketch read of
 * a scan (./pdf-sketch.ts): more rows in the first three, with `Source`
 * `ocr`, and `Gaps` (a place where text is and none was read). A tab with
 * no row is not written.
 */
function rowSheets(drawing: PdfDrawing, sketch: SketchRead | null): ParsedSheet[] {
  const texts: ParsedSheet = {
    name: 'Texts',
    columns: [
      { name: 'Page', type: 'number' },
      { name: 'Line', type: 'number' },
      { name: 'Text', type: 'text' },
      ...BOX_COLUMNS(),
      { name: 'Angle', type: 'number' },
      { name: 'Size mm', type: 'number' },
      { name: 'Hidden', type: 'checkbox' },
      { name: 'Spaced', type: 'checkbox' },
      { name: 'Region', type: 'text' },
      { name: 'Source', type: 'text' },
      { name: 'Confidence', type: 'number' },
    ],
    rows: [],
  };
  const tags: ParsedSheet = {
    name: 'Tags',
    columns: [
      { name: 'Page', type: 'number' },
      { name: 'Tag', type: 'text' },
      { name: 'Key', type: 'text' },
      { name: 'Raw', type: 'text' },
      { name: 'Type', type: 'text' },
      { name: 'Unit', type: 'text' },
      { name: 'Letters', type: 'text' },
      { name: 'Number', type: 'text' },
      { name: 'Source', type: 'text' },
      { name: 'Region', type: 'text' },
      { name: 'Hidden', type: 'checkbox' },
      { name: 'Confidence', type: 'number' },
      ...BOX_COLUMNS(),
    ],
    rows: [],
  };
  const lines: ParsedSheet = {
    name: 'Lines',
    columns: [
      { name: 'Page', type: 'number' },
      { name: 'Line number', type: 'text' },
      { name: 'Raw', type: 'text' },
      { name: 'Size', type: 'text' },
      { name: 'Serial', type: 'text' },
      { name: 'Source', type: 'text' },
      { name: 'Region', type: 'text' },
      { name: 'Hidden', type: 'checkbox' },
      { name: 'Confidence', type: 'number' },
      ...BOX_COLUMNS(),
    ],
    rows: [],
  };
  const markups: ParsedSheet = {
    name: 'Markups',
    columns: [
      { name: 'Page', type: 'number' },
      { name: 'Kind', type: 'text' },
      { name: 'Text', type: 'text' },
      { name: 'Author', type: 'text' },
      ...BOX_COLUMNS(),
      { name: 'Beside kind', type: 'text' },
      ...BOX_COLUMNS('Beside '),
    ],
    rows: [],
  };
  const gaps: ParsedSheet = {
    name: 'Gaps',
    columns: [{ name: 'Page', type: 'number' }, ...BOX_COLUMNS(), { name: 'Why', type: 'text' }],
    rows: [],
  };
  /** The tags and line numbers of one page, read in `words`. A tag's
   *  region and hidden flag are those of the word it was read in. */
  const tagRows = (
    page: number,
    words: readonly WordRow[],
    found: { tags: readonly TagRow[]; lines: readonly LineRow[] },
  ) => {
    const of = (word: number) => words[word];
    for (const t of found.tags) {
      tags.rows.push([
        page,
        t.tag,
        t.key,
        t.raw,
        t.type,
        t.unit || null,
        t.letters,
        t.number,
        t.source,
        of(t.word)?.region ?? 'body',
        of(t.word)?.hidden ?? false,
        Math.round(t.confidence * 100) / 100,
        ...boxCells(t.box),
      ]);
    }
    for (const l of found.lines) {
      lines.rows.push([
        page,
        l.line,
        l.raw,
        l.size,
        l.serial,
        l.source,
        of(l.word)?.region ?? 'body',
        of(l.word)?.hidden ?? false,
        Math.round(l.confidence * 100) / 100,
        ...boxCells(l.box),
      ]);
    }
  };
  for (const p of drawing.pages) {
    // What the vision model read off this page, when it is a scan page of
    // a sketch read: a word has its piece's box and no angle or size.
    const read = sketch?.pages.find((r) => r.page === p.page);
    if (read) {
      const ocr = sketchPageRows(read, p.widthMm ?? 210, p.heightMm ?? 297);
      for (const w of ocr.words) {
        texts.rows.push([
          p.page,
          w.line,
          w.text,
          ...boxCells(w.box),
          null,
          null,
          false,
          false,
          w.region,
          'ocr',
          CONFIDENCE.ocrWord,
        ]);
      }
      tagRows(p.page, ocr.words, ocr);
      for (const g of ocr.gaps) gaps.rows.push([p.page, ...boxCells(g.box), g.why]);
    }
    const rows = p.rows;
    if (!rows) continue;
    for (const w of rows.words) {
      texts.rows.push([
        p.page,
        w.line,
        w.text,
        ...boxCells(w.box),
        w.angle,
        w.sizeMm,
        w.hidden,
        w.spaced,
        w.region,
        'text',
        // The text layer says what the word is; a word put together from
        // spaced glyphs is the one thing to check (under 0.8).
        w.spaced ? 1 - CONFIDENCE.spacedLess - 0.05 : 1,
      ]);
    }
    tagRows(p.page, rows.words, rows);
    for (const m of rows.markups) {
      markups.rows.push([
        p.page,
        m.kind,
        m.text || null,
        m.author || null,
        ...boxCells(m.box),
        m.besideKind || null,
        ...boxCells(m.besideBox),
      ]);
    }
  }
  return [texts, tags, lines, markups, gaps].filter((s) => s.rows.length > 0);
}

/** Pages with no whole read: those stated so, and those past the reader's
 *  page cap, which have no row at all. The File tab's `Pages not read
 *  whole`. */
export function pagesNotReadWhole(drawing: PdfDrawing): number {
  const pastCap = Math.max(0, drawing.numPages - drawing.pages.length);
  return drawing.pages.filter((p) => p.status !== 'ok').length + pastCap;
}

/**
 * What the `File` tab of a PDF's database says, read back from its one row
 * (`columns` and `row` as a SQL read gives them): the kind, the rules' own
 * kind, the decider's answer as it was heard, and whether the sketch read
 * ran. Beside the writer below, so the two cannot drift. Null when the row
 * is no `File` row.
 */
export function pdfFileTabOf(
  columns: readonly string[],
  row: readonly unknown[],
): {
  kind: string;
  rulesKind: string;
  decision: PdfKindDecision | null;
  visionRead: boolean;
  notReadWhole: number;
} | null {
  const cell = (name: string) => row[columns.indexOf(name)];
  // The pdf-file-v1 shape's needed columns (Kind, Rules kind): no row without them.
  if (!FILE_TAB.neededColumns.every((c) => typeof cell(c) === 'string')) return null;
  const kind = String(cell('Kind'));
  const rulesKind = String(cell('Rules kind'));
  const answer = cell('Decider answer');
  return {
    kind,
    rulesKind,
    visionRead: cell('Vision read') === 1 || cell('Vision read') === true,
    notReadWhole: Number(cell('Pages not read whole') ?? 0),
    decision:
      typeof answer === 'string' && answer
        ? {
            kind: answer,
            confidence: Number(cell('Decider confidence') ?? 0),
            model: String(cell('Decider model') ?? ''),
            mode: cell('Decider mode') === 'live' ? 'live' : 'shadow',
            used: cell('Kind source') === 'decider',
          }
        : null,
  };
}

/** What each kind's database holds beyond the two tabs here. Phase 1 states
 *  it, so a reader does not look for rows that are not built yet. */
const KIND_NOTE: Record<PdfKind, string> = {
  pid: 'A piping and instrument diagram.',
  pfd: 'A process flow diagram.',
  isometric: 'A piping isometric.',
  equipment_drawing: 'An equipment drawing.',
  datasheet: 'A datasheet or a ruled form.',
  table: 'Rows of data: an invoice, a list or a register.',
  scan: 'A scanned drawing or ruled form; what kind is not known.',
  other_drawing: 'A drawing; what kind is not known.',
  document: 'A document, not a drawing.',
  unsure: 'A drawing-like PDF whose kind the rules could not decide.',
};

export function pdfDrawingSheets(
  drawing: PdfDrawing,
  decision: PdfKindDecision | null,
  /** The sketch read of the file's scan pages, when one ran. */
  sketch: SketchRead | null = null,
): PdfDrawingSheets {
  // The decider's `document` is used only for a file the reader left nothing
  // out of: a document gets no database, and what was left out is stated
  // only there.
  const decided =
    drawing.kind === 'unsure' &&
    decision?.used &&
    isPdfKind(decision.kind) &&
    (decision.kind !== 'document' || drawing.allRead)
      ? decision.kind
      : null;
  const kind = decided ?? drawing.kind;
  const pastCap = Math.max(0, drawing.numPages - drawing.pages.length);
  const notRead = pagesNotReadWhole(drawing);
  const file: ParsedSheet = {
    name: 'File',
    columns: [
      { name: 'Kind', type: 'text' },
      { name: 'Kind source', type: 'text' },
      { name: 'Rules kind', type: 'text' },
      { name: 'Rules version', type: 'number' },
      { name: 'Decider answer', type: 'text' },
      { name: 'Decider confidence', type: 'number' },
      { name: 'Decider mode', type: 'text' },
      { name: 'Decider model', type: 'text' },
      { name: 'Pages', type: 'number' },
      { name: 'Pages not read whole', type: 'number' },
      { name: 'Page count may be short', type: 'checkbox' },
      { name: 'Large image not read', type: 'checkbox' },
      // The one fact a `document` needs: the reader left nothing out.
      { name: 'All read', type: 'checkbox' },
      // The sketch read (./pdf-sketch.ts). `Vision read` is the record that
      // it ran for these bytes: it is not run again.
      { name: 'Vision read', type: 'checkbox' },
      { name: 'Vision model', type: 'text' },
      { name: 'Scan pages read', type: 'number' },
      { name: 'Scan pages past the cap', type: 'number' },
    ],
    rows: [
      [
        kind,
        decided ? 'decider' : 'rules',
        drawing.kind,
        PDF_KIND_RULES_VERSION,
        decision?.kind ?? null,
        decision ? Math.round(decision.confidence * 1000) / 1000 : null,
        decision?.mode ?? null,
        decision?.model ?? null,
        drawing.numPages,
        notRead,
        drawing.pageCountMayBeShort,
        drawing.largeImageNotRead === true,
        drawing.allRead === true,
        sketch !== null,
        sketch?.model ?? null,
        sketch ? sketch.pages.filter((r) => r.status === 'ok').length : null,
        sketch ? sketch.pagesPastCap.length : null,
      ],
    ],
  };
  const pages: ParsedSheet = {
    name: 'Pages',
    columns: [
      { name: 'Page', type: 'number' },
      { name: 'Kind', type: 'text' },
      { name: 'Kind from', type: 'text' },
      { name: 'Class', type: 'text' },
      { name: 'Status', type: 'text' },
      { name: 'Why', type: 'text' },
      { name: 'Size', type: 'text' },
      { name: 'Width mm', type: 'number' },
      { name: 'Height mm', type: 'number' },
      { name: 'Rotation', type: 'number' },
      { name: 'Characters', type: 'number' },
      { name: 'Text runs', type: 'number' },
      { name: 'Segments', type: 'number' },
      { name: 'Tag-like tokens', type: 'number' },
      { name: 'Instrument tags', type: 'number' },
      { name: 'Line numbers', type: 'number' },
      { name: 'Markups', type: 'number' },
      { name: 'Markups with text', type: 'number' },
      { name: 'Image cover', type: 'number' },
      { name: 'Hidden text share', type: 'number' },
      { name: 'Axes from', type: 'text' },
      { name: 'Lines horizontal', type: 'number' },
      { name: 'Lines vertical', type: 'number' },
      { name: 'Lines isometric', type: 'number' },
      { name: 'Lines other', type: 'number' },
      { name: 'Long lines mm', type: 'number' },
      { name: 'Read ms', type: 'number' },
      { name: 'Notes', type: 'text' },
      // What became of the page's words (./pdf-rows.ts). The four `As` and
      // `Rejected` counts add up to `Tag-like tokens`.
      { name: 'Words', type: 'number' },
      { name: 'As instrument', type: 'number' },
      { name: 'As equipment', type: 'number' },
      { name: 'As line number', type: 'number' },
      { name: 'Rejected tag-like', type: 'number' },
      { name: 'Other tag tokens', type: 'number' },
      { name: 'Tags from lists', type: 'number' },
      { name: 'Bubble tags', type: 'number' },
      // The sketch read of a scan page. `Vision status`: `ok`, or why the
      // page has no read; empty for a page the read does not take.
      { name: 'Vision status', type: 'text' },
      { name: 'Pieces', type: 'number' },
      { name: 'Pieces read', type: 'number' },
      { name: 'Pieces not sent', type: 'number' },
      { name: 'Read DPI', type: 'number' },
    ],
    rows: drawing.pages.map((p) => {
      // A raster page's axes come from its picture; a drawn page's from its
      // own lines.
      const axes = p.eye?.axes ?? p.axes;
      const read = sketch?.pages.find((r) => r.page === p.page);
      const pastCap = sketch?.pagesPastCap.includes(p.page);
      return [
        p.page,
        p.kind,
        p.kindFrom ?? 'rules',
        p.class ?? null,
        p.status,
        p.why ?? null,
        p.size ?? null,
        p.widthMm ?? null,
        p.heightMm ?? null,
        p.rotate ?? null,
        p.chars,
        p.runs,
        p.segments,
        p.tagLike,
        p.instruments,
        p.lineNumbers,
        p.markups,
        p.markupsWithText,
        p.imageCover,
        p.hiddenShare,
        axes ? (p.eye ? 'picture' : 'page') : null,
        axes?.h ?? null,
        axes?.v ?? null,
        axes?.iso ?? null,
        axes?.other ?? null,
        axes?.longMm ?? null,
        p.readMs ?? null,
        p.notes?.length ? p.notes.join(', ') : null,
        p.rows?.account.words ?? null,
        p.rows?.account.asInstrument ?? null,
        p.rows?.account.asEquipment ?? null,
        p.rows?.account.asLine ?? null,
        p.rows?.account.rejected ?? null,
        p.rows?.account.otherTagTokens ?? null,
        p.rows?.account.fromLists ?? null,
        p.rows?.account.bubbles ?? null,
        read ? read.status : pastCap ? 'past_page_cap' : null,
        read ? read.pieces.length : null,
        read ? read.pieces.filter((piece) => piece.text !== null).length : null,
        read ? read.notSent.length : null,
        read && read.dpi > 0 ? Math.round(read.dpi) : null,
      ];
    }),
  };
  const rows = rowSheets(drawing, sketch);
  const description =
    `PDF read as a drawing. ${KIND_NOTE[kind]}` +
    ` File holds the kind and where it came from (the rules, or the decider for a file the` +
    ` rules left unsure). Pages holds one row a page: its kind, its class (drawn with text,` +
    ` drawn with no text layer, a scan, typed text), its size, and counts with no model` +
    ` (characters, line segments, instrument tags, line numbers, markups).` +
    ` Kind from says what named a page: the rules on its own counts, its own picture, or` +
    ` (other_pages) the pictures of other scan pages of the file, when this one was not looked at.` +
    (notRead > 0
      ? ` ${notRead} of ${drawing.numPages} pages were not read whole: Status and Why say which.`
      : '') +
    (pastCap > 0
      ? ` The file declares ${drawing.numPages} pages and only the first ${drawing.pages.length} have a row.`
      : '') +
    (drawing.largeImageNotRead === true
      ? ` The file holds an image too large to read: its page may count as blank or as text alone.`
      : '') +
    (drawing.pages.some((p) => p.notes?.length)
      ? ` Notes states what a page's counts or rows leave out (rows_not_listed: the page's words,` +
        ` tags, line numbers and markups are not in the tabs, the file holds more rows or more` +
        ` text than one database lists).`
      : '') +
    (rows.length > 0
      ? ` The other tabs hold what the text layer and the markups say, read with no model,` +
        ` for every page that is not a typed document page; a tab with no row is left out.` +
        ` Texts: a word a row, with its line, its box (X0 Y0 X1 Y1: fractions of the shown page,` +
        ` origin top left), Hidden (drawn invisible, such as an old OCR layer) and Spaced (put` +
        ` together from letter-spaced glyphs: check it).` +
        ` Tags: instrument tags (an ISA code with its loop number, in one token, or as a code with` +
        ` the number under it: Source bubble) and equipment tags (unit, type letters, number, by` +
        ` their shape alone: not every one is a main equipment item). Tag is upper case with one` +
        ` kind of dash and its digits as written (leading zeros kept); Raw is the token as written` +
        ` (one Raw gives a row for each item of a list after it: P-1A/B; a bubble's Raw is its code,` +
        ` a space and its number).` +
        ` Key is the tag with letters and digits only: join on it, because one item is written with` +
        ` and without a dash (two tags that differ only in where a dash is share a key). A three-part` +
        ` code with an ISA code in the middle (100-FG-2001) is listed as an instrument tag, also when` +
        ` it is a short line number.` +
        ` Lines: pipe line numbers with their size and serial; the service and the pipe class are` +
        ` not named, they are parts of Raw.` +
        ` Markups: each annotation with its text and author, and for a text markup the drawn` +
        ` markup beside it (a line, a cloud).` +
        ` Region flags words in the lower right corner (title_block, by position) and words that` +
        ` repeat at one place on 3 or more pages (template); they are flagged, never left out.` +
        ` Confidence is from a fixed table by how a row was read: under 0.8 is a value to check.` +
        (sketch
          ? ` Source ocr: a vision model (${sketch.model}) read the scan pages part by part` +
            ` (Vision status in Pages; at most ${SKETCH_MAX_PAGES} pages of a file). A word of it has` +
            ` the box of the piece it was read in, not its own, its Line is the number of that` +
            ` piece, and every value of it is one to check against the drawing. Gaps: a place on a scan page where text is and none was` +
            ` read: the model gave no text for it (no_text_read), the model's call for its picture` +
            ` did not run (not_read), or it did not fit in the pictures sent (not_sent).`
          : '') +
        ` Not here yet: symbols, tables and cells, and what a line connects.`
      : ` No tab here holds the words of the drawing.`);
  return { kind, sheets: [file, pages, ...rows], description };
}
