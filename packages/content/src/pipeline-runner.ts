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
 * State: a step's `state` goes to the next step. The core may give the
 * first step one (`opts.state`): the one way the core hands a step facts
 * it holds (a PDF's stored decision, docs/pipelines.md).
 *
 * Steps: at most PIPELINE_STEPS_MAX (2 for a router, 4 for a pipeline). A
 * result with worker calls on the last allowed step is a failure.
 */
import { createHash } from 'node:crypto';
import {
  AFTER_CELL_MAX_CHARS,
  FILE_TABS_WRITE,
  PIPELINE_API,
  PIPELINE_STEPS_MAX,
  SHAPES,
  isParserError,
  memoReaderRun,
  optionsHash,
  parserPdfSplit,
  parserPipelineRun,
  parserRouteForExt,
  readerRunKey,
  tabHeadLine,
  tabRowLine,
  type FileTabsWriteInput,
  type PipelineCall,
  type PipelineCallAnswer,
  type CadExt,
  type PipelineManifest,
  type PipelineSource,
  type PipelineStepRequest,
  type PipelineStepResult,
  type ShapeId,
} from '@mantle/files';
import { scanTabColumns } from '@mantle/tabledb';
import { askCapOf } from './pipeline-agent';

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
  /** A router's facts, from the step that read them (`facts`). */
  facts?: Record<string, unknown>;
  /** The `state` the last step returned: a window's, for the next window. */
  state?: unknown;
  /** A windowed run (`needs.window`): the pages of the file and the windows
   *  that could not be read, each by its pages (both in). */
  windows?: { pagesTotal: number; failed: { from: number; to: number }[] };
};

/** The pages of a request of one window (PipelineStepRequest). */
type WindowPages = Pick<PipelineStepRequest, 'pageFrom' | 'pageTo' | 'pagesTotal'>;

/** The error of a run that broke the contract (too many steps): a reader's
 *  `failed`, never retried. */
export class PipelineRunError extends Error {
  override readonly name = 'PipelineRunError';
}

/** The file a reader's or a router's step is told of: its name for the
 *  step (the extension is what it reads by), size and hash. */
export function stepFileOf(bytes: Buffer, ext: string): NonNullable<PipelineStepRequest['file']> {
  return {
    name: `file.${ext}`,
    ext,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Run a packaged pipeline to its end. Nothing is written here. */
export async function runPackaged(
  pipeline: PipelineManifest,
  body: Buffer,
  file: PipelineStepRequest['file'],
  opts: {
    options: Readonly<Record<string, unknown>>;
    ask?: PipelineAsk;
    kind?: string;
    /** The state of step 1, from the core: today the PDF reader's facts
     *  of a decision (pdf-read.ts). A step uses it for those and nothing
     *  else; its result is checked as every one. */
    state?: unknown;
    /** One window of a windowed run (runWindowed): its pages, in every
     *  request of the run. */
    window?: WindowPages;
  },
): Promise<PipelineRunResult> {
  const max = pipeline.router ? PIPELINE_STEPS_MAX.router : PIPELINE_STEPS_MAX.pipeline;
  const asked = new Map<string, number>();
  const ask = async (call: PipelineCall & { call: 'worker' }): Promise<PipelineCallAnswer> => {
    const n = asked.get(call.worker) ?? 0;
    if (!opts.ask || n >= askCapOf(pipeline, call.worker)) {
      return { ok: false, error: 'refused' };
    }
    asked.set(call.worker, n + 1);
    return opts.ask(call);
  };
  let answers: PipelineCallAnswer[] | undefined;
  let state: unknown = opts.state;
  let facts: Record<string, unknown> | undefined;
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
      ...opts.window,
    };
    const { result, pictures } = await parserPipelineRun(body, pipeline, request);
    if (result.facts !== undefined) facts = result.facts;
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
        ...(facts ? { facts } : {}),
        ...(result.state !== undefined ? { state: result.state } : {}),
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

/**
 * The one step of an Agent (docs/pipelines.md, "Agents"): one parser job on
 * the file's bytes, which gives the asks and the bytes of the pictures they
 * name. Nothing is asked and nothing is written here. An Agent has no
 * second step: no code of the pipeline runs after a paid call. So a result
 * with a tool call (a write) is a failure, as is any status but `ok` and
 * `not_mine`.
 *
 * `from`: what the core holds of the file. `kind` is the kind stored in
 * the file's database (a PDF's File tab), so an Agent of some kinds says
 * `not_mine` to the rest; `state` is the step's first state, the options in
 * force of the file's Reader (`readerOptions`), so an Agent cuts the same
 * title block box the Reader reads.
 */
export async function agentStep(
  pipeline: PipelineManifest,
  body: Buffer,
  file: NonNullable<PipelineStepRequest['file']>,
  options: Readonly<Record<string, unknown>>,
  from: { kind?: string; state?: unknown } = {},
): Promise<{
  status: 'ok' | 'not_mine';
  asks: (PipelineCall & { call: 'worker' })[];
  pictures: ReadonlyMap<string, Buffer>;
  warnings: string[];
}> {
  const request: PipelineStepRequest = {
    api: PIPELINE_API,
    step: 1,
    file,
    options,
    asks: true,
    ...(from.kind !== undefined ? { kind: from.kind } : {}),
    ...(from.state !== undefined ? { state: from.state } : {}),
  };
  const { result, pictures } = await parserPipelineRun(body, pipeline, request);
  if (result.status !== 'ok' && result.status !== 'not_mine') {
    throw new PipelineRunError(`${pipeline.id} ended with the status ${result.status}`);
  }
  const calls = result.calls ?? [];
  if (calls.some((c) => c.call !== 'worker')) {
    throw new PipelineRunError(`${pipeline.id} is an Agent: its step asks, and writes nothing`);
  }
  return {
    status: result.status,
    asks: calls as (PipelineCall & { call: 'worker' })[],
    pictures,
    warnings: [...(result.warnings ?? [])],
  };
}

/** Whether a pipeline reads a file of this extension in page windows. */
export function readsInWindows(
  pipeline: Pick<PipelineManifest, 'needs'>,
  ext: string,
): pipeline is Pick<PipelineManifest, 'needs'> & {
  needs: { window: { pages: number; mb: number } };
} {
  return pipeline.needs.window !== undefined && ext === 'pdf';
}

/** One window of a PDF, as the parser cut it, with its pages. */
export type PdfWindowPart = {
  bytes: Buffer;
  pageFrom: number;
  pageTo: number;
  pagesTotal: number;
};

/** One step of {@link pdfWindows}: a window, or the pages of one the parser
 *  could not cut. */
export type PdfWindowStep =
  | { part: PdfWindowPart }
  | { part: null; from: number; to: number; pagesTotal: number };

/**
 * The page windows of a PDF, one at a time and in page order
 * (docs/pipelines.md, "Page windows"): each one parser job (`pdfSplit`,
 * qpdf), so the brain holds the file and one window, never every part. A
 * window the parser cannot cut comes as `part: null` with the pages it was
 * to hold (`pages` of them from its first), so the caller counts them as
 * not read and goes on; the first window must be cut, or there is no page
 * count and the run throws. A busy or unavailable parser throws, as for
 * every job. `startPage`: the first page (a picture pass that read the
 * first pages whole starts after them).
 */
export async function* pdfWindows(
  bytes: Buffer,
  sha256: string,
  window: { pages: number; mb: number },
  startPage = 1,
): AsyncGenerator<PdfWindowStep> {
  let from = startPage;
  let total: number | null = null;
  for (;;) {
    let part: PdfWindowPart;
    try {
      part = await parserPdfSplit(bytes, { from, pages: window.pages, mb: window.mb, sha256 });
    } catch (err) {
      if (total === null || !isParserError(err) || err.retryable) throw err;
      const to = Math.min(total, from + window.pages - 1);
      yield { part: null, from, to, pagesTotal: total };
      if (to >= total) return;
      from = to + 1;
      continue;
    }
    total = part.pagesTotal;
    yield { part };
    if (part.pageTo >= part.pagesTotal) return;
    from = part.pageTo + 1;
  }
}

/** Merge one window's write into the run's (the rule of FileTabsWriteInput):
 *  rows of a tab already there go after its rows by column name, a new tab
 *  is added, texts join with a blank line, pictures add up, and the last
 *  description stands. A column the first tab does not have is a warning. */
export function mergeWindowWrite(
  into: FileTabsWriteInput | undefined,
  next: FileTabsWriteInput,
  warnings: string[],
): FileTabsWriteInput {
  if (!into) return { ...next, tabs: next.tabs.map((t) => ({ ...t, rows: [...t.rows] })) };
  const tabs = into.tabs;
  for (const tab of next.tabs) {
    const have = tabs.find((t) => t.name === tab.name);
    if (!have) {
      tabs.push({ ...tab, rows: [...tab.rows] });
      continue;
    }
    const at = have.columns.map((c) => tab.columns.findIndex((n) => n.name === c.name));
    const lost = tab.columns.filter((c) => !have.columns.some((h) => h.name === c.name));
    if (lost.length > 0) {
      warnings.push(
        `The tab ${tab.name} of a later window has columns the first does not (${lost
          .map((c) => c.name)
          .join(', ')
          .slice(0, 200)}); they were left out.`,
      );
    }
    for (const row of tab.rows) have.rows.push(at.map((i) => (i < 0 ? null : (row[i] ?? null))));
  }
  const text = [into.text, next.text].filter((t): t is string => !!t).join('\n\n');
  const pictures = [...(into.pictures ?? []), ...(next.pictures ?? [])];
  const description = next.description ?? into.description;
  const fts = [...new Set([...(into.ftsSkipColumns ?? []), ...(next.ftsSkipColumns ?? [])])];
  const source = next.sourceSha256 ?? into.sourceSha256;
  return {
    tabs,
    ...(description ? { description } : {}),
    ...(fts.length > 0 ? { ftsSkipColumns: fts } : {}),
    ...(source ? { sourceSha256: source } : {}),
    ...(text ? { text } : {}),
    ...(pictures.length > 0 ? { pictures } : {}),
  };
}

/**
 * A Reader's run in page windows (docs/pipelines.md, "Page windows"): the
 * pipeline says `needs.window` and the file is a PDF. Every window, whatever
 * the file's size: there is no second path for a small book (Jason's word,
 * 2026-11-18). Each window is one run of the step (runPackaged) on the
 * window's PDF, with its pages in the request; the state of window 1 is the
 * core's (`opts.state`), of each later window the one the window before
 * returned. The writes merge into one (mergeWindowWrite), each window's
 * pictures renamed `w<first page>-<name>` so two windows never share a name.
 *
 * Nothing is lost silently: a window the parser cannot cut or the step
 * cannot read (a typed failure that is not `busy` or `unavailable`, a
 * broken contract) is kept in `windows.failed` with a warning, and the run
 * goes on with the next window from the last good state; so is a window
 * past the first that ends with any status but `ok`. `not_mine` on window
 * 1 is the run's answer. A busy parser throws: the extract tries again.
 */
export async function runWindowed(
  pipeline: PipelineManifest & { needs: { window: { pages: number; mb: number } } },
  bytes: Buffer,
  file: NonNullable<PipelineStepRequest['file']>,
  opts: { options: Readonly<Record<string, unknown>>; kind?: string; state?: unknown },
): Promise<PipelineRunResult> {
  let write: FileTabsWriteInput | undefined;
  const pictures = new Map<string, Buffer>();
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const failed: { from: number; to: number }[] = [];
  let state = opts.state;
  let pagesTotal = 0;
  let first = true;
  const lose = (from: number, to: number, why: string) => {
    failed.push({ from, to });
    warnings.push(`Pages ${from} to ${to} ${why}.`);
    first = false;
  };
  for await (const w of pdfWindows(bytes, file.sha256, pipeline.needs.window)) {
    if (!w.part) {
      pagesTotal = w.pagesTotal;
      lose(w.from, w.to, 'could not be cut from the file');
      continue;
    }
    const { part } = w;
    pagesTotal = part.pagesTotal;
    let run: PipelineRunResult;
    try {
      run = await runPackaged(pipeline, part.bytes, file, {
        options: opts.options,
        ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
        ...(state !== undefined ? { state } : {}),
        window: { pageFrom: part.pageFrom, pageTo: part.pageTo, pagesTotal: part.pagesTotal },
      });
    } catch (err) {
      if (isParserError(err) && err.retryable) throw err;
      if (!isParserError(err) && !(err instanceof PipelineRunError)) throw err;
      lose(part.pageFrom, part.pageTo, 'could not be read');
      continue;
    }
    if (run.status === 'not_mine' && first) return { ...run, windows: { pagesTotal, failed } };
    if (run.status !== 'ok') {
      lose(part.pageFrom, part.pageTo, `ended ${run.status}`);
      continue;
    }
    first = false;
    warnings.push(...run.warnings);
    for (const [k, v] of Object.entries(run.counts)) counts[k] = (counts[k] ?? 0) + v;
    if (run.state !== undefined) state = run.state;
    if (!run.write) continue;
    // Each window's pictures under names of their own.
    const prefix = `w${part.pageFrom}-`;
    for (const [name, b] of run.pictures) pictures.set(prefix + name, b);
    const renamed: FileTabsWriteInput = {
      ...run.write,
      ...(run.write.pictures
        ? { pictures: run.write.pictures.map((p) => ({ ...p, file: prefix + p.file })) }
        : {}),
    };
    write = mergeWindowWrite(write, renamed, warnings);
  }
  return {
    status: 'ok',
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(write ? { write } : {}),
    pictures,
    warnings,
    counts,
    windows: { pagesTotal, failed },
  };
}

/** The pages a windowed run read: every page but those of its failed
 *  windows. */
export function pagesReadOf(windows: NonNullable<PipelineRunResult['windows']>): number {
  const lost = windows.failed.reduce((n, w) => n + (w.to - w.from + 1), 0);
  return Math.max(0, windows.pagesTotal - lost);
}

/** Whether a Reader's text is a file's text: the Reader says it gives text
 *  (`produces.text`) and the core has no text route for the extension
 *  (`parserRouteForExt`, @mantle/files slug.ts). Where the core has one, the
 *  core's text stands. The one rule of the text pass and of the stamp a
 *  file of text and no tabs keeps in its word (file-database.ts). */
export function readerGivesText(
  pipeline: Pick<PipelineManifest, 'produces'>,
  ext: string,
): boolean {
  return pipeline.produces.text === true && parserRouteForExt(ext) === 'none';
}

/**
 * The one run of a Reader for a file's bytes, kept for the extract
 * (docs/pipelines.md, "Text and pictures from every Reader"): the database
 * pass, the text pass and the picture pass of an extract take the SAME run
 * from the one memo (@mantle/files reader-memo.ts), so a file costs one
 * parser job however many passes ask. Keyed by the pipeline's id and
 * version (a test's draft word too), the sha256 of the bytes, the
 * extension and the hash of the options. The CAD reader keeps its run in
 * the same memo, in a queue of its own, through its own job (@mantle/files
 * dwg.ts `cadRun`), as its text and picture passes sit in @mantle/files.
 * Model-free: no `ask`.
 * A failure throws as the run threw it, kept for the rest of the extract.
 */
export async function readerRun(
  pipeline: PipelineManifest & { source?: PipelineSource; draft?: string },
  bytes: Buffer,
  ext: string,
  options: Readonly<Record<string, unknown>>,
): Promise<PipelineRunResult> {
  if (pipeline.id === 'drawing-cad' && pipeline.source !== 'own') {
    const { cadRun } = await import('@mantle/files/dwg');
    const run = await cadRun(bytes, ext as CadExt);
    return { status: 'ok', ...run, warnings: [...run.warnings] };
  }
  const file = stepFileOf(bytes, ext);
  const key = readerRunKey(pipeline, file.sha256, ext, optionsHash(pipeline, options));
  return memoReaderRun(key, () =>
    readsInWindows(pipeline, ext)
      ? runWindowed(pipeline, bytes, file, { options })
      : runPackaged(pipeline, bytes, file, { options }),
  );
}

/** The memo key of a routed Reader's run (routedReaderRun): a file's
 *  router names one kind, so the kind is not in it, and the text pass finds
 *  the run by the Reader, the bytes and the options alone. */
export function routedRunKey(
  pipeline: PipelineManifest & { draft?: string },
  sha256: string,
  ext: string,
  options: Readonly<Record<string, unknown>>,
): string {
  return readerRunKey(pipeline, sha256, ext, `${optionsHash(pipeline, options)}:routed`);
}

/** Whether a Reader's text stands over the core's PDF read (P2,
 *  docs/pipelines.md, "Page windows"): it claims the kinds a router names
 *  (a PDF's book reader) and says `produces.text`. Then the core reads no
 *  text, runs no native read and no OCR of its own for the file, and the
 *  Reader's text is the file's text. */
export function readerStandsOver(
  pipeline: Pick<PipelineManifest, 'produces' | 'match'>,
): boolean {
  return pipeline.produces.text === true && (pipeline.match.kind?.length ?? 0) > 0;
}

/**
 * The run of a Reader that claims the kind the router named (a PDF's book
 * reader), kept for the extract as readerRun keeps a run, by the kind too:
 * the database pass makes it, and the text pass of the same extract
 * (load-body.ts, the Reader's text stands over the core's PDF read) takes
 * the same run, with no second job. A windowed Reader reads in windows
 * (runWindowed); its body is the file, never the router's facts.
 */
export async function routedReaderRun(
  pipeline: PipelineManifest & { source?: PipelineSource; draft?: string },
  bytes: Buffer,
  ext: string,
  options: Readonly<Record<string, unknown>>,
  named: { kind: string; state: unknown },
): Promise<PipelineRunResult> {
  const file = stepFileOf(bytes, ext);
  const key = routedRunKey(pipeline, file.sha256, ext, options);
  return memoReaderRun(key, () =>
    readsInWindows(pipeline, ext)
      ? runWindowed(pipeline, bytes, file, { options, kind: named.kind, state: named.state })
      : runPackaged(pipeline, bytes, file, { options, kind: named.kind, state: named.state }),
  );
}

/** The most rows of a tab an `after` pipeline reads. */
export const AFTER_TEXT_ROWS_MAX = 500_000;

/** The most bytes of the body of an `after` pipeline's job. The largest
 *  honest body is 10 to 14 MB; a hostile file's (cells of control
 *  characters, each written six bytes wide) is cut here. */
export const AFTER_BODY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The body of an `after` pipeline's job (@mantle/files tabs-body.ts): the
 * needed tabs of the shape it names in `match.after`, with their columns,
 * read from the database at `abs`, read only. A tab past the row cap, or a
 * body past `maxBytes`, is cut there, with the warning the adapter gave
 * ("Only the first N texts were read."). The body is built from Buffer
 * chunks, so it is held about once (twice for the moment of the concat).
 */
export function afterBodyOf(
  abs: string,
  pipeline: PipelineManifest,
  maxBytes = AFTER_BODY_MAX_BYTES,
): { body: Buffer; warnings: string[] } {
  const shape = SHAPES[pipeline.match.after as ShapeId];
  if (!shape) throw new Error(`${pipeline.id} names no shape it reads`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  const add = (line: string): boolean => {
    const chunk = Buffer.from(line, 'utf8');
    if (bytes + chunk.length > maxBytes) return false;
    chunks.push(chunk);
    bytes += chunk.length;
    return true;
  };
  const warnings: string[] = [];
  for (const tab of shape.tabs.filter((t) => t.needed)) {
    if (!add(tabHeadLine(tab.name, tab.columns))) break;
    let rows = 0;
    let full = false;
    scanTabColumns(
      abs,
      tab.name,
      tab.columns,
      { maxRows: AFTER_TEXT_ROWS_MAX, cellMaxChars: AFTER_CELL_MAX_CHARS },
      (row) => {
        if (!add(tabRowLine(tab.columns.map((c) => row[c] ?? null)))) {
          full = true;
          return false;
        }
        rows += 1;
        return true;
      },
    );
    if (full || rows >= AFTER_TEXT_ROWS_MAX) {
      warnings.push(
        `Only the first ${rows.toLocaleString('en')} ${tab.name.toLowerCase()} were read.`,
      );
    }
    if (full) break;
  }
  return { body: Buffer.concat(chunks, bytes), warnings };
}
