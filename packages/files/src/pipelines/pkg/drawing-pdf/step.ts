/**
 * The PDF drawing reader as a package (docs/pipelines.md, "The PDF set"). The
 * page reader, the rows and the sheets are kit (../../../pdf-drawing.ts,
 * pdf-rows.ts, pdf-drawing-sheets.ts): the core reads a PDF's File tab with
 * them too. This file is only the step.
 *
 * The kind is the router's (`request.kind`), or on a read again the stored
 * one: the step does not name it again. The core's `state` of step 1 holds
 * the decider's answer as the core heard it (the File tab's decider
 * columns). The state is data from the core: it is used for those columns,
 * nothing else.
 *
 * One step: the page facts, the tabs, one write call. It asks no model. The
 * sketch read of a scan is not a step of this pipeline: it is a core path
 * (server/api/src/agent/extract/pdf-sketch.ts) that uses this reader's kit,
 * so that every parser job comes before its first paid call.
 */
import type { PipelineStep } from '../../contract';
import { FILE_TABS_WRITE } from '../../contract';
import { readPdfDrawingInJob } from '../../../pdf-drawing';
import { isPdfKind, pdfDrawingSheets, pdfKindDecisionOf } from '../../../pdf-drawing-sheets';
import type { PdfKind } from '../../../pdf-kind';
import { titleBlockOf } from '../../../pdf-rows';

export const step: PipelineStep = async (req, job) => {
  const titleBlock = titleBlockOf(req.options);
  const kind: PdfKind | undefined =
    typeof req.kind === 'string' && isPdfKind(req.kind) ? req.kind : undefined;
  const state = (req.state && typeof req.state === 'object' ? req.state : {}) as {
    decision?: unknown;
  };
  const drawing = await readPdfDrawingInJob(await job.bytes(), job, titleBlock);
  const { sheets, description } = pdfDrawingSheets(
    drawing,
    pdfKindDecisionOf(state.decision),
    null,
    kind,
  );
  return {
    status: 'ok',
    calls: [{ call: 'tool', tool: FILE_TABS_WRITE, input: { tabs: sheets, description } }],
  };
};
