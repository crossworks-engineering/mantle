/**
 * The PDF drawing read, as the parser runs it (plan page 11a16779, section
 * 10): every page's facts with no model, a look at up to three raster pages
 * through the caller's eye (OpenCV, in the parser's Python tier), a kind a
 * page and one kind for the file by the rules of ./pdf-kind.ts.
 *
 * It runs in the parser only (`@mantle/files/readers/pdf-drawing`): pdfjs
 * is never opened in the brain. The answer is numbers and fixed labels, and
 * for an unsure file one small text sample for the decider.
 */

import {
  KIND_SAMPLE_MAX_CHARS,
  fileKindOf,
  isRasterClass,
  kindSample,
  pageFacts,
  pageKindOf,
  type PageEye,
  type PageFacts,
  type PageKind,
  type PdfKind,
} from './pdf-kind';
import { DEFAULT_BUDGETS, readPdfPages, type Budgets } from './pdf-primitives';
import { declaresOversizeImage } from './pdf-open';
import { markTemplates, pageRows, type PageRows, type TitleBlockMm } from './pdf-rows';

/** The parser's job reads the box from its options (server/parser/src/jobs.ts). */
export { titleBlockOf } from './pdf-rows';
import { renderPdfWindows, type PageWindow, type RenderedWindow } from './rasterize';

/** Raster pages of one file the eye looks at, spread evenly over the file's
 *  raster pages that may get a picture (three: the first, the middle one and
 *  the last). A raster
 *  page not looked at takes what those say, and its `kindFrom` says so
 *  (`other_pages`): a scan when one of them is a drawing, a document when
 *  all of them are typed pages. */
export const EYE_MAX_PAGES = 3;
/** The eye's picture: 144 DPI on a sheet up to A1, less on a larger one
 *  (the render cap). The bench measure of the eye ran at this size. */
export const EYE_SCALE = 2;
/** Pages whose text may go into the sample of an unsure file. */
const SAMPLE_MAX_PAGES = 3;
/**
 * The most pages one read keeps a row for. The page count is a number the
 * file declares, and each page costs a row in the answer and in the Pages
 * tab. The largest real file measured holds 855 pages. `numPages` still
 * gives the declared count, and the File tab states the pages past the cap.
 */
export const DRAWING_MAX_PAGES = 5000;
/**
 * The most rows one read lists, all pages together: words, tags, line
 * numbers and markups. The answer and the database hold each as a row; the
 * fullest P&ID sheet measured holds about 1,500 words and 200 tags. A page
 * whose rows would pass it has no rows, and says so (`rows_not_listed`).
 */
export const DRAWING_MAX_ROWS = 300_000;
/**
 * The most characters of word and markup text (with a markup's author) one
 * read lists, all pages together. A word has no length bound of its own,
 * so the row count alone does not bound the answer's size. A real file at
 * the row cap holds about 2.5 million. Text of plain characters stays well
 * under `PARSER_ANSWER_MAX_BYTES`; text of control characters (six bytes
 * each on the wire) can still pass it, and the file then gets the word
 * `too-large`. A page past this cap is treated as past the row cap.
 */
export const DRAWING_MAX_CHARS = 8_000_000;

/**
 * The time a file's pages may take, inside the job's own limit
 * (`PARSER_JOB_TIMEOUT_MS.pdfDrawing`, 240 s), which also has to hold the
 * eye's pictures. The page budgets are the reader's defaults.
 */
export const DRAWING_BUDGETS: Required<Budgets> = { ...DEFAULT_BUDGETS, maxFileMs: 150_000 };
/**
 * The picture budget: no picture is started later than this after the read
 * began. One render cannot be stopped from inside its process (pdfjs draws
 * in long steps), so this deadline alone bounds nothing: the parser gives
 * `render` a function that draws in a child process and kills it at the
 * job's own limit (server/parser/src/pictures.ts). A raster page with no
 * picture is named by its size, by the file's other pictures, or stays
 * unsure; `kindFrom` says which.
 */
export const EYE_DEADLINE_MS = 150_000;

/**
 * Draw windows of the file's pages. Null in a window's place when it has
 * no picture (it could not be drawn, or the time ran out). The default
 * draws in this process ({@link renderPdfWindows}); the parser draws in a
 * child it can kill.
 */
export type RenderFn = (
  windows: readonly PageWindow[],
  deadline: number,
) => Promise<(RenderedWindow | null)[]>;

/** Look at one picture of a page. Null when the eye cannot say: the page
 *  then stays unsure, it is never guessed. */
export type EyeFn = (png: Buffer, widthMm: number) => Promise<PageEye | null>;

/** Where a page's kind came from: the rules on its own facts, its own
 *  picture, or the pictures of the file's other raster pages. */
export type KindFrom = 'rules' | 'picture' | 'other_pages';

export type PdfDrawingPage = PageFacts & {
  kind: PageKind;
  kindFrom: KindFrom;
  /** What the eye saw, for a raster page it looked at. */
  eye: PageEye | null;
  /**
   * The page's words, tags, line numbers and markups (./pdf-rows.ts), for a
   * page with text or markups that is not a document page. Left out for a
   * document page, a page with no text read, and a page past the file's
   * word cap (its `notes` say so).
   */
  rows?: PageRows;
};

export type PdfDrawing = {
  /** The page count the file declares. `pages` holds a row for the first
   *  `DRAWING_MAX_PAGES` of them. */
  numPages: number;
  pageCountMayBeShort: boolean;
  kind: PdfKind;
  pages: PdfDrawingPage[];
  /** For an unsure file: a small text sample for the decider. Else ''. */
  sample: string;
  /**
   * True when the reader left nothing out: every page has a row, every row
   * was read whole (status ok), no image was too large to open, no page
   * reads as empty while it draws content the reader does not follow, and
   * no picture of a page is left with nothing to name it. The one fact a
   * `document` needs, from the rules or from the decider: a file with
   * something left out keeps its database, where that is stated.
   */
  allRead: boolean;
  /** True when the file declares an image larger than the reader opens
   *  (`PDF_MAX_IMAGE_PIXELS`): that image is not read, so its page can
   *  count as blank or as text alone. Which page is not known. */
  largeImageNotRead: boolean;
};

export async function readPdfDrawing(
  bytes: Buffer,
  opts: {
    eye?: EyeFn;
    render?: RenderFn;
    budgets?: Budgets;
    eyeDeadlineMs?: number;
    /** The most pages to keep a row for (`DRAWING_MAX_PAGES`). */
    maxPages?: number;
    /** The most rows to list (`DRAWING_MAX_ROWS`). */
    maxRows?: number;
    /** The most characters of text to list (`DRAWING_MAX_CHARS`). */
    maxChars?: number;
    /** The title block box of the rows (the reader's options). Left out:
     *  `TITLE_BLOCK_MM` (./pdf-rows.ts). */
    titleBlock?: TitleBlockMm;
  } = {},
): Promise<PdfDrawing> {
  const deadline = Date.now() + (opts.eyeDeadlineMs ?? EYE_DEADLINE_MS);
  // First, while nothing else has used the job's time: a bounded scan of
  // the raw bytes.
  const largeImageNotRead = declaresOversizeImage(bytes);
  const samples: string[] = [];
  // The rows of each page, kept until the page's kind is final.
  const rowsOf = new Map<number, PageRows>();
  let listed = 0;
  let listedChars = 0;
  const maxRows = opts.maxRows ?? DRAWING_MAX_ROWS;
  const maxChars = opts.maxChars ?? DRAWING_MAX_CHARS;
  const read = await readPdfPages(
    new Uint8Array(bytes),
    {
      verbosity: 0,
      budgets: opts.budgets ?? DRAWING_BUDGETS,
      maxPages: opts.maxPages ?? DRAWING_MAX_PAGES,
    },
    (p) => {
      const facts = pageFacts(p);
      // A typed page of a document gives no rows: its words are the file's
      // text already. Every other page with text or markups gives its rows,
      // inside the file's word cap.
      const rows =
        pageKindOf(facts) === 'document' ? null : pageRows(p, undefined, opts.titleBlock);
      if (rows && rows.words.length + rows.markups.length > 0) {
        // Every row counts: one word can give many tags (a slash list).
        const count =
          rows.words.length + rows.tags.length + rows.lines.length + rows.markups.length;
        const chars =
          rows.words.reduce((n, w) => n + w.text.length, 0) +
          rows.markups.reduce((n, m) => n + m.text.length + m.author.length, 0);
        if (listed + count <= maxRows && listedChars + chars <= maxChars) {
          listed += count;
          listedChars += chars;
          rowsOf.set(facts.page, rows);
          if (rows.markupsNotPaired) {
            facts.notes = [...(facts.notes ?? []), 'markups_not_paired'];
          }
        } else {
          facts.notes = [...(facts.notes ?? []), 'rows_not_listed'];
        }
      }
      // Only an unsure page's text can be asked about, and only a few pages.
      if (
        samples.length < SAMPLE_MAX_PAGES &&
        'texts' in p &&
        p.texts &&
        pageKindOf(facts) === 'unsure' &&
        !isRasterClass(facts.class)
      ) {
        // A page with no text (outlined letters, markups only) gives no
        // sample, and takes no slot.
        const sample = kindSample(p.texts);
        if (sample) samples.push(sample);
      }
      return facts;
    },
  );

  // The eye, on raster pages spread over the file, while there is time.
  const eyes = new Map<number, PageEye>();
  // The pages a picture was asked for, answered or not.
  const asked = new Set<number>();
  const raster = spread(
    read.pages.filter((f) => isRasterClass(f.class) && f.status === 'ok'),
    EYE_MAX_PAGES,
  );
  const look = opts.eye;
  if (look && raster.length > 0 && Date.now() < deadline) {
    const render: RenderFn =
      opts.render ?? ((windows, until) => renderPdfWindows(bytes, windows, { deadline: until }));
    const pictures = await render(
      raster.map((f) => ({ pageNumber: f.page, scale: EYE_SCALE })),
      deadline,
    );
    for (const f of raster) asked.add(f.page);
    for (const [i, picture] of pictures.entries()) {
      const eye = picture ? await look(picture.png, picture.widthMm) : null;
      if (eye) eyes.set(raster[i]!.page, eye);
    }
  }
  // A raster page with no picture of its own takes what the looked-at
  // pages of this file say: a scan when one of them is a drawing, a document
  // when every one of them is a typed page. With no picture at all, nothing
  // says what it is.
  const seen = raster.filter((f) => eyes.has(f.page)).map((f) => pageKindOf(f, eyes.get(f.page)));
  const rasterDefault: PageKind | null =
    seen.includes('scan') || seen.includes('isometric')
      ? 'scan'
      : seen.length > 0 && seen.every((k) => k === 'document')
        ? 'document'
        : null;

  const pages: PdfDrawingPage[] = read.pages.map((f) => {
    const eye = eyes.get(f.page) ?? null;
    // What the other pictures say is for a page that was never looked at.
    // A page that was asked about and got no answer (its picture could not
    // be drawn, or showed nothing) is not known: it stays unsure.
    const kind = pageKindOf(f, eye, asked.has(f.page) ? null : rasterDefault);
    // `other_pages` only when they changed the answer: a large sheet is a
    // scan by its own size, and a page nothing could name stays unsure.
    const kindFrom: KindFrom = eye
      ? 'picture'
      : kind !== pageKindOf(f, null, null)
        ? 'other_pages'
        : 'rules';
    // A raster page the pictures named a typed page gives no rows either.
    const rows = kind === 'document' ? undefined : rowsOf.get(f.page);
    return { ...f, kind, kindFrom, eye, ...(rows ? { rows } : {}) };
  });
  markTemplates(pages.map((p) => p.rows));
  // Whether the reader left nothing out: every page has a row, every row
  // was read whole, no image was too large to open (its page then counts as
  // blank, or as its text alone), no page reads as empty while it draws
  // content this reader does not follow, and no picture of a page is left
  // with nothing to name it (asked about and not answered, or never looked
  // at with no other picture to go by). The ONE fact a `document` needs,
  // from the rules and from the decider alike: every known skip is in it.
  const allRead =
    read.numPages <= pages.length &&
    !largeImageNotRead &&
    pages.every(
      (p) =>
        p.status === 'ok' &&
        !(p.class === 'blank' && p.notes?.includes('drawn_content_not_read')) &&
        !(isRasterClass(p.class) && p.kind === 'unsure'),
    );
  const kind = fileKindOf(
    pages.map((p) => p.kind),
    allRead,
  );
  return {
    numPages: read.numPages,
    pageCountMayBeShort: read.pageCountMayBeShort,
    kind,
    pages,
    sample: kind === 'unsure' ? samples.join(' ').slice(0, KIND_SAMPLE_MAX_CHARS).trim() : '',
    allRead,
    largeImageNotRead,
  };
}

/** Up to `n` items spread evenly over `items`, the first and the last
 *  among them, in order. */
function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  if (n <= 1) return items.slice(0, Math.max(0, n));
  return Array.from(
    { length: n },
    (_, j) => items[Math.round((j * (items.length - 1)) / (n - 1))]!,
  );
}
