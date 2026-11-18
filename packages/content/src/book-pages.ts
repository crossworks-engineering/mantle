/**
 * The pages of a PDF book the book reader `pdf-pages` left to vision: the
 * rows of its tab `Pages` whose `Method` is `vision` (OCR read them badly,
 * or a figure). The Agent `pdf-page-read` gets them as `state.visionPages`
 * (agentInputOf, ./file-database.ts), so it asks for no page the Reader read
 * well. Read only, with no model and no parser job: the database is the
 * record. A database with no such tab gives none.
 */
import { PAGE_COLUMN, PAGES_TAB, PIPELINE_ASK_PAGE_MAX } from '@mantle/files';
import { runTableSql } from '@mantle/tabledb';

/** The Method of a page the book reader left to vision (pdf_pages.py). */
export const VISION_METHOD = 'vision';

/** The pages marked for vision, in order, at most PIPELINE_ASK_PAGE_MAX;
 *  [] when the database has no `Pages` tab of the book reader or it cannot
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
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= PIPELINE_ASK_PAGE_MAX);
  } catch {
    return [];
  }
}
