/**
 * The job of a run on demand (docs/pipelines.md, "Run on demand"): one
 * pipeline on one file, sent by `pipeline_run` or its two routes through
 * the `pipeline_run` notify, and taken by the extract queue
 * (extract-queue.ts, enqueuePipelineRun) like any other job of a file.
 *
 *  - A reader: its database is built again from the file's bytes with
 *    `buildFileDatabase`, with no parse result and no decider, so no model
 *    is asked. The `after` chain then runs as at upload.
 *  - An `after` pipeline: the patch, `patchFileDatabase`. It reads the
 *    database, never the bytes, and keeps every other row.
 *
 * Nothing else of the file changes: no summary, no passage, no embedding,
 * no extract. One trace step, `file_database`, holds the result, as the
 * upload's. A failure (a throw of the build or the patch, the parser down)
 * is that step's error and changes nothing; the job ends there, with no
 * retry of its own and none by the queue: a person runs it again, and the
 * stamp shows what ran. So this function never throws.
 *
 * The reader of a PDF drawing is refused (`pdf`), as `pipeline-reread`
 * refuses it: a PDF's database can hold the decider's answer and the
 * sketch read, both paid for with a model call, and a read with no model
 * would lose them. Site tags on a PDF runs: the patch keeps every row.
 */
import {
  BUILTIN_PIPELINES,
  builtinForExt,
  fileDataExt,
  fileDataRow,
  fileSha256Of,
  isAfterPipeline,
  readFileNodeBytes,
} from '@mantle/files';
import {
  buildFileDatabase,
  patchFileDatabase,
  type FileDbBuild,
  type FilePatch,
} from '@mantle/content/file-database';
import { PIPELINE_RUN_REFUSED } from '@mantle/tools';
import { startTrace, step } from '@mantle/tracing';
import { errorMessage } from '@mantle/std';

export type PipelineRunResult =
  | FileDbBuild
  | FilePatch
  | { status: 'skipped'; reason: 'unknown-pipeline' | 'gone' | 'no-reader' | 'bytes-gone' | 'pdf' }
  | { status: 'failed' };

/** Whether a run job is of an `after` pipeline: it stays on the main queue
 *  (a patch reads no bytes). A reader's run takes the lane of its file. */
export function isAfterRun(pipelineId: string): boolean {
  const p = BUILTIN_PIPELINES.find((x) => x.id === pipelineId);
  return p ? isAfterPipeline(p) : false;
}

/** The run itself, with no trace. Throws what the build or the patch throws. */
async function runOnce(
  ownerId: string,
  nodeId: string,
  pipelineId: string,
): Promise<PipelineRunResult> {
  const pipeline = BUILTIN_PIPELINES.find((p) => p.id === pipelineId);
  if (!pipeline) return { status: 'skipped', reason: 'unknown-pipeline' };
  const refused = PIPELINE_RUN_REFUSED[pipeline.id];
  if (refused) return { status: 'skipped', reason: refused };
  const row = await fileDataRow(ownerId, nodeId);
  if (!row) return { status: 'skipped', reason: 'gone' };
  if (isAfterPipeline(pipeline)) {
    return patchFileDatabase({ fileId: nodeId, ownerId, sha256: fileSha256Of(row), pipeline });
  }
  // A reader runs only on a file it is the reader of.
  if (builtinForExt(fileDataExt(row))?.id !== pipeline.id) {
    return { status: 'skipped', reason: 'no-reader' };
  }
  const loaded = await readFileNodeBytes(row);
  if (!loaded) return { status: 'skipped', reason: 'bytes-gone' };
  // No `parsed` and no decider: the read asks no model.
  return buildFileDatabase({
    fileId: nodeId,
    ownerId,
    sha256: fileSha256Of(row),
    bytes: loaded.bytes,
    filename: loaded.filename,
  });
}

/** Run one pipeline on one file, in a trace of its own with one step.
 *  Never throws: a failure is the step's error, and the job is done. */
export async function runPipelineJob(
  ownerId: string,
  nodeId: string,
  pipelineId: string,
): Promise<PipelineRunResult> {
  return startTrace(
    {
      kind: 'pipeline_run',
      ownerId,
      subjectId: nodeId,
      subjectKind: 'node',
      data: { pipeline: pipelineId },
    },
    () =>
      step(
        {
          name: 'file_database',
          kind: 'compute',
          input: { sourceFileId: nodeId, pipeline: pipelineId },
        },
        async (h): Promise<PipelineRunResult> => {
          try {
            const out = await runOnce(ownerId, nodeId, pipelineId);
            h.setMeta({ ...out });
            return out;
          } catch (err) {
            h.setError(errorMessage(err));
            return { status: 'failed' };
          }
        },
      ),
  ).catch(() => ({ status: 'failed' as const }));
}
