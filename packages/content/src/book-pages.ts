/**
 * The pages of a PDF its two Agents read (pageLanesOf; plan page c607711a,
 * M4: by the lanes of the pages). A book: the rows of the book reader's tab
 * `Pages` whose `Method` is `vision` (a scanned page, Why `scan`, for the
 * Scan reader; a figure, for vision; a book read by an older reader: pages
 * OCR read badly), but those of the drawing lane. The Agent `pdf-page-read`
 * gets them as `state.visionPages` (agentInputOf, ./file-database.ts), so it
 * asks for no typed page. The drawing Agent `pdf-sheet-read` gets the
 * drawing-lane pages. Read only, with no model and no parser job: the
 * database is the record. A database with no such tab gives none.
 */
import {
  PAGE_COLUMN,
  PAGE_KIND_FROM,
  PAGES_TAB,
  PDF_PAGE_PICTURE_BELOW,
  PIPELINE_ASK_PAGE_MAX,
  fileDbPaths,
  pageRouteOfKind,
} from '@mantle/files';
import { readTabColumns, runTableSql } from '@mantle/tabledb';

/** The Method of a page the book reader left to vision (pdf_pages.py). */
export const VISION_METHOD = 'vision';

/** The Why of a scanned page of a book (pdf_pages.py): the Scan reader
 *  reads it. A page of another Why (`failed`: pdfium could not draw it)
 *  keeps vision. */
export const SCAN_WHY = 'scan';

/** The classes of a page with no text layer to read (a drawing reader's
 *  Class): the Scan reader reads such an office page of a drawing file. */
const NO_TEXT_CLASSES: readonly string[] = ['scan', 'raster_with_text'];

/** A row of the tab Pages as the lanes read it (a column the tab lacks is
 *  null). */
export type LaneRow = Readonly<Record<string, unknown>>;

/** The columns the lanes read. */
export const LANE_COLUMNS = [
  PAGE_COLUMN,
  'Method',
  'Why',
  'Class',
  'Kind',
  'Kind from',
  'Decider confidence',
] as const;

/** The pages the two PDF Agents read, by the lanes of the pages. */
export type PageLanes = {
  /** The office Agent's (pdf-page-read): the pages it reads. */
  office: number[];
  /** Of those, the pages the Scan reader reads (cut as a one-page PDF). */
  scan: number[];
  /** The drawing Agent's (pdf-sheet-read): the drawing-lane pages, or null
   *  for a drawing file with no office-lane page (it reads from page 1, as
   *  before M4). */
  drawing: number[] | null;
};

/**
 * The pages each PDF Agent reads, by the lanes of the pages (pure; plan page
 * c607711a, M4). The lane of a page: the route of its used answer (`Kind
 * from` is `decider`), else its file's lane (a book, whose tab Pages says
 * each page's `Method`: office; else drawing).
 * So with no used answer every Agent reads as before M4.
 *
 * - The office Agent reads, in a book, the pages its reader marked
 *   (`Method` `vision`; the Scan reader those of `Why` `scan`) that are of
 *   the office lane; in a drawing file, its office-lane pages with no text
 *   layer (Class `scan`, `raster_with_text`), for the Scan reader.
 * - It also reads a page whose picture is kept (Jason, 2026-11-23): an
 *   answer of a live read under PDF_PAGE_PICTURE_BELOW (`decider`, or
 *   `rules: low confidence`, which only a live read gives), a page with a
 *   text layer too: vision reads it and its picture is saved with that text.
 * - The drawing Agent reads the drawing-lane pages.
 */
export function pageLanesOf(rows: readonly LaneRow[]): PageLanes {
  // A book's tab Pages says how each page was read (`Method`, the book
  // reader's); a drawing reader's has no such column.
  const book = rows.some((r) => typeof r.Method === 'string');
  const office: number[] = [];
  const scan: number[] = [];
  const drawing: number[] = [];
  let officeLane = false;
  for (const r of [...rows].sort((a, b) => Number(a[PAGE_COLUMN]) - Number(b[PAGE_COLUMN]))) {
    const page = Number(r[PAGE_COLUMN]);
    if (!Number.isInteger(page) || page < 1) continue;
    const from = r['Kind from'];
    const used = from === PAGE_KIND_FROM.decider;
    const lane =
      (used ? pageRouteOfKind(typeof r.Kind === 'string' ? r.Kind : null) : null) ??
      (book ? 'office' : 'drawing');
    const conf = r['Decider confidence'];
    const keep =
      (used || from === PAGE_KIND_FROM.low) &&
      typeof conf === 'number' &&
      conf < PDF_PAGE_PICTURE_BELOW;
    const marked = book
      ? r.Method === VISION_METHOD && lane === 'office'
      : lane === 'office' && typeof r.Class === 'string' && NO_TEXT_CLASSES.includes(r.Class);
    const scanned = marked && (!book || r.Why === SCAN_WHY);
    if (marked || keep) office.push(page);
    if (scanned) scan.push(page);
    if (lane === 'drawing') drawing.push(page);
    else if (!book) officeLane = true;
  }
  return { office, scan, drawing: book || officeLane ? drawing : null };
}

/** The lanes of the PDF database at `sqlite` (pageLanesOf of its tab
 *  Pages). Read only, with no model and no parser job: the database is the
 *  record. Throws what the read throws. */
function lanesAt(sqlite: string): PageLanes {
  const [rows] = readTabColumns(sqlite, [{ tab: PAGES_TAB, columns: LANE_COLUMNS }]);
  return pageLanesOf(rows ?? []);
}

/** The pages the office Agent (pdf-page-read) reads, in order, at most
 *  PIPELINE_ASK_PAGE_MAX of them (pageLanesOf; a count: a page past 10,000
 *  of a longer book is one like any); [] when the database has no `Pages`
 *  tab or it cannot be read. */
export async function bookVisionPagesOf(sqlite: string): Promise<number[]> {
  try {
    return lanesAt(sqlite).office.slice(0, PIPELINE_ASK_PAGE_MAX);
  } catch {
    return [];
  }
}

/** How many pages the office Agent reads, all of them (a book past
 *  PIPELINE_ASK_PAGE_MAX marked pages counts those past it too: they are not
 *  read, and its count says so). 0 when the database has no such tab or it
 *  cannot be read. */
export async function bookVisionPageCountOf(file: {
  id: string;
  sha256: unknown;
}): Promise<number> {
  const paths = fileDbPaths(file.id, file.sha256);
  if (!paths) return 0;
  try {
    return lanesAt(paths.sqlite).office.length;
  } catch {
    return 0;
  }
}

/** The drawing-lane pages the drawing Agent (pdf-sheet-read) reads
 *  (pageLanesOf): null for a drawing file with no office-lane page (it
 *  reads from page 1), and for a database that cannot be read. */
export async function drawingLanePagesOf(sqlite: string): Promise<number[] | null> {
  try {
    return lanesAt(sqlite).drawing;
  } catch {
    return null;
  }
}

/**
 * The pages of a book at these bytes its reader left to vision, as a set:
 * the core's picture pass leaves out a full-page picture of these pages, as
 * each has its page picture, saved by the Agent (G1), so no page is pictured
 * or read by vision twice; and they are the pages a book's page pictures are
 * counted against. Empty when the database has no such tab or cannot be
 * read.
 */
export async function bookVisionPageSetOf(file: {
  id: string;
  sha256: unknown;
}): Promise<Set<number>> {
  const paths = fileDbPaths(file.id, file.sha256);
  return new Set(paths ? await bookVisionPagesOf(paths.sqlite) : []);
}

/** The free evidence of a scanned page, from the tab `Pages`: its text lines
 *  counted from its picture with no OCR (the Scan reader's check,
 *  docs/ai-workers.md "The Scan reader"). */
export type BookScanEvidence = { lines: number | null };

/**
 * The pages the Scan reader reads (pageLanesOf: in a book, the office-lane
 * pages marked `vision` with Why `scan`; in a drawing file, its office-lane
 * pages with no text layer), in order, at most PIPELINE_ASK_PAGE_MAX of
 * them. [] when the tab cannot be read (a book read by an older reader has
 * no Why: read it again to read its scans).
 */
export async function bookScanPagesOf(sqlite: string): Promise<number[]> {
  try {
    return lanesAt(sqlite).scan.slice(0, PIPELINE_ASK_PAGE_MAX);
  } catch {
    return [];
  }
}

/** The most pages one evidence read takes: an Agent window's (15) and more. */
export const SCAN_EVIDENCE_PAGES_MAX = 100;

/**
 * The evidence of these pages (at most SCAN_EVIDENCE_PAGES_MAX, one read),
 * by page; a page that is not a Scan reader page has none. Empty when the
 * tab cannot be read.
 */
export async function bookScanEvidenceOf(
  sqlite: string,
  pages: readonly number[],
): Promise<Map<number, BookScanEvidence>> {
  const out = new Map<number, BookScanEvidence>();
  const want = [...new Set(pages.filter((n) => Number.isInteger(n) && n >= 1))].slice(
    0,
    SCAN_EVIDENCE_PAGES_MAX,
  );
  if (want.length === 0) return out;
  try {
    const r = await runTableSql(
      sqlite,
      `SELECT "${PAGE_COLUMN}", "Lines" FROM "${PAGES_TAB}" ` +
        `WHERE "Method" = '${VISION_METHOD}' AND "Why" = '${SCAN_WHY}' ` +
        `AND "${PAGE_COLUMN}" IN (${want.join(',')})`,
      { cap: SCAN_EVIDENCE_PAGES_MAX },
    );
    for (const [page, lines] of r.rows) {
      const n = Number(page);
      if (!Number.isInteger(n) || n < 1) continue;
      const l = Number(lines);
      out.set(n, {
        lines: lines !== null && lines !== undefined && Number.isInteger(l) && l >= 0 ? l : null,
      });
    }
  } catch {
    return new Map();
  }
  return out;
}

/** How the pages of a book were read, counted (docs/ai-workers.md, "The Scan
 *  reader"): by its text layer, by local OCR (a book read by an older
 *  reader), blank, by the Scan reader, by vision (a figure), and `unread`:
 *  marked for the Agent with no text (its run has not read it, there is no
 *  Scan reader, or the Scan reader's read was judged bad). */
export type BookPageMethods = {
  text: number;
  ocr: number;
  blank: number;
  scanReader: number;
  vision: number;
  unread: number;
};

/** The Agent's tab of page text (pdf-page-read) and the prefix of the Model
 *  of a page the Scan reader read (server/api pipeline-ask.ts). */
const PAGE_TEXT_TAB = 'Page text';
const SCAN_READER_MODEL_LIKE = 'scan_reader:%';

/**
 * The read of each page of a book, counted from its database: the book
 * reader's tab `Pages` and the Agent's tab `Page text` (its row's Model says
 * which reader read a marked page). Null when the database has no `Pages`
 * tab (no book) or cannot be read. Live: read from the database each time,
 * never stored.
 */
export async function bookPageMethodsOf(sqlite: string): Promise<BookPageMethods | null> {
  // Every column has its own name: a reply row is keyed by name, so two
  // unnamed `0`s would be one.
  const counts = (joined: boolean) =>
    `SELECT sum(p."Method" = 'text') AS n_text, sum(p."Method" = 'ocr') AS n_ocr, ` +
    `sum(p."Method" = 'blank') AS n_blank, ` +
    (joined
      ? `sum(p."Method" = '${VISION_METHOD}' AND coalesce(t."Text", '') <> '' AND t."Model" LIKE '${SCAN_READER_MODEL_LIKE}') AS n_scan, ` +
        `sum(p."Method" = '${VISION_METHOD}' AND coalesce(t."Text", '') <> '' AND coalesce(t."Model", '') NOT LIKE '${SCAN_READER_MODEL_LIKE}') AS n_vision, ` +
        `sum(p."Method" = '${VISION_METHOD}' AND coalesce(t."Text", '') = '') AS n_unread ` +
        `FROM "${PAGES_TAB}" p LEFT JOIN "${PAGE_TEXT_TAB}" t ` +
        // A number column is a REAL: 5 reads as '5.0' in text, the Agent's key
        // is 'page-5'.
        `ON t."Key" = 'page-' || CAST(p."${PAGE_COLUMN}" AS INTEGER)`
      : `0 AS n_scan, 0 AS n_vision, sum(p."Method" = '${VISION_METHOD}') AS n_unread ` +
        `FROM "${PAGES_TAB}" p`);
  const read = async (joined: boolean) => {
    const r = await runTableSql(sqlite, counts(joined), { cap: 1 });
    const [text, ocr, blank, scanReader, vision, unread] = (r.rows[0] ?? []).map((v) =>
      Number.isFinite(Number(v)) ? Number(v) : 0,
    );
    return {
      text: text ?? 0,
      ocr: ocr ?? 0,
      blank: blank ?? 0,
      scanReader: scanReader ?? 0,
      vision: vision ?? 0,
      unread: unread ?? 0,
    };
  };
  try {
    return await read(true);
  } catch {
    // No tab of page text yet (the Agent never ran): every marked page is
    // unread.
    try {
      return await read(false);
    } catch {
      return null;
    }
  }
}
