/**
 * A job handle for a test that runs a step in its own process (the golden
 * compare of a move, docs/pipelines.md): the body, the folder and the rows
 * of an `after` body, as the parser job gives them. The native helpers are
 * the parser's alone: a step that needs one is tested through a real parser
 * job (packages/content/src/pipeline-runner.test.ts shows how).
 *
 * pipelineRunAnswer stands in for the parser's `pipelineRun` job in a test
 * that fakes the parser at the fetch: it runs the real step of the index
 * in this process on the request's body and answers as the job does.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { errorMessage } from '@mantle/std';
import { OPTS_LENGTH_HEADER, PARSER_ROUTES } from '../parser-wire';
import type { PipelineStepRequest, PipelineStepResult, StepJob } from './contract';
import { PIPELINE_PACKAGES, stepLoaderOf } from './pkg';
import { tabRowsOf } from './tabs-body';

async function* linesOf(text: string): AsyncGenerator<string> {
  for (const line of text.split('\n')) yield line;
}

/** Fakes of the native helpers a test may give (the CAD tier's reply). */
export type StepHelpers = Partial<Pick<StepJob, 'cadRender'>>;

export function inProcessStepJob(body: Buffer, dir: string, helpers: StepHelpers = {}): StepJob {
  const none = (name: string) => () => {
    throw new Error(`${name} runs only in a parser job`);
  };
  return {
    bytes: () => Promise.resolve(body),
    tabRows: (tab) => tabRowsOf(linesOf(body.toString('utf8')), tab),
    dir,
    deadline: Date.now() + 240_000,
    pdfEye: none('pdfEye'),
    pdfPictures: none('pdfPictures'),
    pdfPagePieces: none('pdfPagePieces'),
    cadRender: helpers.cadRender ?? none('cadRender'),
    dwfRender: none('dwfRender'),
  };
}

/** The pictures a step's write names, read from its folder as the job reads
 *  them (server/parser/src/pipeline-job.ts picturesOf, with no budget). */
function picturesOf(
  dir: string,
  result: PipelineStepResult,
): { file: string; bytes_base64: string }[] {
  const out: { file: string; bytes_base64: string }[] = [];
  for (const c of result.calls ?? []) {
    if (c.call !== 'tool') continue;
    for (const pic of (c.input as { pictures?: { file: string }[] }).pictures ?? []) {
      const at = path.join(dir, path.basename(pic.file));
      if (existsSync(at))
        out.push({ file: pic.file, bytes_base64: readFileSync(at).toString('base64') });
    }
  }
  return out;
}

/** The answer of the parser job `pipelineRun` to one request (the `init` a
 *  faked fetch gets), from the real step run in this process. */
export async function pipelineRunAnswer(
  init: RequestInit | undefined,
  helpers: StepHelpers = {},
): Promise<Response> {
  const all = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
  const headers = new Headers(init?.headers);
  const n = Number(headers.get(OPTS_LENGTH_HEADER) ?? 0);
  const opts = JSON.parse(all.subarray(0, n).toString('utf8')) as {
    id: string;
    request: PipelineStepRequest;
  };
  const load = stepLoaderOf(PIPELINE_PACKAGES, opts.id);
  if (!load) return Response.json({ ok: false, error: { code: 'bad_request' } }, { status: 400 });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pipeline-run-answer-'));
  try {
    const { step } = await load();
    const result = await step(opts.request, inProcessStepJob(all.subarray(n), dir, helpers));
    return Response.json({ ok: true, result, pictures: picturesOf(dir, result) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A fetch for a test with no parser (a database test that uploads a CSV or a
 * workbook): it answers the job `pipelineRun` by running the packaged step in
 * this process, with the handle above, as the job would, and sends every
 * other route to `other` (by default a 503, a parser that is not there). A
 * throw of the step is the job's `failed`. The real job is tested through a
 * real parser (packages/content/src/pipeline-runner.test.ts).
 */
export function inProcessPipelineFetch(
  other: (url: string, init?: RequestInit) => Promise<Response> = async () =>
    new Response('no parser', { status: 503 }),
  helpers: StepHelpers = {},
): (input: unknown, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (new URL(url).pathname !== PARSER_ROUTES.pipelineRun) return other(url, init);
    const all = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
    const headers = new Headers(init?.headers);
    const headLength = Number(headers.get(OPTS_LENGTH_HEADER));
    const opts = JSON.parse(all.subarray(0, headLength).toString('utf8')) as {
      id: string;
      request: PipelineStepRequest;
    };
    const load = stepLoaderOf(PIPELINE_PACKAGES, opts.id);
    if (!load) {
      return Response.json(
        { ok: false, error: { code: 'bad_request', message: 'no such package' } },
        { status: 400 },
      );
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'step-job-'));
    try {
      const { step } = await load();
      const result = await step(
        opts.request,
        inProcessStepJob(all.subarray(headLength), dir, helpers),
      );
      return Response.json({ ok: true, result, pictures: picturesOf(dir, result) });
    } catch (err) {
      // A fake helper may throw the job's typed failure (a `code`).
      const code = (err as { code?: unknown } | null)?.code;
      return Response.json(
        {
          ok: false,
          error: { code: typeof code === 'string' ? code : 'failed', message: errorMessage(err) },
        },
        { status: 422 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
