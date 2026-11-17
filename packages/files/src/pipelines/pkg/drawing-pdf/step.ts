/**
 * The PDF drawing reader as a package (docs/pipelines.md, "The PDF set"). The
 * page reader, the rows and the sheets are kit (../../../pdf-drawing.ts,
 * pdf-rows.ts, pdf-drawing-sheets.ts): the core reads a PDF's File tab with
 * them too. This file is only the step.
 *
 * The kind is the router's (`request.kind`), or on a read again the stored
 * one: the step does not name it again. The core's `state` of step 1 holds
 * the decider's answer as the core heard it (the File tab's decider
 * columns), `facts: true` when the body is the router's page facts
 * (docs/pipelines.md, "The router"): the file is then read one time, and
 * `nodeVision: true` when the file's node holds the text of an older
 * whole-page vision read (the File tab's `Vision text`). The state is data
 * from the core: it is used for those three, nothing else.
 *
 * One step: the page facts, the tabs, one write call. It asks no model. The
 * sketch read of a scan is not a step of this pipeline: it is a core path
 * (server/api/src/agent/extract/pdf-sketch.ts) that uses this reader's kit,
 * so that every parser job comes before its first paid call.
 */
import type { PipelineStep } from '../../contract';
import { FILE_TABS_WRITE } from '../../contract';
import { readPdfDrawingInJob, type PdfDrawing } from '../../../pdf-drawing';
import { isPdfKind, pdfDrawingSheets, pdfKindDecisionOf } from '../../../pdf-drawing-sheets';
import type { PdfKind } from '../../../pdf-kind';
import { titleBlockOf } from '../../../pdf-rows';

export const step: PipelineStep = async (req, job) => {
  const titleBlock = titleBlockOf(req.options);
  const kind: PdfKind | undefined =
    typeof req.kind === 'string' && isPdfKind(req.kind) ? req.kind : undefined;
  const state = (req.state && typeof req.state === 'object' ? req.state : {}) as {
    decision?: unknown;
    facts?: unknown;
    nodeVision?: unknown;
  };
  // The router's page facts, when the core sent them as the body: the
  // file is not read again. Else the body is the file.
  const body = await job.bytes();
  const drawing =
    state.facts === true
      ? (JSON.parse(body.toString('utf8')) as PdfDrawing)
      : await readPdfDrawingInJob(body, job, titleBlock);
  const { sheets, description } = pdfDrawingSheets(
    drawing,
    pdfKindDecisionOf(state.decision),
    null,
    kind,
    state.nodeVision === true,
  );
  return {
    status: 'ok',
    calls: [{ call: 'tool', tool: FILE_TABS_WRITE, input: { tabs: sheets, description } }],
  };
};
