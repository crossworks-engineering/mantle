/**
 * The Agent `pdf-page-read` (docs/pipelines.md, "The book reader"): vision
 * for the pages of a PDF book that the book reader `pdf-pages` could not
 * read well (its tab Pages says Method `vision`: OCR's mean confidence under
 * the floor, too few characters, or a figure). One ask a page, keyed
 * `page-<N>` with N the page of the original file, and one field, `Text`:
 * the core puts that text over the Reader's for the page's passage (P3,
 * `produces.pages`), and it is the description of the page's picture (G1).
 *
 * The pages to read come from the core as `state.visionPages` (the Reader's
 * tab Pages, read by bookVisionPagesOf in packages/content/src/
 * book-pages.ts), so a page the Reader read well is never asked. The step
 * reads them in the page window the core gives (`pageFrom`, `pageTo`) and
 * asks only the first `pages` of the file's marked pages (the option).
 *
 * Its one step draws the pictures with no model, in the parser's pdfjs
 * child (`job.pdfPictures`), before any paid call. A marked page that
 * cannot be drawn ends the run `failed`: nothing is asked or written, so
 * the paid rows of a run before stay (the rule "fewer asks replace rows",
 * docs/pipelines.md, "Agents"). No state, no second step.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withPdf } from '../../../pdf-open';
import type { RenderFn } from '../../../pdf-drawing';
import {
  PAGE_ASK_KEY_PREFIX,
  PAGE_TEXT_COLUMN,
  PIPELINE_ASK_PAGE_MAX,
  PIPELINE_PICTURES_MAX_BYTES,
  VISION_WORKER,
  type PipelineAskField,
  type PipelineCall,
  type PipelineStep,
} from '../../contract';

/** The kind of the PDF router this Agent reads. */
export const KIND = 'book';

/** The one field of every ask: the text of the page. */
export const FIELDS: readonly PipelineAskField[] = [
  {
    name: PAGE_TEXT_COLUMN,
    hint: 'all the text of the page as it is written, line by line; a table one row a line, its cells split by " | "; a figure: its labels and a one-line description',
  },
];

/** A page picture: 200 dots an inch, its longest side 4000 pixels at most;
 *  a PNG, or a JPEG when the PNG is past PICTURE_MAX_BYTES. */
export const PAGE_DPI = 200;
export const MAX_SIDE = 4000;
export const PICTURE_MAX_BYTES = 4 * 1024 * 1024;
/** The default of the option `pages` (the manifest's). */
export const PAGES_DEFAULT = 2000;

const isPng = (b: Buffer) => b.length >= 4 && b[0] === 0x89 && b[1] === 0x50;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The pages the core marked for vision (`state.visionPages`), each a
 *  whole number from 1 to PIPELINE_ASK_PAGE_MAX, once each, in order. */
export function visionPagesOf(state: unknown): number[] {
  const raw = isObject(state) && Array.isArray(state.visionPages) ? state.visionPages : [];
  const pages = raw.filter(
    (n): n is number => Number.isInteger(n) && n >= 1 && n <= PIPELINE_ASK_PAGE_MAX,
  );
  return [...new Set(pages)].sort((a, b) => a - b);
}

/** The option `pages`: the most marked pages of a file to read. */
export function pagesOf(options: Readonly<Record<string, unknown>>): number {
  const n = options.pages;
  return typeof n === 'number' && Number.isInteger(n)
    ? Math.min(PIPELINE_ASK_PAGE_MAX, Math.max(1, n))
    : PAGES_DEFAULT;
}

type Picture = NonNullable<Awaited<ReturnType<RenderFn>>[number]>;

export const step: PipelineStep = async (req, job) => {
  const ext = (req.file?.ext ?? '').toLowerCase();
  if (ext !== 'pdf' || req.kind !== KIND) return { status: 'not_mine' };
  const failed = (why: string) => ({ status: 'failed' as const, warnings: [why] });
  // The file's first marked pages, up to the option; of them, this window's.
  const all = visionPagesOf(req.state);
  const cap = pagesOf(req.options);
  const marked = all.slice(0, cap);
  const from = req.pageFrom ?? 1;
  let to = req.pageTo;
  if (to === undefined) {
    const count = await withPdf(await job.bytes(), {}, async ({ doc }) => doc.numPages).catch(
      () => null,
    );
    if (count === null) return failed('The file could not be opened.');
    to = from + count - 1;
  }
  const here = marked.filter((n) => n >= from && n <= to);
  // The marked pages of this window past the option are said, never cut in
  // silence.
  const past = all.slice(cap).filter((n) => n >= from && n <= to);
  const capWarning =
    past.length > 0
      ? [
          `${past.length} marked pages of this window are past the option pages (${cap}), and are not read.`,
        ]
      : [];
  if (here.length === 0) {
    return { status: 'ok', calls: [], ...(capWarning.length > 0 ? { warnings: capWarning } : {}) };
  }

  const drawn = await job.pdfPictures(
    here.map((n) => ({
      pageNumber: n - from + 1,
      scale: PAGE_DPI / 72,
      maxSide: MAX_SIDE,
      maxBytes: PICTURE_MAX_BYTES,
      largeImages: true,
    })),
    job.deadline,
  );
  const lost = here.findIndex((_, i) => !drawn[i]);
  if (lost >= 0) return failed(`Page ${here[lost]} could not be drawn.`);

  const warnings: string[] = [...capWarning];
  const calls: PipelineCall[] = [];
  /** The bytes of pictures the run may still send (the parser's budget). */
  let left = PIPELINE_PICTURES_MAX_BYTES;
  for (const [i, n] of here.entries()) {
    const p = drawn[i] as Picture;
    const key = `${PAGE_ASK_KEY_PREFIX}${n}`;
    // A white picture is never read: the model would answer for a white page.
    if (p.blank) {
      warnings.push(`Page ${n} is blank, and is not read.`);
      continue;
    }
    // Past the budget of one answer: the window fails, so no marked page is
    // left out of a run that says it is done (the window of 15 pages keeps
    // under it: the manifest).
    if (p.png.length > left) return failed(`Page ${n} is past the picture budget of the window.`);
    left -= p.png.length;
    const file = `${key}.${isPng(p.png) ? 'png' : 'jpg'}`;
    await fs.writeFile(path.join(job.dir, file), p.png);
    calls.push({
      call: 'worker',
      worker: VISION_WORKER,
      key,
      input: { picture: file, fields: FIELDS, page: n },
    });
  }
  return { status: 'ok', calls, ...(warnings.length > 0 ? { warnings } : {}) };
};
