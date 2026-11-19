/**
 * A book's page pictures (G1, docs/pipelines.md "The book reader"): ONE
 * owner, the Agent `pdf-page-read`, in its own run. For each page the book
 * reader `pdf-pages` marked for vision (its tab Pages, bookVisionPagesOf),
 * window by window:
 *
 *   render  the Agent's step draws the page in the parser (the window's
 *           PDF, no model);
 *   read    the core answers its ask (agentRows: the tab by hash, else one
 *           paid vision call);
 *   save    the core writes the page's text row, then saves the page
 *           picture with that text as its description (the caller's
 *           BookPagePictures, server/api/src/agent/extract/images.ts).
 *
 * No hand-over between jobs, no spool, no memo: a page with a saved picture
 * of these bytes and its text row is done, and is neither drawn nor asked
 * again (idempotent; never a second paid call). A page that could not be
 * drawn, read or saved stays not done: the file's count says so
 * (`data.images.pages`, from what is saved and what is marked), and the
 * next run of the Agent (a person's `pipeline_run`, or the upload of new
 * bytes) takes it. No timer or sweep starts one.
 */
import { PAGE_ASK_KEY_PREFIX, PAGE_TEXT_COLUMN } from '@mantle/files';
import type { ParsedSheet } from '@mantle/files/sheet-to-grid';
import { AGENT_HASH_COLUMN, AGENT_KEY_COLUMN, type AgentAsk } from './pipeline-agent';

/** One page picture to save: the page of the original file, the picture
 *  the Agent's step drew, and the text read from it. */
export type BookPagePicture = { page: number; bytes: Buffer; mime: string; text: string };

/** Where a book's page pictures are saved, given to the Agent's run by its
 *  caller (the run job, server/api/src/agent/extract/pipeline-run.ts). */
export type BookPagePictures = {
  /** The pages of these bytes with a saved picture that holds its text. */
  done(): Promise<ReadonlySet<number>>;
  /** Save one window's page pictures, each with its text; gives the pages
   *  saved. A save that fails leaves its page not done (counted). */
  save(pictures: readonly BookPagePicture[]): Promise<number>;
  /** Stamp the file's count of page pictures, from what is saved and what
   *  is marked: never from this run's memory. */
  count(): Promise<void>;
};

/** The text of a row of the Agent's tab, or '' (no row, no text). */
function textOf(row: Readonly<Record<string, unknown>> | undefined): string {
  const t = row?.[PAGE_TEXT_COLUMN];
  return typeof t === 'string' ? t.trim() : '';
}

/**
 * The marked pages this run reads: all of them, but a page done already (a
 * saved picture of these bytes with its text) whose text row is in the tab
 * (`stored`). A page with a picture and no row is read again (its ask is
 * answered from the tab by hash when it can be, so most often free).
 */
export function pagesToRead(
  marked: readonly number[],
  done: ReadonlySet<number>,
  stored: readonly Readonly<Record<string, unknown>>[],
): number[] {
  const withText = new Set(
    stored
      .filter((r) => textOf(r) !== '')
      .map((r) => String(r[AGENT_KEY_COLUMN] ?? ''))
      .filter((k) => k.startsWith(PAGE_ASK_KEY_PREFIX)),
  );
  return marked.filter((n) => !(done.has(n) && withText.has(`${PAGE_ASK_KEY_PREFIX}${n}`)));
}

/**
 * The page pictures of one window to save: each ask of a page whose row in
 * `sheet` answers THIS picture (the row's hash is the ask's: a paid answer
 * of this run, or one taken from the tab by hash) and has text. A row kept
 * by its key after a stop answers an older picture: no picture is saved for
 * it. An empty answer is no description: its page is not done.
 */
export function windowPagePictures(
  asks: readonly AgentAsk[],
  sheet: ParsedSheet | null,
): BookPagePicture[] {
  if (!sheet) return [];
  const col = (name: string) => sheet.columns.findIndex((c) => c.name === name);
  const [key, text, hash] = [col(AGENT_KEY_COLUMN), col(PAGE_TEXT_COLUMN), col(AGENT_HASH_COLUMN)];
  if (key < 0 || text < 0 || hash < 0) return [];
  const rows = new Map(sheet.rows.map((r) => [String(r[key] ?? ''), r]));
  const out: BookPagePicture[] = [];
  for (const a of asks) {
    if (a.page === null) continue;
    const row = rows.get(a.key);
    const said = typeof row?.[text] === 'string' ? (row[text] as string).trim() : '';
    if (!row || row[hash] !== a.hash || said === '') continue;
    out.push({ page: a.page, bytes: a.picture, mime: a.mime, text: said });
  }
  return out;
}
