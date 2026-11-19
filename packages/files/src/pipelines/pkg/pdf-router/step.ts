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
 * word, 2026-11-19): a file the rules name a `document`, and a file of
 * BOOK_MIN_PAGES pages or fewer whose pages bookOf finds office pages
 * (typed or scanned text but for a few, so a short scan with one ruled
 * table page too). A `document` is never named any more: no PDF is left to
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
 * No answer, a `document`, or one that may not be used: the kind stays
 * `unsure`, and the file keeps its database. The core hears the answer
 * itself (it made the ask), and gives it to the reader for its File tab.
 */
import type { PipelineStep } from '../../contract';
import { PIPELINE_FACTS_MAX_BYTES } from '../../contract';
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
  type PdfKind,
} from '../../../pdf-kind';
import { PDF_MAX_BYTES } from '../../../pdf-open';
import { titleBlockOf } from '../../../pdf-rows';

/** The facts as the reader takes them, or none: past the cap, or for a
 *  document, which no reader takes. */
function factsOf(drawing: PdfDrawing): { facts?: Record<string, unknown> } {
  if (drawing.kind === 'document') return {};
  const json = JSON.stringify(drawing);
  return Buffer.byteLength(json, 'utf8') <= PIPELINE_FACTS_MAX_BYTES
    ? { facts: drawing as unknown as Record<string, unknown> }
    : {};
}

export const step: PipelineStep = async (req, job) => {
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
    // 2026-11-19): a document by the page rules, and a short file whose
    // pages, read whole, are office pages, typed or scanned, but for a few.
    const count = pages ?? drawing.numPages;
    if (drawing.kind === 'document' || (count <= BOOK_MIN_PAGES && bookOf(count, drawing.pages))) {
      return { status: 'ok', kind: 'book' };
    }
    // A short scan of typed pages and ruled pages (a table or a drawing
    // form?): the decider says, once, where the run may ask (bookUnsureOf).
    const mixed = bookUnsureOf(count, drawing.pages);
    if ((drawing.kind !== 'unsure' && !mixed) || req.asks !== true) {
      return { status: 'ok', kind: drawing.kind, ...factsOf(drawing) };
    }
    return {
      status: 'ok',
      calls: [{ call: 'worker', worker: 'decider', input: pdfKindAskFrom(drawing) }],
      ...(mixed ? { state: { [MIXED]: drawing.kind } } : {}),
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
  if (office && decision.kind === 'table') return { status: 'ok', kind: 'book' };
  return { status: 'ok', kind: decidedKind('unsure', decision) ?? 'unsure' };
};

/** The state key of a short mixed scan (bookUnsureOf): the kind the rules
 *  gave it, kept if the decider names no office kind. */
const MIXED = 'mixedScanKind';

function mixedBaseOf(state: unknown): PdfKind | null {
  if (!state || typeof state !== 'object') return null;
  const v = (state as Record<string, unknown>)[MIXED];
  return typeof v === 'string' && isPdfKind(v) ? v : null;
}
