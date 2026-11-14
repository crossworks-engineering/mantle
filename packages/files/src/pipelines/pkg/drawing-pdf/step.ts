/**
 * The PDF drawing reader as a package (docs/pipelines.md, "The PDF set"). The
 * page reader, the rows, the sheets and the sketch read are kit
 * (../../../pdf-drawing.ts, pdf-rows.ts, pdf-drawing-sheets.ts, pdf-sketch.ts):
 * the core reads a PDF's File tab with them too. This file is only the step.
 *
 * The kind is the router's (`request.kind`), or on a read again the stored
 * one: the step does not name it again. The core's `state` of step 1 holds
 * the decider's answer as the core heard it (the File tab's decider
 * columns), and for the sketch read the stored rules kind and the stored
 * count of pages not read whole. The state is data from the core: it is
 * used for those columns and that compare, nothing else.
 *
 * The plain run (`request.asks` false: an upload, a run on demand, a read
 * again, a test): one step, the page facts, the tabs, one write call.
 *
 * The sketch read (`request.asks` true, started by the core at the extract's
 * spot when it is due): step 1 reads the page facts, and a read poorer than
 * the first (another rules kind, or more pages not read whole) asks nothing
 * and writes nothing. Else it cuts the scan pages into pieces and returns one
 * `vision` call a packed picture (40 at most), with the layout of the pieces
 * in its state. Step 2 reads the page facts again, as the old path did, joins
 * the answers, and returns the whole write with the text of the scan. When no
 * picture was read by the model, it writes nothing.
 */
import type { PipelineCallAnswer, PipelineStep, PipelineStepResult } from '../../contract';
import { FILE_TABS_WRITE } from '../../contract';
import { readPdfDrawingInJob, type PdfDrawing } from '../../../pdf-drawing';
import {
  isPdfKind,
  pagesNotReadWhole,
  pdfDrawingSheets,
  pdfKindDecisionOf,
  type PdfKindDecision,
} from '../../../pdf-drawing-sheets';
import type { PdfKind } from '../../../pdf-kind';
import { titleBlockOf } from '../../../pdf-rows';
import {
  cutSketchPages,
  sketchLayoutOf,
  sketchMarkdown,
  sketchPageRead,
  sketchPagesOf,
  sketchPiecesFrom,
  type SketchRead,
} from '../../../pdf-sketch';

/** The core's state of step 1, read field by field. */
type CoreState = {
  decision: PdfKindDecision | null;
  rulesKind: string | null;
  notReadWhole: number | null;
};

function coreStateOf(v: unknown): CoreState {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    decision: pdfKindDecisionOf(o.decision),
    rulesKind: typeof o.rulesKind === 'string' ? o.rulesKind : null,
    notReadWhole:
      typeof o.notReadWhole === 'number' && Number.isFinite(o.notReadWhole) ? o.notReadWhole : null,
  };
}

/** The first read stands: a read poorer than it (a page over its time on a
 *  busy parser) must not replace it, so nothing is asked and nothing is
 *  written. With no stored facts there is nothing to keep. */
const poorer = (drawing: PdfDrawing, core: CoreState) =>
  core.rulesKind === null ||
  core.notReadWhole === null ||
  drawing.kind !== core.rulesKind ||
  pagesNotReadWhole(drawing) > core.notReadWhole;

/** Nothing to write: the core leaves the database as it is. */
const NOTHING: PipelineStepResult = { status: 'ok' };

/** The sketch read's own `vision` call for one packed picture. */
const visionCall = (page: number, picture: number, png: Buffer, pieces: number) => ({
  call: 'worker' as const,
  worker: 'vision',
  input: { page, picture, pieces, png: png.toString('base64') },
});

export const step: PipelineStep = async (req, job) => {
  const titleBlock = titleBlockOf(req.options);
  const kind: PdfKind | undefined =
    typeof req.kind === 'string' && isPdfKind(req.kind) ? req.kind : undefined;
  const bytes = await job.bytes();

  if (req.step === 1 && req.asks !== true) {
    // The plain run.
    const core = coreStateOf(req.state);
    const drawing = await readPdfDrawingInJob(bytes, job, titleBlock);
    const { sheets, description } = pdfDrawingSheets(drawing, core.decision, null, kind);
    return {
      status: 'ok',
      calls: [{ call: 'tool', tool: FILE_TABS_WRITE, input: { tabs: sheets, description } }],
    };
  }

  if (req.step === 1) {
    // The sketch read, step 1: the facts, the compare, the pieces.
    const core = coreStateOf(req.state);
    const drawing = await readPdfDrawingInJob(bytes, job, titleBlock);
    if (kind === undefined || poorer(drawing, core)) return NOTHING;
    const { pages, pastCap } = sketchPagesOf(drawing, kind);
    const cut = pages.length > 0 ? await cutSketchPages(job, pages) : [];
    if (!cut.some((p) => p.pictures.length > 0)) return NOTHING;
    const calls = cut.flatMap((p) =>
      p.pictures.map((png, k) =>
        visionCall(p.page, k + 1, png, p.pieces.filter((x) => x.picture === k).length),
      ),
    );
    return {
      status: 'ok',
      calls,
      state: { ...core, pastCap, pages: cut.map(sketchLayoutOf) },
    };
  }

  // The sketch read, step 2: the facts again, the answers joined.
  const state = (req.state ?? {}) as Record<string, unknown>;
  const core = coreStateOf(state);
  const layout = Array.isArray(state.pages) ? state.pages.map(sketchPiecesFrom) : [];
  const pastCap = Array.isArray(state.pastCap)
    ? state.pastCap.filter((n): n is number => Number.isInteger(n))
    : [];
  if (kind === undefined || layout.some((p) => p === null)) {
    return { status: 'failed', warnings: ['the sketch read lost the layout of its pieces'] };
  }
  const answers: readonly PipelineCallAnswer[] = req.answers ?? [];
  let next = 0;
  let model: string | null = null;
  const read: SketchRead['pages'] = [];
  for (const page of layout as NonNullable<(typeof layout)[number]>[]) {
    const texts: (string | null)[] = [];
    for (let k = 0; k < page.pictures.length; k += 1) {
      const a = answers[next++];
      if (!a?.ok) {
        texts.push(null);
        continue;
      }
      const out = (a.output ?? {}) as { text?: unknown; model?: unknown };
      model = typeof out.model === 'string' && out.model ? out.model : 'unknown';
      texts.push(typeof out.text === 'string' ? out.text : '');
    }
    read.push(sketchPageRead(page, texts));
  }
  // No picture was read by the model: nothing to store.
  if (model === null) return NOTHING;
  const drawing = await readPdfDrawingInJob(bytes, job, titleBlock);
  if (poorer(drawing, core)) return NOTHING;
  const sketch: SketchRead = { model, pages: read, pagesPastCap: pastCap, titleBlock };
  const { sheets, description } = pdfDrawingSheets(drawing, core.decision, sketch, kind);
  return {
    status: 'ok',
    calls: [
      {
        call: 'tool',
        tool: FILE_TABS_WRITE,
        input: { tabs: sheets, description, text: sketchMarkdown(drawing, sketch) },
      },
    ],
  };
};
