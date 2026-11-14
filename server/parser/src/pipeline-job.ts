/**
 * The parser job `pipelineRun`: one step of a packaged pipeline, run in this
 * job process (docs/pipelines.md, "The runner"). One job is one process, so
 * the step needs no child of its own; the server kills the group at the
 * deadline, as for every job.
 *
 * The options are `{ id, request }`. The id is looked up in the package
 * index (@mantle/files/pipelines/pkg); an id that is not a key is a
 * `bad_request`, and no path is built from the request. The step gets the
 * job handle (StepJob), its result is checked (checkStepResult) and written
 * to `out.json` as `{ ok: true, result, pictures }`.
 *
 * The time of a pipeline is not this job's to keep: a step may be
 * synchronous, and no timer here could fire before it ends. The server kills
 * the job's group at the pipeline's deadline (parserJobTimeoutMs: its
 * `needs.timeMs` when under the job's 240 s), and answers `timeout`. The job
 * handle's `deadline` is built on the same number. A throw is a JobFailure
 * by failureOf, as for every job; a step that returns `failed` is a
 * JobFailure('failed').
 *
 * The index is ./pipeline-index.ts (the test-only package only when
 * PARSER_TEST_PIPELINES is 1).
 */
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  FILE_TABS_WRITE,
  type PipelineStepRequest,
  type StepJob,
} from '@mantle/files/pipelines/contract';
import {
  PARSER_ANSWER_MAX_BYTES,
  PARSER_PICTURES_BUDGET_BYTES,
  parserJobTimeoutMs,
} from '@mantle/files/parser-wire';
import { stepLoaderOf } from '@mantle/files/pipelines/pkg';
import { checkStepResult } from '@mantle/files/pipelines/step-check';
import { tabRowsOf } from '@mantle/files/pipelines/tabs-body';
import { dwfRenderer, dwgRender, pdfEye, pdfPagePieces } from './cad';
import { JobFailure } from './job-failure';
import type { JobPaths } from './jobs';
import { PICTURES_RESERVE_MS, jobEndOf, pdfPictures } from './pictures';
import { pipelineIndex } from './pipeline-index';

/** The job handle of this job. */
function jobHandle(p: JobPaths, jobEnd: number, timeoutMs: number): StepJob {
  const end = jobEnd - PICTURES_RESERVE_MS;
  return {
    bytes: () => fs.readFile(p.input),
    tabRows: (tab) =>
      tabRowsOf(createInterface({ input: createReadStream(p.input), crlfDelay: Infinity }), tab),
    dir: p.dir,
    deadline: end,
    pdfEye: pdfEye(p.dir, end),
    pdfPictures: pdfPictures(p.input, p.dir, jobEnd),
    pdfPagePieces: (png, widthMm, name) => pdfPagePieces(png, widthMm, p.dir, name, end),
    cadRender: async (opts) => {
      const out = path.join(p.dir, 'cad-render.json');
      await dwgRender(p.input, { ...opts }, p.dir, out, timeoutMs);
      return JSON.parse(await fs.readFile(out, 'utf8')) as Record<string, unknown>;
    },
    dwfRender: dwfRenderer(p.dir, timeoutMs),
  };
}

/** The pictures a write call names: files in the job's folder, in order,
 *  until the answer's budget is spent. */
async function picturesOf(
  dir: string,
  calls: readonly { call: string; tool?: string; input?: unknown }[],
): Promise<{ file: string; bytes_base64: string }[]> {
  const out: { file: string; bytes_base64: string }[] = [];
  let total = 0;
  for (const c of calls) {
    if (c.call !== 'tool' || c.tool !== FILE_TABS_WRITE) continue;
    const named = (c.input as { pictures?: readonly { file?: unknown }[] }).pictures ?? [];
    for (const pic of named) {
      if (typeof pic.file !== 'string') continue;
      // A name in the job's folder, never a path out of it.
      const bytes = await fs.readFile(path.join(dir, path.basename(pic.file))).catch(() => null);
      if (!bytes || total + bytes.length > PARSER_PICTURES_BUDGET_BYTES) continue;
      total += bytes.length;
      out.push({ file: pic.file, bytes_base64: bytes.toString('base64') });
    }
  }
  return out;
}

export async function runPipelineJob(opts: Record<string, unknown>, p: JobPaths): Promise<void> {
  const id = typeof opts.id === 'string' ? opts.id : '';
  const request = opts.request as PipelineStepRequest | undefined;
  const { loaders, manifests } = await pipelineIndex();
  const load = stepLoaderOf(loaders, id);
  const manifest = manifests.find((m) => m.id === id);
  if (!load || !manifest) throw new JobFailure('bad_request', `no package "${id.slice(0, 64)}"`);
  if (!request || typeof request !== 'object' || typeof request.step !== 'number') {
    throw new JobFailure('bad_request', "'request' is required");
  }
  const { step } = await load();
  // The server's kill deadline of this job, for the handle's deadline.
  const timeoutMs = parserJobTimeoutMs('pipelineRun', manifest.needs.timeMs);
  // The check sees exactly what is sent: the JSON form of the result, as on
  // the old path, where out.json was JSON too. So a number that is not
  // finite is null and an undefined cell is dropped to null, not a refusal.
  // The result object is not kept: only its text lives on into the parse.
  const sent = jsonOf(await step(request, jobHandle(p, jobEndOf(timeoutMs), timeoutMs)));
  const checked = checkStepResult(JSON.parse(sent));
  if (!checked.ok) throw new JobFailure('failed', `the step's result was refused: ${checked.why}`);
  const { result } = checked;
  if (result.status === 'failed') {
    throw new JobFailure(
      'failed',
      (result.warnings ?? []).join(' ').slice(0, 2000) || `${id} failed`,
    );
  }
  const pictures = await picturesOf(p.dir, result.calls ?? []);
  await fs.writeFile(
    p.outJson,
    `{"ok":true,"result":${sent},"pictures":${JSON.stringify(pictures)}}`,
  );
}

/** A step's result as JSON, once. A result JSON cannot hold (a cycle, a
 *  bigint) or none at all is a refused result. A text over the answer cap
 *  is `too_large`, final, the answer the server gives the out.json later
 *  (answer.ts), given here before the text is parsed, so a result too large
 *  to send never costs the parse's memory (a `crashed` job, counted). */
export function jsonOf(raw: unknown, maxBytes = PARSER_ANSWER_MAX_BYTES): string {
  let sent: string | undefined;
  try {
    sent = JSON.stringify(raw);
  } catch {
    sent = undefined;
  }
  if (sent === undefined) {
    throw new JobFailure('failed', "the step's result was refused: it is not JSON");
  }
  const size = Buffer.byteLength(sent, 'utf8');
  if (size > maxBytes) {
    throw new JobFailure(
      'too_large',
      `the answer is ${Math.round(size / 1024 / 1024)} MB, past the ${maxBytes / 1024 / 1024} MB an answer may be`,
      { final: true },
    );
  }
  return sent;
}
