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
