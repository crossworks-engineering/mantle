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
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OPTS_LENGTH_HEADER } from '../parser-wire';
import type { PipelineStepRequest, StepJob } from './contract';
import { PIPELINE_PACKAGES, stepLoaderOf } from './pkg';
import { tabRowsOf } from './tabs-body';

async function* linesOf(text: string): AsyncGenerator<string> {
  for (const line of text.split('\n')) yield line;
}

export function inProcessStepJob(body: Buffer, dir: string): StepJob {
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
    cadRender: none('cadRender'),
    dwfRender: none('dwfRender'),
  };
}

/** The answer of the parser job `pipelineRun` to one request (the `init` a
 *  faked fetch gets), from the real step run in this process. A step with
 *  no pictures only: a picture is the parser's. */
export async function pipelineRunAnswer(init: RequestInit | undefined): Promise<Response> {
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
    const result = await step(opts.request, inProcessStepJob(all.subarray(n), dir));
    return Response.json({ ok: true, result, pictures: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
