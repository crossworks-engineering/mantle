/**
 * Page types of a PDF (plan page c607711a, milestones M3 and M4). The
 * router's part 2 (docs/pipelines.md, "The router", "Page types") draws a
 * picture of each page in page windows and asks the decider, one ask a page,
 * what type of page it is. In shadow the answer is only recorded; on a box
 * whose `pdf_kind` is live (M4) a used answer names the page's lane, and the
 * lanes of the pages name the file's frame ({@link pdfFrameKindOf}): the
 * Reader that reads it. Pure: no I/O here.
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
 *  rules with why the decider's answer is not the kind. `decider` only on a
 *  box whose `pdf_kind` is live (M4, pageKindsAt). */
export const PAGE_KIND_FROM = {
  /** A used answer (live, at or over the floor): `Kind` is its kind. */
  decider: 'decider',
  /** An answer, recorded only: the use in shadow. */
  shadow: 'rules: shadow',
  /** On a live box: an answer whose route's summed chance is under the
   *  use's floor (pageKindsAt; the page asks give it at the ask too). */
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
  "Kind from of a row in Pages may say decider (the page ask's answer is the page's Kind and" +
  ' its lane) or rules: and why the answer is not used (shadow, low confidence, no answer, cap,' +
  " day cap, not drawn, blank) in place of the reader's own word; the answer is in Decider" +
  ' kind and Decider confidence.';

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
 * a column of PAGE_KIND_COLUMNS the tab lacks is added; `Kind` is set where
 * the Reader left it empty (the drawing reader names its own page kinds),
 * and for a used answer (`decider`) over the Reader's own; the other three
 * are set. A page with no row keeps no type (its
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
      // A used answer names the page's Kind over the Reader's own (M4).
      if (k.from === PAGE_KIND_FROM.decider || out[kindAt] === null || out[kindAt] === undefined) {
        out[kindAt] = k.kind;
      }
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

// ─── Lanes and the frame (M4: routing by page types, live) ──────────────────

/** The options of a page by route (the M2 bench): `office` is read by the
 *  book reader, `drawing` by the drawing reader. */
export const PDF_PAGE_ROUTES = {
  office: ['document', 'table', 'datasheet'],
  drawing: ['pid', 'pfd', 'isometric', 'equipment_drawing', 'other_drawing'],
} as const;

export type PdfPageRoute = keyof typeof PDF_PAGE_ROUTES;

/** Under this route sum a page's picture is kept (Jason, 2026-11-23): a
 *  graph, a chart, a sketch chart or a cover page is typed office with a low
 *  sum, and an LLM looks at its picture at question time. On a live box the
 *  PDF page read reads such a page and saves its picture with its text. */
export const PDF_PAGE_PICTURE_BELOW = 0.75;

/** The route of a page kind: an option of PDF_PAGE_ROUTES, or a rules kind
 *  (`scan`, a raster sheet larger than A3, is a drawing). Null: no route
 *  (`unsure`, `none`, `book`, null). */
export function pageRouteOfKind(kind: string | null): PdfPageRoute | null {
  if (kind === null) return null;
  if ((PDF_PAGE_ROUTES.office as readonly string[]).includes(kind)) return 'office';
  if (kind === 'scan' || (PDF_PAGE_ROUTES.drawing as readonly string[]).includes(kind)) {
    return 'drawing';
  }
  return null;
}

/**
 * The page types as this read uses them (pure; M4): a page with an answer
 * is `decider` when the box is live and the answer's route sum is at or
 * over the floor (its `Kind` is then the answer's kind); on a live box an
 * answer under the floor is `rules: low confidence`; in shadow every answer
 * is `rules: shadow` (shadow is why none is used, whatever its sum, so
 * `rules: low confidence` is a live read's word alone). Worked out
 * at every read with a decider, from the stored sum, so an answer of a
 * shadow week is used once the box is live, with no ask. A page once
 * `decider` whose answer is no longer used has no rules kind kept: `Kind`
 * is the Reader's own again (withPageKinds). Pages with no answer as they
 * are.
 */
export function pageKindsAt(
  kinds: readonly PdfPageKind[],
  at: { live: boolean; floor: number },
): PdfPageKind[] {
  return kinds.map((k) => {
    const conf = k.deciderConfidence;
    if (k.deciderKind === null || conf === null) return k;
    if (at.live && conf >= at.floor) {
      return { ...k, kind: k.deciderKind, from: PAGE_KIND_FROM.decider };
    }
    return {
      ...k,
      kind: k.from === PAGE_KIND_FROM.decider ? null : k.kind,
      from: at.live ? PAGE_KIND_FROM.low : PAGE_KIND_FROM.shadow,
    };
  });
}

/**
 * The kind of a file by the lanes of its pages (Jason, Q4, 2026-11-21; M4):
 * the route of most pages with ink, a tie to the book. A page votes by the
 * route of its `Kind` (a used answer's, else its rules kind: pageRouteOfKind);
 * a blank page and a page with no route do not vote. With no used answer
 * (`decider`) on any page the kind is `kind`, as named before. Office wins:
 * `book`. Drawing wins: `kind` when it is a drawing kind or `book`, else
 * `unsure`.
 * The frame picks the lane, never a drawing kind of its own: a kind names
 * the readers of a file (`unsure` is read by the drawing reader, the sketch
 * read and the PDF sheet read; a `pid` by its text layer alone), so a raster
 * drawing the rules left unsure keeps every reader it had. Pure, one count.
 */
export function pdfFrameKindOf(kinds: readonly PdfPageKind[], kind: string): string {
  if (!kinds.some((k) => k.from === PAGE_KIND_FROM.decider)) return kind;
  let office = 0;
  let drawing = 0;
  for (const k of kinds) {
    if (k.from === PAGE_KIND_FROM.blank) continue;
    const route = pageRouteOfKind(k.kind);
    if (route === 'office') office += 1;
    else if (route === 'drawing') drawing += 1;
  }
  if (office >= drawing) return 'book';
  // A book stays a book: its reader reads in page windows (a file past the
  // size pdfjs opens, a long file), which the drawing reader cannot, and
  // its drawing pages go to the PDF sheet read by their lane.
  return pageRouteOfKind(kind) === 'drawing' || kind === 'book' ? kind : 'unsure';
}
