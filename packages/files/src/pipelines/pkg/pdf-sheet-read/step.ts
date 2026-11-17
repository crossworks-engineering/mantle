/**
 * The Agent `pdf-sheet-read` (docs/pipelines.md, "The PDF sheet read"): it
 * reads a PDF drawing that the PDF router called a scan, an isometric, an
 * other drawing or unsure. For each page it asks the vision worker for the
 * title block fields and the list of the identifiers on the sheet (tags,
 * line numbers, sheet numbers), into the tabs `Title block` and `Sheet list`.
 *
 * Its one step draws the pictures with no model, in the parser's pdfjs
 * child (`job.pdfPictures`): the whole of each page up to the page cap and
 * its two halves, and on page 1 the title block corner, at a sharper
 * scale. A model reads a picture at a fixed budget of its own, so a half
 * gives it the marks of a dense sheet at twice the area each (bench
 * 2026-11-17, two runs: the values read on 10 drawings went up on 5 to 6
 * of them, on a dense flow diagram from 1 to 20 and 22 of 40). The
 * corner is the
 * box of the Reader `drawing-pdf` (its options in force reach the step as
 * `state.readerOptions`), so a site that set its box gets the same crop.
 * The kind is the one stored in the file's database (`request.kind`): a
 * file of any other kind is `not_mine`, one parser job and no call.
 *
 * The step writes nothing but its pictures, keeps no state and has no
 * second step: the core makes the paid calls and writes the rows.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PARSER_PICTURES_BUDGET_BYTES } from '../../../parser-wire';
import { withPdf } from '../../../pdf-open';
import { titleBlockOf } from '../../../pdf-rows';
import type { RenderedWindow } from '../../../rasterize';
import {
  PIPELINE_ASK_FIELDS_MAX,
  VISION_WORKER,
  type PipelineAskField,
  type PipelineCall,
  type PipelineStep,
} from '../../contract';

/** The kinds of the PDF router this Agent reads: the drawings with no
 *  useful text layer, and the files the rules left unsure. */
export const KINDS: readonly string[] = ['scan', 'isometric', 'unsure', 'other_drawing'];

/** The page cap of the option `pages`, and the most asks of a file: each
 *  page has three (the whole page and its two halves), page 1 one more
 *  (its title block corner). */
export const PAGES_MAX = 10;
export const ASKS_MAX = 3 * PAGES_MAX + 1;

/** A half is this part of the page across its long side: the two halves
 *  overlap by a tenth of the page, so a mark on the cut is whole in one. */
export const HALF = 0.55;

/** The two halves of a page, as windows of the shown page (fractions from
 *  the top left): left and right of a wide page, top and bottom of a tall
 *  one. */
export function halvesOf(wide: boolean): [number, number, number, number][] {
  return wide
    ? [
        [0, 0, HALF, 1],
        [1 - HALF, 0, 1, 1],
      ]
    : [
        [0, 0, 1, HALF],
        [0, 1 - HALF, 1, 1],
      ];
}

/** The fields of the tab `Title block`, the same on every site. A site adds
 *  its own with the option `more_fields`. */
export const FIELDS: readonly PipelineAskField[] = [
  { name: 'Drawing number', hint: 'the number of the drawing, as the title block gives it' },
  { name: 'Title', hint: 'the title of the drawing, as one line' },
  { name: 'Revision', hint: 'the latest revision of the drawing, a letter or a number' },
  { name: 'Date', hint: 'the date of the latest revision, as it is written' },
  {
    name: 'Sheet',
    hint: 'the sheet number, with the count of sheets when it is given, such as 1 of 3',
  },
  { name: 'Line number', hint: 'the piping line number the drawing is of, when it has one' },
  { name: 'Unit or area', hint: 'the plant unit or area of the drawing' },
  { name: 'Project', hint: 'the project name or number' },
  { name: 'Drawn by', hint: 'the name or the initials of the person who drew it' },
  { name: 'Checked by', hint: 'the name or the initials of the person who checked it' },
];

/** The columns of the Agent's tabs that a field may not take, in lower
 *  case: SQLite takes column names with no regard to case. */
const TAKEN: ReadonlySet<string> = new Set(['key', 'model', 'input hash']);

/**
 * The fields of an ask: {@link FIELDS}, then each word of the option
 * `more_fields` as a field (an `_` is a space), in its order. A word that
 * names a field or a column the tab has already, in any case, is left out,
 * and so is one past PIPELINE_ASK_FIELDS_MAX.
 */
export function fieldsOf(options: Readonly<Record<string, unknown>>): PipelineAskField[] {
  const out: PipelineAskField[] = [...FIELDS];
  const seen = new Set([...TAKEN, ...FIELDS.map((f) => f.name.toLowerCase())]);
  const more = Array.isArray(options.more_fields) ? options.more_fields : [];
  for (const word of more) {
    if (typeof word !== 'string' || out.length >= PIPELINE_ASK_FIELDS_MAX) continue;
    const name = word.replace(/_/g, ' ').trim();
    if (name === '' || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, hint: `the ${name.toLowerCase()} of the drawing, as it is written` });
  }
  return out;
}

/** The pages the step reads: the option `pages`, 1 to PAGES_MAX. */
export function pagesOf(options: Readonly<Record<string, unknown>>): number {
  const n = options.pages;
  return typeof n === 'number' && Number.isInteger(n) ? Math.min(PAGES_MAX, Math.max(1, n)) : 10;
}

/** The pictures. A whole page at 200 dots an inch, its longest side 4800
 *  pixels at most; the corner at 300. The old whole-page read, which read
 *  the most line numbers in the P0 score, drew at 144, and an A0 sheet at
 *  about 110 under its pixel cap: 4800 gives an A0 108, and an A4 or A3
 *  sheet (28 of the 29 pages of that set) is under the cap at 200. A
 *  picture is a PNG, or a JPEG when the PNG is past 5 MB, each under the 10
 *  MB of an ask. All the pictures of a run stay in the parser's budget of
 *  an answer (PARSER_PICTURES_BUDGET_BYTES): a picture past what is left
 *  of it is not asked, with a warning. */
export const PAGE_DPI = 200;
export const CORNER_DPI = 300;
export const MAX_SIDE = 4800;
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;

const isPng = (b: Buffer) => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50;
/** The file name of a picture, by its type. */
const fileOf = (name: string, bytes: Buffer) => `${name}.${isPng(bytes) ? 'png' : 'jpg'}`;

/** The corner of a sheet of `widthMm` x `heightMm` that the title block box
 *  takes, as fractions from the top left of the shown page. */
export function cornerOf(
  widthMm: number,
  heightMm: number,
  box: { width: number; height: number },
): [number, number, number, number] {
  const x0 = Math.max(0, 1 - box.width / widthMm);
  const y0 = Math.max(0, 1 - box.height / heightMm);
  return [x0, y0, 1, 1];
}

/** A window of a page: x0, y0, x1, y1 as fractions of the shown page. */
type Window = [number, number, number, number];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const step: PipelineStep = async (req, job) => {
  const ext = (req.file?.ext ?? '').toLowerCase();
  if (ext !== 'pdf' || req.kind === undefined || !KINDS.includes(req.kind)) {
    return { status: 'not_mine' };
  }
  const fields = fieldsOf(req.options);
  // The pages there are, up to the cap, and the shape of each on paper
  // (page 1's size places the corner; each page's halves follow its shape):
  // a page that is there and gives no picture is told apart from one past
  // the end. No page is drawn here.
  const shapes = await withPdf(await job.bytes(), {}, async ({ doc }) => {
    const out: { wide: boolean; widthMm: number; heightMm: number }[] = [];
    for (let n = 1; n <= Math.min(pagesOf(req.options), doc.numPages); n++) {
      // A page pdfjs cannot load is taken as an A3 sheet: its drawing
      // fails below, and the run says which page.
      const page = await doc.getPage(n).catch(() => null);
      const shown = page?.getViewport({ scale: 1 }) ?? { width: 1190.55, height: 841.89 };
      out.push({
        wide: shown.width >= shown.height,
        widthMm: (shown.width * 25.4) / 72,
        heightMm: (shown.height * 25.4) / 72,
      });
      page?.cleanup();
    }
    return out;
  }).catch(() => null);
  // A run that cannot draw a picture of a page that is there ends
  // `failed`: nothing is asked or written, so the paid rows of a run before
  // stay as they are (the time ran out, the child was stopped, pdfjs cannot
  // draw the page). The trace says why. A page pdfjs can never draw keeps
  // this Agent off the file until a person lowers the option `pages`.
  const failed = (why: string) => ({ status: 'failed' as const, warnings: [why] });
  if (!shapes || shapes.length === 0) return failed('The file could not be opened.');
  const readerOptions =
    isObject(req.state) && isObject(req.state.readerOptions) ? req.state.readerOptions : {};
  const box = titleBlockOf(readerOptions);
  const picture = (pageNumber: number, scale: number, window?: Window) => ({
    pageNumber,
    ...(window ? { box: window } : {}),
    scale,
    maxSide: MAX_SIDE,
    maxBytes: PICTURE_MAX_BYTES,
    // A CAD sheet exported as one large picture is drawn, not white.
    largeImages: true,
  });
  const warnings: string[] = [];

  // One draw, page by page (the pictures of a page one after the other, so
  // its images are decoded one time): each page whole, page 1's corner,
  // then the page's two halves.
  type Ask = { key: string; page: number; list: boolean; order: number };
  const page1 = shapes[0]!;
  const asks: Ask[] = [];
  const windows: ReturnType<typeof picture>[] = [];
  for (const [i, shape] of shapes.entries()) {
    const n = i + 1;
    asks.push({ key: `page-${n}`, page: n, list: true, order: 1 });
    windows.push(picture(n, PAGE_DPI / 72));
    if (n === 1) {
      asks.push({ key: 'page-1-title-block', page: 1, list: false, order: 0 });
      windows.push(picture(1, CORNER_DPI / 72, cornerOf(page1.widthMm, page1.heightMm, box)));
    }
    for (const [h, half] of halvesOf(shape.wide).entries()) {
      asks.push({ key: `page-${n}-half-${h + 1}`, page: n, list: true, order: 2 });
      windows.push(picture(n, PAGE_DPI / 72, half));
    }
  }
  const drawn = await job.pdfPictures(windows, job.deadline);
  const lost = asks.findIndex((_, i) => !drawn[i]);
  if (lost >= 0) {
    return failed(
      asks[lost]!.order === 0
        ? 'The title block of page 1 could not be drawn.'
        : `Page ${asks[lost]!.page} could not be drawn.`,
    );
  }

  const calls: PipelineCall[] = [];
  /** The bytes of pictures the run may still send (the parser's budget). */
  let left = PARSER_PICTURES_BUDGET_BYTES;
  const add = async (ask: Ask, p: RenderedWindow) => {
    // A picture with nothing drawn on it is never read: the model would
    // answer for a white page.
    if (p.blank) {
      warnings.push(`The picture ${ask.key} is blank, and is not read.`);
      return;
    }
    if (p.png.length > Math.min(PICTURE_MAX_BYTES, left)) {
      warnings.push(
        `The picture ${ask.key} is over 5 MB or past the budget of the run, and is not read.`,
      );
      return;
    }
    left -= p.png.length;
    const file = fileOf(ask.key, p.png);
    await fs.writeFile(path.join(job.dir, file), p.png);
    calls.push({
      call: 'worker',
      worker: VISION_WORKER,
      key: ask.key,
      input: { picture: file, fields, page: ask.page, ...(ask.list ? { list: true } : {}) },
    });
  };
  // The asks: the title block first, then each page whole, then the
  // halves. A dense page's list may fail its ask, and a failed ask stops
  // the asks after it; the picture budget is spent in the same order.
  const order = asks.map((_, i) => i).sort((a, b) => asks[a]!.order - asks[b]!.order || a - b);
  for (const i of order) await add(asks[i]!, drawn[i]!);
  return { status: 'ok', calls, ...(warnings.length > 0 ? { warnings } : {}) };
};
