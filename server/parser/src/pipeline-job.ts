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
 * PARSER_TEST_PIPELINES is 1). An id the index does not hold is an own
 * pipeline's (docs/pipelines.md, "Own pipelines"): the options carry its
 * `version` (or `draft`, the word of a test's draft folder), and its folder on the read-only
 * mount is built from those checked words only (ownPipelineOf). A Bun step
 * is imported from there and called in this process, as a built-in's; a
 * Python step runs as a child of this job (pythonStep). One job, one
 * result check, one failure count for both.
 */
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  FILE_TABS_WRITE,
  VISION_WORKER,
  type PipelineManifest,
  type PipelineStep,
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
import { childFailure, dwfRenderer, dwgRender, pdfEye, pdfPagePieces, pythonOf } from './cad';
import { JobFailure } from './job-failure';
import type { JobPaths } from './jobs';
import { PICTURES_RESERVE_MS, jobEndOf, pdfPictures } from './pictures';
import { ownPipelineOf, pipelineIndex } from './pipeline-index';
import { childEnv, runChild } from './proc';

/** The job handle of this job. Each child of the CAD tier gets the time
 *  left to `end`, as `pdfEye` does, so the step keeps time to build its
 *  write after the child. */
export function jobHandle(p: JobPaths, jobEnd: number): StepJob {
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
      await dwgRender(p.input, { ...opts }, p.dir, out, end - Date.now());
      return JSON.parse(await fs.readFile(out, 'utf8')) as Record<string, unknown>;
    },
    dwfRender: (bytes, opts) => dwfRenderer(p.dir, end - Date.now())(bytes, opts),
  };
}

/** The pictures a step names: those of a write call and the one of each
 *  vision ask (docs/pipelines.md, "Vision asks of an own Reader"), files in
 *  the job's folder, in order, until the answer's budget is spent. */
export async function picturesOf(
  dir: string,
  calls: readonly { call: string; tool?: string; worker?: string; input?: unknown }[],
): Promise<{ file: string; bytes_base64: string }[]> {
  const out: { file: string; bytes_base64: string }[] = [];
  const sent = new Set<string>();
  let total = 0;
  for (const c of calls) {
    const input = (c.input ?? {}) as {
      pictures?: readonly { file?: unknown }[];
      picture?: unknown;
    };
    const named =
      c.call === 'tool' && c.tool === FILE_TABS_WRITE
        ? (input.pictures ?? [])
        : c.call === 'worker' && c.worker === VISION_WORKER
          ? [{ file: input.picture }]
          : [];
    for (const pic of named) {
      if (typeof pic.file !== 'string' || sent.has(pic.file)) continue;
      sent.add(pic.file);
      // A name in the job's folder, never a path out of it; its size before
      // its bytes, so a picture past the budget is never read.
      const at = path.join(dir, path.basename(pic.file));
      const size = (await fs.stat(at).catch(() => null))?.size;
      if (size === undefined || total + size > PARSER_PICTURES_BUDGET_BYTES) continue;
      const bytes = await fs.readFile(at).catch(() => null);
      if (!bytes || total + bytes.length > PARSER_PICTURES_BUDGET_BYTES) continue;
      total += bytes.length;
      out.push({ file: pic.file, bytes_base64: bytes.toString('base64') });
    }
  }
  return out;
}

/** The step of the pipeline the options name: a built-in's from the index
 *  (a built-in id always wins), else an own one's from the mount
 *  (ownPipelineOf): its Bun module, or its Python file as a child of this
 *  job (pythonStep). */
export async function stepOf(
  opts: Record<string, unknown>,
): Promise<{ step: PipelineStep; manifest: PipelineManifest }> {
  const id = typeof opts.id === 'string' ? opts.id : '';
  const { loaders, manifests } = await pipelineIndex();
  const load = stepLoaderOf(loaders, id);
  const manifest = manifests.find((m) => m.id === id);
  if (load && manifest) return { step: (await load()).step, manifest };
  const own = await ownPipelineOf(opts);
  const entry = path.join(own.dir, own.manifest.entry ?? '');
  if (own.manifest.runtime === 'python') {
    return { step: pythonStep(entry), manifest: own.manifest };
  }
  // A load failure (a bad import, a native part of another CPU type) throws
  // here: a `failed` job (failureOf), a verdict on the file, so its read is
  // `unreadable` at once, with the loader's sentence.
  const mod = (await import(entry)) as { step?: unknown };
  if (typeof mod.step !== 'function') {
    throw new JobFailure('failed', `the package ${id} exports no step from ${own.manifest.entry}`);
  }
  return { step: mod.step as PipelineStep, manifest: own.manifest };
}

/**
 * An own Python step (docs/pipelines.md, "Own pipelines"): the job writes
 * `request.json` in its folder beside `in.bin`, starts the package's entry
 * as a child in the job's own group (runChild, with childEnv: nothing of
 * the parser's), with the job's folder as its one argument and its working
 * folder, and reads `result.json` back. The result is checked as every
 * result. The child gets the time left to the handle's deadline; the
 * server's kill of the group at the job's deadline takes it in any case.
 */
function pythonStep(entry: string): PipelineStep {
  return async (request, job) => {
    await fs.writeFile(path.join(job.dir, 'request.json'), JSON.stringify(request));
    const ended = await runChild(pythonOf(), [entry, job.dir], {
      timeoutMs: Math.max(1_000, job.deadline - Date.now()),
      cwd: job.dir,
      env: childEnv(job.dir, {
        PYTHONDONTWRITEBYTECODE: '1',
        MPLBACKEND: 'Agg',
        MPLCONFIGDIR: path.join(job.dir, '.mpl'),
      }),
    });
    if (ended.code !== 0) throw childFailure(ended, 'the Python step');
    const file = path.join(job.dir, 'result.json');
    // Its size first: a result past the answer cap is `too_large`, as
    // jsonOf answers a Bun step's, and is never read whole.
    const size = await fs.stat(file).then(
      (s) => s.size,
      () => null,
    );
    if (size === null) throw new JobFailure('failed', 'the Python step wrote no result.json');
    tooLarge(size, PARSER_ANSWER_MAX_BYTES);
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as never;
    } catch {
      throw new JobFailure('failed', 'the Python step wrote no result.json that is JSON');
    }
  };
}

export async function runPipelineJob(opts: Record<string, unknown>, p: JobPaths): Promise<void> {
  const id = typeof opts.id === 'string' ? opts.id : '';
  const request = opts.request as PipelineStepRequest | undefined;
  const { step, manifest } = await stepOf(opts);
  if (!request || typeof request !== 'object' || typeof request.step !== 'number') {
    throw new JobFailure('bad_request', "'request' is required");
  }
  // The server's kill deadline of this job, for the handle's deadline.
  const timeoutMs = parserJobTimeoutMs('pipelineRun', manifest.needs?.timeMs);
  // The check sees exactly what is sent: the JSON form of the result, as on
  // the old path, where out.json was JSON too. So a number that is not
  // finite is null and an undefined cell is dropped to null, not a refusal.
  // The result object is not kept: only its text lives on into the parse.
  const sent = jsonOf(await step(request, jobHandle(p, jobEndOf(timeoutMs))));
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
  tooLarge(Buffer.byteLength(sent, 'utf8'), maxBytes);
  return sent;
}

/** An answer of `size` bytes past `maxBytes`: `too_large`, final. */
function tooLarge(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new JobFailure(
      'too_large',
      `the answer is ${Math.round(size / 1024 / 1024)} MB, past the ${maxBytes / 1024 / 1024} MB an answer may be`,
      { final: true },
    );
  }
}
