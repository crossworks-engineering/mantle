/**
 * The PDF router as a package (docs/pipelines.md, "The router"): it names
 * the kind of a PDF and writes no tabs. The rules are kit (../../../pdf-kind.ts,
 * read through ../../../pdf-drawing.ts); this file is only the step.
 *
 * Step 1, first the book rule (bookOf, the large-PDF plan section 3.1): a
 * file past the size pdfjs opens (PDF_MAX_BYTES) is a `book`, read by the
 * book reader in page windows; so is a file of more than BOOK_MIN_PAGES
 * pages (qpdf's count, `job.pdfPageCount`, no page decode) whose first
 * pages (BOOK_SAMPLE_PAGES, read as every page is) are office pages, mostly
 * scans or typed text. A book is named with no ask and hands no facts: the
 * book reader reads the file itself, window by window.
 *
 * Else read the page facts with no model, as the reader does, and name the
 * kind by the rules. Every office PDF is a book, whatever its size (Jason's
 * word, 2026-11-19): a file the rules name a `document`, and a file whose
 * pages, read whole, bookOf finds office pages (typed or scanned text but
 * for a few, so a short scan with one ruled table page too; a long file
 * whose sample failed, by all its pages). A `document` is never named any more: no PDF is left to
 * the core's own text read and OCR. A drawing keeps its kind and its
 * reader. A file the rules leave `unsure`, in a run that may ask
 * (`request.asks`), asks the worker `decider` once: its input is the
 * decider's state (counts and the text sample).
 *
 * The page facts go back as `facts` (at most PIPELINE_FACTS_MAX_BYTES as
 * JSON), read with the title block box of the read's options, so they are
 * the facts the reader would read: the core sends them to the reader's job
 * and the file is read one time. The box changes the rows only, never the
 * kind.
 *
 * Step 2: the decider's answer gives the kind, by the one rule
 * (decidedKind): it can make the file more of a drawing, never a document.
 * A `table`, or a `document` of a file on office paper, makes it a book
 * (every office PDF is one). No answer, a `document` on drawing sheets, or
 * one that may not be used: the kind stays `unsure`, and the file keeps its
 * database. The core hears the answer itself (it made the ask), and gives
 * it to the reader for its File tab.
 *
 * Part 2, the page types (../../../pdf-page-kinds.ts; plan page c607711a,
 * M3 in shadow): a request with `pageFrom` is one page window of the file
 * (the core cuts it, 25 pages), in a run that may ask. The step reads the
 * window's page facts with no model, draws each page that is not blank as
 * a grey JPEG of 1,024 px long side in the parser's pdfjs child, and gives
 * one `decider` call a page, keyed `page-<N>` with N the page of the
 * original file: the 8 fields of PdfPageAsk. Its `state` names every page
 * of the window with its rules kind and, for a page with no ask, why
 * (`blank`, `not drawn`). It writes nothing and names no kind: the core
 * asks, and keeps the answers in the Reader's tab Pages.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DECIDER_WORKER,
  PAGE_ASK_KEY_PREFIX,
  PIPELINE_FACTS_MAX_BYTES,
  PIPELINE_PICTURES_MAX_BYTES,
  type PipelineCall,
  type PipelineStep,
  type PipelineStepRequest,
  type PipelineStepResult,
  type StepJob,
} from '../../contract';
import { readPdfDrawingInJob, type PdfDrawing } from '../../../pdf-drawing';
import {
  decidedKind,
  isPdfKind,
  pdfKindAskFrom,
  pdfKindDecisionOf,
} from '../../../pdf-drawing-sheets';
import {
  BOOK_MIN_PAGES,
  BOOK_SAMPLE_PAGES,
  bookOf,
  bookUnsureOf,
  officePaperOf,
  type PdfKind,
} from '../../../pdf-kind';
import { PDF_MAX_BYTES } from '../../../pdf-open';
import { titleBlockOf } from '../../../pdf-rows';
import {
  PDF_PAGE_PICTURE,
  PDF_PAGE_SAMPLE_MAX_CHARS,
  pagePictureName,
  type PdfPageAsk,
} from '../../../pdf-page-kinds';

/** The facts as the reader takes them, or none: past the cap, or for a
 *  document, which no reader takes. */
function factsOf(drawing: PdfDrawing): { facts?: Record<string, unknown> } {
  if (drawing.kind === 'document') return {};
  const json = JSON.stringify(drawing);
  return Buffer.byteLength(json, 'utf8') <= PIPELINE_FACTS_MAX_BYTES
    ? { facts: drawing as unknown as Record<string, unknown> }
    : {};
}

/** Why a page of a window gets no ask: the state's word (the core makes
 *  its `Kind from` of it). */
export type PageNoAsk = 'blank' | 'not drawn';

/** One page of a window in the step's state: its page of the original
 *  file, its rules kind, and why it has no ask (null: it has one). */
export type WindowPage = [page: number, kind: string, noAsk: PageNoAsk | null];

/** Part 2: the page asks of one window (see the head of this file). */
async function pageAsks(req: PipelineStepRequest, job: StepJob): Promise<PipelineStepResult> {
  if (req.asks !== true) return { status: 'ok', calls: [], state: { pages: [] } };
  const from = req.pageFrom ?? 1;
  const drawing = await readPdfDrawingInJob(
    await job.bytes(),
    job,
    titleBlockOf(req.options),
    undefined,
    PDF_PAGE_SAMPLE_MAX_CHARS,
  );
  const pages: WindowPage[] = [];
  // A page the rules call blank is free (type blank), as on the bench; so
  // is a page the reader could not read (no class): it keeps its rules kind.
  const want = drawing.pages.filter((p) => {
    const n = from + p.page - 1;
    if (p.class === 'blank' && p.kind !== 'unsure') pages.push([n, p.kind, 'blank']);
    else if (!p.class) pages.push([n, p.kind, 'not drawn']);
    else return true;
    return false;
  });
  const drawn =
    want.length > 0
      ? await job.pdfPictures(
          want.map((p) => ({
            pageNumber: p.page,
            // The long side binds: 40 pixels a point is past any page.
            scale: 40,
            maxSide: PDF_PAGE_PICTURE.maxSide,
            grayJpeg: PDF_PAGE_PICTURE.quality,
          })),
          job.deadline,
        )
      : [];
  const calls: PipelineCall[] = [];
  let left = PIPELINE_PICTURES_MAX_BYTES;
  for (const [i, p] of want.entries()) {
    const n = from + p.page - 1;
    const pic = drawn[i];
    if (pic?.blank) {
      pages.push([n, p.kind, 'blank']);
      continue;
    }
    // No picture, one under the decider's smallest size, or past the
    // window's answer budget: no ask, the rules kind stays.
    if (
      !pic ||
      Math.min(pic.widthPx, pic.heightPx) < PDF_PAGE_PICTURE.minSide ||
      pic.widthPx * pic.heightPx < PDF_PAGE_PICTURE.minPixels ||
      pic.png.length > left
    ) {
      pages.push([n, p.kind, 'not drawn']);
      continue;
    }
    left -= pic.png.length;
    const picture = pagePictureName(n);
    await fs.writeFile(path.join(job.dir, picture), pic.png);
    const input: PdfPageAsk = {
      page: n,
      picture,
      size: p.size ?? null,
      class: p.class ?? null,
      instrument_tags: p.instruments,
      line_numbers: p.lineNumbers,
      tag_like_tokens: p.tagLike,
      text_sample: (p.sample ?? '').slice(0, PDF_PAGE_SAMPLE_MAX_CHARS),
    };
    calls.push({
      call: 'worker',
      worker: DECIDER_WORKER,
      key: `${PAGE_ASK_KEY_PREFIX}${n}`,
      input,
    });
    pages.push([n, p.kind, null]);
  }
  pages.sort((a, b) => a[0] - b[0]);
  return { status: 'ok', calls, state: { pages } };
}

export const step: PipelineStep = async (req, job) => {
  if (req.pageFrom !== undefined) return pageAsks(req, job);
  if (req.step === 1) {
    // Past the size pdfjs opens: no page rule can read it, the book reader
    // can (qpdf cuts it in windows).
    if ((req.file?.size ?? 0) > PDF_MAX_BYTES) return { status: 'ok', kind: 'book' };
    const box = titleBlockOf(req.options);
    const pages = await job.pdfPageCount();
    if (pages !== null && pages > BOOK_MIN_PAGES) {
      const sample = await readPdfDrawingInJob(await job.bytes(), job, box, BOOK_SAMPLE_PAGES);
      if (bookOf(pages, sample.pages)) return { status: 'ok', kind: 'book' };
    }
    const drawing = await readPdfDrawingInJob(await job.bytes(), job, box);
    // Every office PDF is a book, whatever its size (Jason's word,
    // 2026-11-19): a document by the page rules, and a file whose pages,
    // read whole, are office pages, typed or scanned, but for a few. A long
    // file too: its first pages can fail the sample (damaged pages, drawn
    // tables up front) while the whole file is a book.
    const count = pages ?? drawing.numPages;
    if (drawing.kind === 'document' || bookOf(count, drawing.pages)) {
      return { status: 'ok', kind: 'book' };
    }
    // A scan of typed pages and ruled pages (a table or a drawing form?),
    // short or long: the decider says, once, where the run may ask
    // (bookUnsureOf).
    const mixed = bookUnsureOf(count, drawing.pages);
    if ((drawing.kind !== 'unsure' && !mixed) || req.asks !== true) {
      return { status: 'ok', kind: drawing.kind, ...factsOf(drawing) };
    }
    return {
      status: 'ok',
      calls: [{ call: 'worker', worker: 'decider', input: pdfKindAskFrom(drawing) }],
      state: {
        ...(mixed ? { [MIXED]: drawing.kind } : {}),
        ...(officePaperOf(drawing.pages) ? { [OFFICE_PAPER]: true } : {}),
      },
      ...factsOf(drawing),
    };
  }
  const answer = req.answers?.[0];
  const decision = answer?.ok ? pdfKindDecisionOf(answer.output) : null;
  // A table of rows (an invoice, a list, a spec table) is an office PDF:
  // the book reader reads it, with its Tables tab. So is a short mixed scan
  // the decider calls a document or a table.
  const office =
    decision?.used === true && (decision.kind === 'table' || decision.kind === 'document');
  const base = mixedBaseOf(req.state);
  if (base !== null) return { status: 'ok', kind: office ? 'book' : base };
  // An unsure file the decider calls a table, or a document on office
  // paper (a typed manual whose first pages hold charts): every office PDF
  // is a book. A `document` on drawing
  // sheets stays unsure, the drawing reader's.
  if (office && (decision.kind === 'table' || officePaperIn(req.state))) {
    return { status: 'ok', kind: 'book' };
  }
  return { status: 'ok', kind: decidedKind('unsure', decision) ?? 'unsure' };
};

/** The state key of an unsure file whose pages are office paper
 *  (officePaperOf): the decider's `document` makes it a book. */
const OFFICE_PAPER = 'officePaper';

function officePaperIn(state: unknown): boolean {
  return (
    !!state &&
    typeof state === 'object' &&
    (state as Record<string, unknown>)[OFFICE_PAPER] === true
  );
}

/** The state key of a short mixed scan (bookUnsureOf): the kind the rules
 *  gave it, kept if the decider names no office kind. */
const MIXED = 'mixedScanKind';

function mixedBaseOf(state: unknown): PdfKind | null {
  if (!state || typeof state !== 'object') return null;
  const v = (state as Record<string, unknown>)[MIXED];
  return typeof v === 'string' && isPdfKind(v) ? v : null;
}
