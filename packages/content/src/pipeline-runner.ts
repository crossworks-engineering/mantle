/**
 * The runner of a packaged pipeline, on the brain's side (docs/pipelines.md,
 * "The runner"). A packaged built-in (`runtime: 'bun'`) runs in the parser,
 * one step a job (`parserPipelineRun`). This loop runs the steps to the end
 * and does the worker calls between them. It writes nothing: it gives the
 * write call's input back, and the caller writes it at the one write spot
 * (writeRowsOrWord in ./file-database.ts). So a Test and a compare run the
 * same loop and write nothing.
 *
 * Asks: the caller gives an `ask` function, or none. With none, the run is
 * model-free (`request.asks` is false), and a worker call a step still
 * returns gets the answer `refused`. With one, the asks of one worker are
 * capped by the manifest's `needs.workers`; one past the cap is `refused`.
 *
 * Steps: at most PIPELINE_STEPS_MAX (2 for a router, 4 for a pipeline). A
 * result with worker calls on the last allowed step is a failure.
 */
import {
  AFTER_CELL_MAX_CHARS,
  FILE_TABS_WRITE,
  PIPELINE_API,
  PIPELINE_STEPS_MAX,
  SHAPES,
  parserPipelineRun,
  tabHeadLine,
  tabRowLine,
  type FileTabsWriteInput,
  type PipelineCall,
  type PipelineCallAnswer,
  type PipelineManifest,
  type PipelineStepRequest,
  type PipelineStepResult,
  type ShapeId,
} from '@mantle/files';
import { scanTabColumns } from '@mantle/tabledb';

/** How the core answers one worker call of a step. */
export type PipelineAsk = (call: PipelineCall & { call: 'worker' }) => Promise<PipelineCallAnswer>;

export type PipelineRunResult = {
  status: PipelineStepResult['status'];
  kind?: string;
  /** The input of the write call, when the last step made one. */
  write?: FileTabsWriteInput;
  /** The bytes of the pictures the write names, by file name. */
  pictures: ReadonlyMap<string, Buffer>;
  warnings: string[];
  counts: Readonly<Record<string, number>>;
};

/** The error of a run that broke the contract (too many steps): a reader's
 *  `failed`, never retried. */
export class PipelineRunError extends Error {
  override readonly name = 'PipelineRunError';
}

/** Run a packaged pipeline to its end. Nothing is written here. */
export async function runPackaged(
  pipeline: PipelineManifest,
  body: Buffer,
  file: PipelineStepRequest['file'],
  opts: { options: Readonly<Record<string, unknown>>; ask?: PipelineAsk; kind?: string },
): Promise<PipelineRunResult> {
  const max = pipeline.router ? PIPELINE_STEPS_MAX.router : PIPELINE_STEPS_MAX.pipeline;
  const asked = new Map<string, number>();
  const ask = async (call: PipelineCall & { call: 'worker' }): Promise<PipelineCallAnswer> => {
    const n = asked.get(call.worker) ?? 0;
    if (!opts.ask || n >= (pipeline.needs.workers?.[call.worker] ?? 0)) {
      return { ok: false, error: 'refused' };
    }
    asked.set(call.worker, n + 1);
    return opts.ask(call);
  };
  let answers: PipelineCallAnswer[] | undefined;
  let state: unknown;
  for (let step = 1; ; step += 1) {
    const request: PipelineStepRequest = {
      api: PIPELINE_API,
      step,
      ...(file ? { file } : {}),
      options: opts.options,
      asks: opts.ask !== undefined,
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
      ...(answers ? { answers } : {}),
      ...(state !== undefined ? { state } : {}),
    };
    const { result, pictures } = await parserPipelineRun(body, pipeline.id, request);
    const calls = result.calls ?? [];
    const workers = calls.filter(
      (c): c is PipelineCall & { call: 'worker' } => c.call === 'worker',
    );
    if (workers.length === 0) {
      const write = calls.find(
        (c): c is PipelineCall & { call: 'tool' } =>
          c.call === 'tool' && c.tool === FILE_TABS_WRITE,
      );
      return {
        status: result.status,
        ...(result.kind !== undefined ? { kind: result.kind } : {}),
        ...(write ? { write: write.input as FileTabsWriteInput } : {}),
        pictures,
        warnings: [...(result.warnings ?? [])],
        counts: result.counts ?? {},
      };
    }
    if (step >= max) {
      throw new PipelineRunError(`${pipeline.id} asked a worker on its last allowed step (${max})`);
    }
    answers = [];
    for (const call of workers) answers.push(await ask(call));
    state = result.state;
  }
}

/** The most rows of a tab an `after` pipeline reads. */
export const AFTER_TEXT_ROWS_MAX = 500_000;

/**
 * The body of an `after` pipeline's job (@mantle/files tabs-body.ts): the
 * needed tabs of the shape it names in `match.after`, with their columns,
 * read from the database at `abs`, read only. A tab past the row cap is cut,
 * with the warning the adapter gives today.
 */
export function afterBodyOf(
  abs: string,
  pipeline: PipelineManifest,
): { body: Buffer; warnings: string[] } {
  const shape = SHAPES[pipeline.match.after as ShapeId];
  if (!shape) throw new Error(`${pipeline.id} names no shape it reads`);
  const parts: string[] = [];
  const warnings: string[] = [];
  for (const tab of shape.tabs.filter((t) => t.needed)) {
    parts.push(tabHeadLine(tab.name, tab.columns));
    let rows = 0;
    scanTabColumns(
      abs,
      tab.name,
      tab.columns,
      { maxRows: AFTER_TEXT_ROWS_MAX, cellMaxChars: AFTER_CELL_MAX_CHARS },
      (row) => {
        rows += 1;
        parts.push(tabRowLine(tab.columns.map((c) => row[c] ?? null)));
        return true;
      },
    );
    if (rows >= AFTER_TEXT_ROWS_MAX) {
      warnings.push(
        `Only the first ${AFTER_TEXT_ROWS_MAX.toLocaleString('en')} ${tab.name.toLowerCase()} were read.`,
      );
    }
  }
  return { body: Buffer.from(parts.join(''), 'utf8'), warnings };
}
