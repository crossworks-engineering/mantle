/**
 * The core's part of a PDF read (docs/pipelines.md, "The PDF set"): the
 * router and the reader are packages (`pdf-router`, `drawing-pdf`), run by
 * the parser one step a job (./pipeline-runner.ts). What stays here is what
 * only the core holds:
 *
 * - The decider's ask. The router's step returns one `decider` call for a
 *   file its rules leave unsure; the core checks what the step would send
 *   (pdfKindAskOf), asks, and keeps the answer, so the reader's File tab can
 *   hold it, also a shadow answer that is not used.
 * - The stored File tab of a PDF's database (storedPdfOf): the kind and the
 *   decision a read again keeps, and the facts the sketch read compares with.
 *   They reach the reader's first step as its `state` (runPackaged's
 *   `opts.state`), never in `request.kind` alone.
 * - The sketch read's run (readPdfSketch): the reader with `asks` on, the
 *   stored kind, and the vision ask of the caller.
 *
 * Nothing is written here: the caller writes at the one write spot.
 */
import {
  pdfFileTabOf,
  pdfKindAskOf,
  type PdfKindAsk,
  type PdfKindDecision,
  type PipelineManifest,
} from '@mantle/files';
import { runTableSql } from '@mantle/tabledb';
import {
  runPackaged,
  stepFileOf,
  PipelineRunError,
  type PipelineAsk,
  type PipelineRunResult,
} from './pipeline-runner';

/** What a PDF's stored File tab says (pdfFileTabOf). */
export type StoredPdf = NonNullable<ReturnType<typeof pdfFileTabOf>>;

/** How the caller asks the decider about an unsure PDF. Null: no answer,
 *  and the file stays unsure. */
export type PdfDecide = (ask: PdfKindAsk) => Promise<PdfKindDecision | null>;

/** The `File` tab of a PDF's database at `abs`, or null: no database, not a
 *  PDF drawing database, or it went just now. */
export async function storedPdfOf(abs: string): Promise<StoredPdf | null> {
  try {
    const r = await runTableSql(abs, 'SELECT * FROM "File"', { cap: 1 });
    return r.rows[0] ? pdfFileTabOf(r.columns, r.rows[0]) : null;
  } catch {
    return null;
  }
}

/** The state the reader's first step gets from the core: the decision, and
 *  the facts of the first read a sketch read compares with. */
export function readerStateOf(stored: {
  decision: PdfKindDecision | null;
  rulesKind?: string;
  notReadWhole?: number;
}): Record<string, unknown> {
  return {
    decision: stored.decision,
    ...(stored.rulesKind !== undefined ? { rulesKind: stored.rulesKind } : {}),
    ...(stored.notReadWhole !== undefined ? { notReadWhole: stored.notReadWhole } : {}),
  };
}

/**
 * The router's run: the kind of the file, and the decider's answer when the
 * router asked (only with `decide`, for a file its rules leave unsure). A
 * run that names no kind is a failure (PipelineRunError, the word
 * `unreadable`). A typed parser failure throws as for every job.
 */
export async function routePdf(
  router: PipelineManifest,
  bytes: Buffer,
  decide: PdfDecide | undefined,
): Promise<{ kind: string; decision: PdfKindDecision | null }> {
  let decision: PdfKindDecision | null = null;
  const ask: PipelineAsk | undefined = decide
    ? async (call) => {
        const state = call.worker === 'decider' ? pdfKindAskOf(call.input) : null;
        if (!state) return { ok: false, error: 'refused' };
        decision = await decide(state);
        return decision ? { ok: true, output: decision } : { ok: false, error: 'not_available' };
      }
    : undefined;
  const run = await runPackaged(router, bytes, stepFileOf(bytes, 'pdf'), {
    options: {},
    ...(ask ? { ask } : {}),
  });
  if (run.status !== 'ok' || typeof run.kind !== 'string') {
    throw new PipelineRunError(`${router.id} named no kind (${run.status})`);
  }
  return { kind: run.kind, decision };
}

/**
 * The sketch read's run of the reader: `asks` on with the caller's vision
 * ask, the stored kind, and the stored facts in the first step's state. Its
 * result has a write only when the read is to be kept: a read poorer than
 * the first, or one the model read nothing of, has none, and the caller
 * then writes nothing.
 */
export async function readPdfSketch(
  reader: PipelineManifest,
  bytes: Buffer,
  stored: StoredPdf,
  options: Readonly<Record<string, unknown>>,
  ask: PipelineAsk,
): Promise<PipelineRunResult> {
  return runPackaged(reader, bytes, stepFileOf(bytes, 'pdf'), {
    options,
    ask,
    kind: stored.kind,
    state: readerStateOf(stored),
  });
}
