/**
 * The pages of a PDF book the book reader `pdf-pages` left to vision: the
 * rows of its tab `Pages` whose `Method` is `vision` (OCR read them badly,
 * or a figure). The Agent `pdf-page-read` gets them as `state.visionPages`
 * (agentInputOf, ./file-database.ts), so it asks for no page the Reader read
 * well. Read only, with no model and no parser job: the database is the
 * record. A database with no such tab gives none.
 */
import { PAGE_COLUMN, PAGES_TAB, PIPELINE_ASK_PAGE_MAX, fileDbPaths } from '@mantle/files';
import { runTableSql } from '@mantle/tabledb';

/** The Method of a page the book reader left to vision (pdf_pages.py). */
export const VISION_METHOD = 'vision';

/** The pages marked for vision, in order, at most PIPELINE_ASK_PAGE_MAX of
 *  them (a count: a page past 10,000 of a longer book is one like any); []
 *  when the database has no `Pages` tab of the book reader or it cannot
 *  be read. */
export async function bookVisionPagesOf(sqlite: string): Promise<number[]> {
  try {
    // One row (the reader's row cap is 1,000; a book has more pages): the
    // pages joined by commas.
    const r = await runTableSql(
      sqlite,
      `SELECT group_concat(p, ',') FROM (SELECT "${PAGE_COLUMN}" AS p FROM "${PAGES_TAB}" ` +
        `WHERE "Method" = '${VISION_METHOD}' ORDER BY "${PAGE_COLUMN}" LIMIT ${PIPELINE_ASK_PAGE_MAX})`,
      { cap: 1 },
    );
    const joined = r.rows[0]?.[0];
    if (typeof joined !== 'string' || joined === '') return [];
    return joined
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1);
  } catch {
    return [];
  }
}

/** How many pages the book reader left to vision, all of them (a book past
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
    const r = await runTableSql(
      paths.sqlite,
      `SELECT count(*) FROM "${PAGES_TAB}" WHERE "Method" = '${VISION_METHOD}'`,
      { cap: 1 },
    );
    const n = Number(r.rows[0]?.[0]);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
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

/** The Why of a page the book reader left to vision because OCR read it
 *  badly (pdf_pages.py): the Scan reader reads it first. A page of another
 *  Why (`figure`, `failed`, `late`) keeps vision. */
export const SCAN_WHY = 'ocr';

/** The free evidence of a page OCR read badly, from the tab `Pages`: the
 *  words Tesseract read surely and the page's text lines (the Scan reader's
 *  check, docs/ai-workers.md "The Scan reader"). */
export type BookScanEvidence = { words: readonly string[]; lines: number | null };

/**
 * The pages of a book the Scan reader reads first (marked `vision`, Why
 * `ocr`), in order, at most PIPELINE_ASK_PAGE_MAX of them. [] when the tab
 * has no Why (a book read by an older reader: its pages keep vision) or
 * cannot be read.
 */
export async function bookScanPagesOf(sqlite: string): Promise<number[]> {
  try {
    const r = await runTableSql(
      sqlite,
      `SELECT group_concat(p, ',') FROM (SELECT "${PAGE_COLUMN}" AS p FROM "${PAGES_TAB}" ` +
        `WHERE "Method" = '${VISION_METHOD}' AND "Why" = '${SCAN_WHY}' ` +
        `ORDER BY "${PAGE_COLUMN}" LIMIT ${PIPELINE_ASK_PAGE_MAX})`,
      { cap: 1 },
    );
    const joined = r.rows[0]?.[0];
    if (typeof joined !== 'string' || joined === '') return [];
    return joined
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1);
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
      `SELECT "${PAGE_COLUMN}", "Lines", "Sure words" FROM "${PAGES_TAB}" ` +
        `WHERE "Method" = '${VISION_METHOD}' AND "Why" = '${SCAN_WHY}' ` +
        `AND "${PAGE_COLUMN}" IN (${want.join(',')})`,
      { cap: SCAN_EVIDENCE_PAGES_MAX },
    );
    for (const [page, lines, words] of r.rows) {
      const n = Number(page);
      if (!Number.isInteger(n) || n < 1) continue;
      const l = Number(lines);
      out.set(n, {
        words: typeof words === 'string' ? words.split(/\s+/).filter(Boolean) : [],
        lines: lines !== null && lines !== undefined && Number.isInteger(l) && l >= 0 ? l : null,
      });
    }
  } catch {
    return new Map();
  }
  return out;
}

/** How the pages of a book were read, counted (docs/ai-workers.md, "The Scan
 *  reader"): by its text layer, by local OCR, blank, by the Scan reader, by
 *  vision, and `unread`: marked for the Agent with no text yet (its run has
 *  not read them, or every reader failed). */
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
  const counts = (joined: boolean) =>
    `SELECT sum(p."Method" = 'text'), sum(p."Method" = 'ocr'), sum(p."Method" = 'blank'), ` +
    (joined
      ? `sum(p."Method" = '${VISION_METHOD}' AND coalesce(t."Text", '') <> '' AND t."Model" LIKE '${SCAN_READER_MODEL_LIKE}'), ` +
        `sum(p."Method" = '${VISION_METHOD}' AND coalesce(t."Text", '') <> '' AND coalesce(t."Model", '') NOT LIKE '${SCAN_READER_MODEL_LIKE}'), ` +
        `sum(p."Method" = '${VISION_METHOD}' AND coalesce(t."Text", '') = '') ` +
        `FROM "${PAGES_TAB}" p LEFT JOIN "${PAGE_TEXT_TAB}" t ON t."Key" = 'page-' || p."${PAGE_COLUMN}"`
      : `0, 0, sum(p."Method" = '${VISION_METHOD}') FROM "${PAGES_TAB}" p`);
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
