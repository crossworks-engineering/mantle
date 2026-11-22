/**
 * The job of a run on demand (docs/pipelines.md, "Run on demand"): one pipeline
 * on one file, sent by `pipeline_run` or its two routes, `pipeline_reread`
 * and its route (never an Agent), the upload's
 * `after` chain, once, when the parser was busy or unavailable (model-free),
 * and an upload's build for each Agent of the file type (queueAgentRuns),
 * through the `pipeline_run` notify, and taken by the extract queue
 * (extract-queue.ts, enqueuePipelineRun) like any other job of a file.
 *
 *  - A reader: its database is built again from the file's bytes with
 *    `buildFileDatabase`, with no parse result and no decider of the
 *    file's kind, so no model is asked, but in one case: the page types
 *    of a PDF (Q2, plan page c607711a). A job with `pages` (a person's run
 *    of ONE PDF: `pipeline_run` of a Reader with a `file_id`, the tool or
 *    the Run button, notifyPipelineRun's `pages`) gives the read the page asks
 *    when pdfPageDeciderOf allows them (its two checks: llmWorkAllowed,
 *    and pdfPageAsksOn: `uses.pdf_kind.pages: true` with the use on and
 *    the model pin). The read then asks only the pages with no stored
 *    answer, under the file's cap, the box's day cap, the 3-in-a-row stop
 *    and the breaker; a kept answer is free (pdfPageKindsOver). Every cap
 *    ends in the rules, never in a wait. No other job has `pages`:
 *    pipeline_run of a folder, pipeline_reread, file_reindex, the `after`
 *    chain and an upload's Agent runs ask no model here. The `after`
 *    chain then runs as at upload.
 *  - An `after` pipeline: the patch, `patchFileDatabase`. It reads the
 *    database, never the bytes, and keeps every other row.
 *  - An Agent: `runAgentOnFile`, with the one guarded ask
 *    (./pipeline-ask.ts). It is the one run that may pay for a model,
 *    with the page asks of a Reader's run above (`pages`) the one other. A
 *    job a person or an agent queued starts it, and so does the build of
 *    an upload, which queues one run of it. A Reader's run on demand or
 *    read again queues none. The job has no retry
 *    (extract-queue.ts), so a failure never pays again by itself. When it
 *    wrote its tabs, their text goes on the file node for a plain search
 *    (./agent-text.ts), with no model, and the file's passages are built
 *    again from its stored text with that text (the embedder only). An
 *    Agent of a book's page text (pdf-page-read) saves the picture of each
 *    page it read with that text, in the same run (G1, images.ts
 *    bookPagePicturesFor).
 *
 * Nothing else of the file changes: no summary, no extract. One trace step, `file_database`, holds the result, as the
 * upload's. A failure (a throw of the build or the patch, the parser down)
 * is that step's error and changes nothing; the job ends there, with no
 * retry of its own and none by the queue: a person runs it again, and the
 * stamp shows what ran. So this function never throws.
 *
 * Two stops of an Agent's run are waits, not failures (owner decision
 * 2026-11-19: the provider is the cap, nothing is dropped): the provider's
 * "not now" (`provider_<reason>`) and the box's day cap of paid asks
 * (`day_cap`). The result then carries `wait` (runWaitOf), the step's meta
 * says it, and the queue sends the same run again later
 * (extract-queue.ts). The run again asks only what the tab does not hold.
 *
 * The reader of a PDF drawing is refused (`pdf`), as `pipeline-reread`
 * refuses it: a PDF's database can hold the decider's answer and the
 * sketch read, both paid for with a model call, and a read with no model
 * would lose them. Site tags on a PDF runs: the patch keeps every row.
 */
import {
  fileDataExt,
  fileDataRow,
  fileSha256Of,
  isAfterPipeline,
  isAgent,
  readFileNodeBytes,
} from '@mantle/files';
import {
  buildFileDatabase,
  patchFileDatabase,
  runAgentOnFile,
  type FileAgentRun,
  type FileDbBuild,
  type FilePatch,
} from '@mantle/content/file-database';
import { boxPipelines } from '@mantle/content/pipeline-registry';
import { filePagesOf } from '@mantle/content/page-passages';
import { startTrace, step } from '@mantle/tracing';
import { errorMessage } from '@mantle/std';
import { db, nodes } from '@mantle/db';
import { answerKeepFailed } from '@mantle/db/answer-cache';
import { and, eq } from 'drizzle-orm';
import { writeAgentText } from './agent-text.js';
import { bookPagePicturesFor } from './images.js';
import { writeRetrievalChunks } from './index-writes.js';
import { pipelineAskOf } from './pipeline-ask.js';
import { pdfPageDeciderOf } from './pdf-kind.js';
import { DAY_CAP_STOP, providerWaitOfStop } from '@mantle/content/pipeline-agent';
import { pipelineAsksDayCap, pipelineAsksFreeAt } from '@mantle/content/pipeline-asks';
import type { ProviderWaitReason } from '@mantle/std';

/** Why a run job is sent again later (extract-queue.ts): the provider's
 *  "not now" (its reason), or the day cap of paid asks (when it has room). */
export type RunWait =
  { for: 'provider'; reason: ProviderWaitReason } | { for: 'day_cap'; until: Date };

/** The shortest gap before a run held at the day cap is tried again: a
 *  slot another run takes first sends it back, and each try is a parser
 *  job (no paid call). */
export const DAY_CAP_MIN_GAP_MS = 5 * 60_000;

/** What the guards read for {@link runWaitOf}: stand-ins in a test. */
export type RunWaitDeps = {
  dayCap(): number;
  freeAt(ownerId: string, cap: number, now: Date): Promise<Date | null>;
  now(): Date;
};

/**
 * Whether a run's result is a wait: the stop of an Agent's run by the
 * provider's "not now" or by the day cap. Null for every other result. A
 * day cap of 0 (the operator's "no Agent may ask") is no wait: nothing is
 * deferred to.
 */
export async function runWaitOf(
  ownerId: string,
  out: PipelineRunResult,
  deps: Partial<RunWaitDeps> = {},
): Promise<RunWait | null> {
  if (out.status !== 'asked' || !('stopped' in out) || out.stopped === undefined) return null;
  const reason = providerWaitOfStop(out.stopped);
  if (reason) return { for: 'provider', reason };
  if (out.stopped !== DAY_CAP_STOP) return null;
  const d: RunWaitDeps = {
    dayCap: pipelineAsksDayCap,
    freeAt: pipelineAsksFreeAt,
    now: () => new Date(),
    ...deps,
  };
  const now = d.now();
  const free = await d.freeAt(ownerId, d.dayCap(), now);
  if (!free) return null;
  return {
    for: 'day_cap',
    until: new Date(Math.max(free.getTime(), now.getTime() + DAY_CAP_MIN_GAP_MS)),
  };
}

export type PipelineRunResult =
  | FileDbBuild
  | FilePatch
  | FileAgentRun
  | { status: 'skipped'; reason: 'unknown-pipeline' | 'gone' | 'no-reader' | 'bytes-gone' }
  | { status: 'failed' };

/** Whether a run job is of an `after` pipeline of this box: it stays on the
 *  main queue (a patch reads no bytes). A reader's run takes the lane of
 *  its file. */
export async function isAfterRun(ownerId: string, pipelineId: string): Promise<boolean> {
  const p = (await boxPipelines(ownerId)).byId(pipelineId);
  return p ? isAfterPipeline(p) : false;
}

/** The run itself, with no trace. Throws what the build or the patch throws. */
async function runOnce(
  ownerId: string,
  nodeId: string,
  pipelineId: string,
  pages: boolean,
  deps: RunDeps,
): Promise<PipelineRunResult> {
  const pipelines = await boxPipelines(ownerId);
  const pipeline = pipelines.byId(pipelineId);
  if (!pipeline) return { status: 'skipped', reason: 'unknown-pipeline' };
  const row = await fileDataRow(ownerId, nodeId);
  if (!row) return { status: 'skipped', reason: 'gone' };
  // An Agent: one parser job on the bytes, then the paid asks through the
  // one guarded ask, then the core's write. This is the only caller that
  // gives an Agent an `ask`, and it runs for a job a person or an agent
  // queued with `pipeline_run`, or one an upload's build queued.
  if (isAgent(pipeline)) {
    const loaded = await readFileNodeBytes(row);
    if (!loaded) return { status: 'skipped', reason: 'bytes-gone' };
    const sha256 = fileSha256Of(row);
    const ask = pipelineAskOf(ownerId, nodeId, pipeline);
    const out = await runAgentOnFile({
      fileId: nodeId,
      ownerId,
      sha256,
      bytes: loaded.bytes,
      filename: loaded.filename,
      pipeline,
      pipelines,
      ask,
      // G1: an Agent of page text (pdf-page-read) saves the picture of each
      // book page it read, with that text, in this run.
      ...(pipeline.produces.pages === true && typeof sha256 === 'string'
        ? { pagePictures: bookPagePicturesFor(ownerId, nodeId, sha256) }
        : {}),
    });
    if (out.status !== 'asked') return out;
    // The text of the tabs as written, on the file node; it is not in the
    // trace step's meta. A failed write is a warning: the tabs stand.
    const { text, ...done } = out;
    if (text !== undefined) {
      const sha = String(fileSha256Of(row));
      const changed = await writeAgentText(ownerId, nodeId, sha, pipeline.id, text).catch(
        (err: unknown) => {
          done.warnings.push(`the text for search was not written: ${errorMessage(err)}`);
          return false;
        },
      );
      // The passages again, from the file's stored text and the new Agent
      // text: the old passages' vectors come from the embed cache. An Agent
      // of page text (`produces.pages`) gives its text by page, read from
      // its tab when the passages are built (P3): new answers build them
      // again too.
      if (changed || (pipeline.produces.pages === true && done.made > 0)) {
        await passagesAgain(ownerId, nodeId).catch((err: unknown) => {
          done.warnings.push(`the passages were not written again: ${errorMessage(err)}`);
        });
      }
    }
    return done;
  }
  if (isAfterPipeline(pipeline)) {
    return patchFileDatabase({
      fileId: nodeId,
      ownerId,
      sha256: fileSha256Of(row),
      pipeline,
      pipelines,
    });
  }
  // A reader runs only on a file it is the reader of: by the extension, or
  // a Reader that claims the kinds the file type's router names (a PDF's
  // book reader), whose build names the kind again (buildFileDatabase).
  const ext = fileDataExt(row);
  const claims =
    pipeline.match.ext.includes(ext) &&
    (pipeline.match.kind?.length ?? 0) > 0 &&
    pipelines.routerFor(ext) !== null;
  if (pipelines.readerFor(ext)?.id !== pipeline.id && !claims) {
    return { status: 'skipped', reason: 'no-reader' };
  }
  const loaded = await readFileNodeBytes(row);
  if (!loaded) return { status: 'skipped', reason: 'bytes-gone' };
  // No `parsed` and no decider of the kind: a PDF keeps its stored kind,
  // and one with a sketch read is skipped (`sketch`). The page asks only
  // for a person's run of one PDF (`pages`), behind their two checks.
  const pdfPages =
    pages && pipelines.routerFor(ext)
      ? await deps.pageDecider(ownerId, nodeId).catch(() => null)
      : null;
  return buildFileDatabase({
    fileId: nodeId,
    ownerId,
    sha256: fileSha256Of(row),
    bytes: loaded.bytes,
    filename: loaded.filename,
    pipelines,
    ...(pdfPages ? { pdfPages } : {}),
  });
}

/** What a run reads for the page asks: a stand-in in a test. */
export type RunDeps = { pageDecider: typeof pdfPageDeciderOf };

const RUN_DEPS: RunDeps = { pageDecider: (o, n) => pdfPageDeciderOf(o, n) };

/** Run one pipeline on one file, in a trace of its own with one step.
 *  Never throws: a failure is the step's error, and the job is done. A
 *  result with `wait` is a run the queue sends again later. `lane` 'book':
 *  a run in the book lane, said on its trace (the reapers give it the book
 *  lane's budget). `pages`: the job's mark of a person's run of one file
 *  (Q2): a Reader's read of a PDF may ask its untyped pages (runOnce). */
export async function runPipelineJob(
  ownerId: string,
  nodeId: string,
  pipelineId: string,
  lane?: 'book',
  pages = false,
  deps: Partial<RunDeps> = {},
): Promise<PipelineRunResult & { wait?: RunWait }> {
  const d: RunDeps = { ...RUN_DEPS, ...deps };
  return startTrace(
    {
      kind: 'pipeline_run',
      ownerId,
      subjectId: nodeId,
      subjectKind: 'node',
      data: {
        pipeline: pipelineId,
        source: 'run',
        ...(lane ? { lane } : {}),
        ...(pages ? { pages: true } : {}),
      },
    },
    () =>
      step(
        {
          name: 'file_database',
          kind: 'compute',
          input: { sourceFileId: nodeId, pipeline: pipelineId },
        },
        async (h): Promise<PipelineRunResult & { wait?: RunWait }> => {
          try {
            const out = await runOnce(ownerId, nodeId, pipelineId, pages, d);
            // A read of the wait that fails is no wait: the run stops as a
            // stop always did, and a person runs it again.
            const wait = await runWaitOf(ownerId, out).catch(() => null);
            // A paid answer of the run that was not kept (answer-cache.ts):
            // the queue fails the run once instead of its wait (sendWaiting),
            // so its trace says no wait.
            h.setMeta({
              ...out,
              ...(wait && !answerKeepFailed()
                ? {
                    waiting:
                      wait.for === 'provider'
                        ? { for: 'provider', reason: wait.reason }
                        : { for: 'day_cap', until: wait.until.toISOString() },
                  }
                : {}),
            });
            return wait ? { ...out, wait } : out;
          } catch (err) {
            h.setError(errorMessage(err));
            return { status: 'failed' };
          }
        },
      ),
  ).catch(() => ({ status: 'failed' as const }));
}

/** The passages of a file node again, from its stored text (`data.text`,
 *  the extract's) and its Agents' text now (writeRetrievalChunks adds it).
 *  A file with no stored text yet is left: its extract adds the Agent text
 *  when it writes the passages. */
export async function passagesAgain(ownerId: string, nodeId: string): Promise<void> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)));
  if (!node || node.type !== 'file') return;
  const data = (node.data ?? {}) as Record<string, unknown>;
  const text = typeof data.text === 'string' ? data.text : '';
  // A file with no stored text but pages in its database (P3) has
  // passages all the same: they are built from the pages.
  if (text.trim() === '') {
    const pages = await filePagesOf({ id: node.id, ownerId, sha256: data.sha256 });
    if (!pages || pages.pages.length === 0) return;
  }
  await writeRetrievalChunks(node, ownerId, text, null);
}
