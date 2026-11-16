/**
 * The PDF router as a package (docs/pipelines.md, "The router"): it names
 * the kind of a PDF and writes no tabs. The rules are kit (../../../pdf-kind.ts,
 * read through ../../../pdf-drawing.ts); this file is only the step.
 *
 * Step 1: read the page facts with no model, as the reader does, and name
 * the kind by the rules. A file the rules leave `unsure`, in a run that may
 * ask (`request.asks`), asks the worker `decider` once: its input is the
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
import { decidedKind, pdfKindAskFrom, pdfKindDecisionOf } from '../../../pdf-drawing-sheets';
import { titleBlockOf } from '../../../pdf-rows';

/** The facts as the reader takes them, or none when they are past the cap. */
function factsOf(drawing: PdfDrawing): { facts?: Record<string, unknown> } {
  const json = JSON.stringify(drawing);
  return Buffer.byteLength(json, 'utf8') <= PIPELINE_FACTS_MAX_BYTES
    ? { facts: drawing as unknown as Record<string, unknown> }
    : {};
}

export const step: PipelineStep = async (req, job) => {
  if (req.step === 1) {
    const drawing = await readPdfDrawingInJob(await job.bytes(), job, titleBlockOf(req.options));
    if (drawing.kind !== 'unsure' || req.asks !== true) {
      return { status: 'ok', kind: drawing.kind, ...factsOf(drawing) };
    }
    return {
      status: 'ok',
      calls: [{ call: 'worker', worker: 'decider', input: pdfKindAskFrom(drawing) }],
      ...factsOf(drawing),
    };
  }
  const answer = req.answers?.[0];
  const decision = answer?.ok ? pdfKindDecisionOf(answer.output) : null;
  return { status: 'ok', kind: decidedKind('unsure', decision) ?? 'unsure' };
};
