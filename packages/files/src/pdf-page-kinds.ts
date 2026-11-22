/**
 * Page types of a PDF (plan page c607711a, milestone M3: in shadow). The
 * router's part 2 (docs/pipelines.md, "The router", "Page types") draws a
 * picture of each page in page windows and asks the decider, one ask a page,
 * what type of page it is. In M3 the answer is only recorded: the route of
 * the file does not change. Pure: no I/O here.
 *
 * - What leaves the box for one page: the 8 fields of {@link PdfPageAsk},
 *   checked in the core by {@link pdfPageAskOf}, the one check. The picture
 *   is a file the step wrote in its job folder; the core takes its bytes from
 *   the step's answer.
 * - Where the answers are kept: the four columns of the Reader's tab
 *   `Pages` ({@link PAGE_KIND_COLUMNS}). The core puts them in
 *   ({@link withPageKinds}) after the Reader's run, for both Readers, so a
 *   Reader that reads in page windows needs no list of every page in its
 *   state. A read again reads them back ({@link pageKindsOfRows}) and puts
 *   them in again, with no ask.
 */
import { PAGE_ASK_KEY_PREFIX, PIPELINE_PAGE_NUMBER_MAX } from './pipelines/contract';
import { PAGE_CLASSES, PAGE_SIZES } from './pdf-kind';
import type { ParsedSheet } from './sheet-to-grid';

/** The page windows of part 2: 25 pages (plan section 4), cut by qpdf. */
export const PDF_PAGE_WINDOW = { pages: 25, mb: 50 } as const;

/** The page picture (the M2 bench, 2026-11-21): long side 1,024 px, a grey
 *  JPEG of quality 80. A picture under the decider's smallest size is not
 *  sent (`minSide`, `minPixels`: DECISION_PICTURE_LIMITS of
 *  @mantle/client-types; a test of @mantle/decisions holds them equal). */
export const PDF_PAGE_PICTURE = {
  maxSide: 1024,
  quality: 80,
  minSide: 256,
  minPixels: 78_400,
} as const;

/** The longest text sample of one page (kindSample). */
export const PDF_PAGE_SAMPLE_MAX_CHARS = 500;

/** What the decider is shown of one page: its number, the file name of its
 *  picture, its size and class, three counts and a text sample. */
export type PdfPageAsk = {
  page: number;
  picture: string;
  size: string | null;
  class: string | null;
  instrument_tags: number;
  line_numbers: number;
  tag_like_tokens: number;
  text_sample: string;
};

/** The file name of a page's picture in the step's job folder. */
export function pagePictureName(page: number): string {
  return `${PAGE_ASK_KEY_PREFIX}${page}.jpg`;
}

const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const nameOrNull = (v: unknown, names: readonly string[]) =>
  v === null || (typeof v === 'string' && names.includes(v));

/**
 * The page ask as a step sent it, or null: not that shape. The one check of
 * what leaves the box for a page ask, in the core: a page number, the name
 * of that page's picture, a size and a class by their fixed names (or
 * null), three whole counts and a text sample no longer than
 * PDF_PAGE_SAMPLE_MAX_CHARS. It gives a copy with the 8 fields only: any
 * other key the step sent stays behind.
 */
export function pdfPageAskOf(v: unknown): PdfPageAsk | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  const page = s.page;
  if (!whole(page) || page < 1 || page > PIPELINE_PAGE_NUMBER_MAX) return null;
  if (s.picture !== pagePictureName(page)) return null;
  if (!nameOrNull(s.size, PAGE_SIZES) || !nameOrNull(s.class, PAGE_CLASSES)) return null;
  if (!whole(s.instrument_tags) || !whole(s.line_numbers) || !whole(s.tag_like_tokens)) return null;
  if (typeof s.text_sample !== 'string' || s.text_sample.length > PDF_PAGE_SAMPLE_MAX_CHARS) {
    return null;
  }
  return {
    page,
    picture: s.picture,
    size: s.size as string | null,
    class: s.class as string | null,
    instrument_tags: s.instrument_tags,
    line_numbers: s.line_numbers,
    tag_like_tokens: s.tag_like_tokens,
    text_sample: s.text_sample,
  };
}

/** What named a page's `Kind` (the column `Kind from`): the decider, or the
 *  rules with why the decider's answer is not the kind. M3 is shadow: no
 *  page is `decider` yet. */
export const PAGE_KIND_FROM = {
  decider: 'decider',
  /** An answer, recorded only (M3, or the use in shadow). */
  shadow: 'rules: shadow',
  /** An answer whose route's summed chance is under the use's floor. */
  low: 'rules: low confidence',
  /** Asked, no answer: the call failed, the breaker was open, or the use
   *  went off. */
  noAnswer: 'rules: no answer',
  /** Past the file's cap of page asks (the router's needs.workers.decider). */
  cap: 'rules: cap',
  /** Past the box's day cap of paid asks (MANTLE_PIPELINE_ASKS_PER_DAY). */
  dayCap: 'rules: day cap',
  /** No picture: the page could not be read, drawn or cut, or its picture
   *  is under the decider's smallest size. */
  notDrawn: 'rules: not drawn',
  /** A blank page (the rules) or a white picture: free, no ask. */
  blank: 'rules: blank',
} as const;

const FROM_VALUES = new Set<string>(Object.values(PAGE_KIND_FROM));

/** One page's type as the router's part 2 left it. `kind`: the rules' kind
 *  of the page (null when no window read it). The decider's answer, when
 *  there is one: its kind and the summed chance of that kind's route. */
export type PdfPageKind = {
  page: number;
  kind: string | null;
  from: string;
  deciderKind: string | null;
  deciderConfidence: number | null;
};

/** The four columns of the tab `Pages` that hold a page's type. The
 *  drawing reader writes `Kind` and `Kind from` itself; the book reader
 *  writes none of them. */
export const PAGE_KIND_COLUMNS = [
  'Kind',
  'Kind from',
  'Decider kind',
  'Decider confidence',
] as const;

const PAGES = 'Pages';

/** The line the file's description gets when the core puts page types in
 *  the tab Pages (withPageKinds): `Kind from` then holds a word of
 *  PAGE_KIND_FROM in place of the Reader's own (`rules`, `picture`,
 *  `other_pages`, which the drawing reader's description explains). */
export const PAGE_KINDS_NOTE =
  'Kind from of a row in Pages may say rules: and what the page ask gave (shadow, low' +
  " confidence, no answer, cap, day cap, not drawn, blank) in place of the reader's own word;" +
  ' the answer is in Decider kind and Decider confidence, and Kind is not changed.';

/** The pages that have a row in the tab `Pages` (its column `Page`): the
 *  pages whose type has a place to stand. No tab, no pages. */
export function pagesWithRows(sheets: readonly ParsedSheet[]): Set<number> {
  const out = new Set<number>();
  for (const sheet of sheets) {
    if (sheet.name !== PAGES) continue;
    const at = sheet.columns.findIndex((c) => c.name === 'Page');
    if (at < 0) continue;
    for (const row of sheet.rows) {
      const n = Number(row[at]);
      if (Number.isInteger(n)) out.add(n);
    }
  }
  return out;
}

/** A Reader's read: its sheets and the description of its database. */
export type PageKindsRead = { sheets: readonly ParsedSheet[]; description?: string | undefined };

/**
 * The read with the page types in the tab `Pages`, by its column `Page`:
 * a column of PAGE_KIND_COLUMNS the tab lacks is added; `Kind` is set only
 * where the Reader left it empty (the drawing reader names its own page
 * kinds); the other three are set. A page with no row keeps no type (its
 * window was not read). The description gets PAGE_KINDS_NOTE here, the one
 * place, so every path that puts page types back (an upload, a read again,
 * the sketch read) says what the words of `Kind from` are. No page types:
 * the read as it is, so a file with no page ask has the rows and the
 * description it had before M3.
 */
export function withPageKinds(
  read: PageKindsRead,
  kinds: readonly PdfPageKind[],
): { sheets: ParsedSheet[]; description?: string | undefined } {
  if (kinds.length === 0) return { sheets: [...read.sheets], description: read.description };
  const description = read.description ? `${read.description} ${PAGE_KINDS_NOTE}` : PAGE_KINDS_NOTE;
  return { sheets: sheetsWithPageKinds(read.sheets, kinds), description };
}

function sheetsWithPageKinds(
  sheets: readonly ParsedSheet[],
  kinds: readonly PdfPageKind[],
): ParsedSheet[] {
  const byPage = new Map(kinds.map((k) => [k.page, k]));
  return sheets.map((sheet) => {
    if (sheet.name !== PAGES) return sheet;
    const columns = [...sheet.columns];
    const at = (name: string, type: 'text' | 'number') => {
      let i = columns.findIndex((c) => c.name === name);
      if (i < 0) {
        columns.push({ name, type });
        i = columns.length - 1;
      }
      return i;
    };
    const pageAt = columns.findIndex((c) => c.name === 'Page');
    if (pageAt < 0) return sheet;
    const kindAt = at('Kind', 'text');
    const fromAt = at('Kind from', 'text');
    const deciderAt = at('Decider kind', 'text');
    const confAt = at('Decider confidence', 'number');
    const rows = sheet.rows.map((row) => {
      const out = [...row];
      while (out.length < columns.length) out.push(null);
      const k = byPage.get(Number(row[pageAt]));
      if (!k) return out;
      if (out[kindAt] === null || out[kindAt] === undefined) out[kindAt] = k.kind;
      out[fromAt] = k.from;
      out[deciderAt] = k.deciderKind;
      out[confAt] = k.deciderConfidence;
      return out;
    });
    return { ...sheet, columns, rows };
  });
}

/** The page types stored in a tab `Pages` (its rows as objects of the five
 *  columns `Page` and PAGE_KIND_COLUMNS, a column the tab lacks as null):
 *  the rows whose `Kind from` is a value of PAGE_KIND_FROM, the pages the
 *  router's part 2 typed. A row of a Reader before M3 (`rules`, `picture`,
 *  `other_pages`, or none) holds no page type. */
export function pageKindsOfRows(rows: readonly Record<string, unknown>[]): PdfPageKind[] {
  const out: PdfPageKind[] = [];
  for (const r of rows) {
    const page = Number(r.Page);
    const from = r['Kind from'];
    if (!Number.isInteger(page) || page < 1 || typeof from !== 'string' || !FROM_VALUES.has(from)) {
      continue;
    }
    const decider = r['Decider kind'];
    const conf = r['Decider confidence'];
    out.push({
      page,
      kind: typeof r.Kind === 'string' ? r.Kind : null,
      from,
      deciderKind: typeof decider === 'string' && decider ? decider : null,
      deciderConfidence: typeof conf === 'number' && Number.isFinite(conf) ? conf : null,
    });
  }
  return out.sort((a, b) => a.page - b.page);
}
