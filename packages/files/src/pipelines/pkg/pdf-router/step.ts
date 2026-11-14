/**
 * The PDF router as a package (docs/pipelines.md, "The router"): it names
 * the kind of a PDF and writes no tabs. The rules are kit (../../../pdf-kind.ts,
 * read through ../../../pdf-drawing.ts); this file is only the step.
 *
 * Step 1: read the page facts with no model, as the reader does, and name
 * the kind by the rules. A file the rules leave `unsure`, in a run that may
 * ask (`request.asks`), asks the worker `decider` once: its input is the
 * decider's state (counts and the text sample), and the step keeps the one
 * fact it needs for the answer (`allRead`) in its state.
 *
 * Step 2: the decider's answer gives the kind, by the one rule
 * (decidedKind). No answer, or one that may not be used: the kind stays
 * `unsure`. The core hears the answer itself (it made the ask), and gives
 * it to the reader for its File tab.
 */
import type { PipelineStep } from '../../contract';
import { readPdfDrawingInJob } from '../../../pdf-drawing';
import { decidedKind, pdfKindAskFrom, pdfKindDecisionOf } from '../../../pdf-drawing-sheets';

export const step: PipelineStep = async (req, job) => {
  if (req.step === 1) {
    const drawing = await readPdfDrawingInJob(await job.bytes(), job);
    if (drawing.kind !== 'unsure' || req.asks !== true) {
      return { status: 'ok', kind: drawing.kind };
    }
    return {
      status: 'ok',
      calls: [{ call: 'worker', worker: 'decider', input: pdfKindAskFrom(drawing) }],
      state: { allRead: drawing.allRead },
    };
  }
  const answer = req.answers?.[0];
  const decision = answer?.ok ? pdfKindDecisionOf(answer.output) : null;
  const allRead = (req.state as { allRead?: unknown } | undefined)?.allRead === true;
  return { status: 'ok', kind: decidedKind('unsure', allRead, decision) ?? 'unsure' };
};
