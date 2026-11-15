/**
 * The package index the parser reads, and the manifests of its ids: the
 * brain's own list in the image (BUILTIN_PIPELINES, PIPELINE_PACKAGES). The
 * test-only package (pkg/test-echo) is added only when PARSER_TEST_PIPELINES
 * is 1: the parser's own tests set it. The server reads it for a job's kill
 * deadline (main.ts), the job for its step (./pipeline-job.ts).
 *
 * An own pipeline (docs/pipelines.md, "Own pipelines") is read from the
 * read-only mount, never from the index: `ownPipelineOf` builds its folder
 * from the checked id and version only (ownPackageDir, @mantle/files) and
 * reads its `pipeline.json` there, with one check: its id and version are
 * the ones asked. A built-in id always wins: an id of the index never reads
 * the mount. A folder that is not there, or holds another version (a roll
 * or a remove in between), is a `bad_request`: not counted, so it never
 * makes a file's read final.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { envFlag } from '@mantle/config';
import { BUILTIN_PIPELINES } from '@mantle/files/pipelines/builtin';
import type { PipelineManifest } from '@mantle/files/pipelines/contract';
import { ownPackageDir } from '@mantle/files/pipelines/own-folder';
import { PIPELINE_PACKAGES, type StepLoaders } from '@mantle/files/pipelines/pkg';
import { JobFailure } from './job-failure';

export async function pipelineIndex(): Promise<{
  loaders: StepLoaders;
  manifests: readonly PipelineManifest[];
}> {
  if (!envFlag('PARSER_TEST_PIPELINES')) {
    return { loaders: PIPELINE_PACKAGES, manifests: BUILTIN_PIPELINES };
  }
  const { TEST_PACKAGES, TEST_PIPELINES } = await import('@mantle/files/pipelines/pkg-test');
  return {
    loaders: { ...PIPELINE_PACKAGES, ...TEST_PACKAGES },
    manifests: [...BUILTIN_PIPELINES, ...TEST_PIPELINES],
  };
}

/** The manifest of the pipeline `id` in the index, or null when the index
 *  has none. An own-property lookup by equality: no key of a prototype is a
 *  pipeline. */
export async function pipelineManifestOf(id: unknown): Promise<PipelineManifest | null> {
  if (typeof id !== 'string') return null;
  return (await pipelineIndex()).manifests.find((m) => m.id === id) ?? null;
}

/** An own pipeline as the job runs it: its folder and its manifest. */
export type OwnPipeline = { dir: string; manifest: PipelineManifest };

/**
 * The own pipeline a job's options name (`{ id, version }`, or
 * `{ id, draft: true }` for a test's draft), read from the mount. Throws a
 * `bad_request` JobFailure when the words are not of their form, the
 * folder or its `pipeline.json` is not there, or it names another id or
 * version.
 */
export async function ownPipelineOf(opts: {
  id?: unknown;
  version?: unknown;
  draft?: unknown;
}): Promise<OwnPipeline> {
  const draft = opts.draft === true;
  const dir = ownPackageDir(opts.id, opts.version, draft);
  const named = `${String(opts.id).slice(0, 64)} ${draft ? '(draft)' : String(opts.version).slice(0, 20)}`;
  if (!dir) throw new JobFailure('bad_request', `no package "${named}"`);
  let manifest: PipelineManifest;
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(dir, 'pipeline.json'), 'utf8'),
    ) as PipelineManifest;
  } catch {
    throw new JobFailure('bad_request', `no package folder for ${named}`);
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.id !== opts.id ||
    (!draft && manifest.version !== opts.version)
  ) {
    throw new JobFailure('bad_request', `the package folder for ${named} holds another package`);
  }
  return { dir, manifest };
}

/** The manifest a job's options name: a built-in's from the index (a
 *  built-in id always wins), else an own one from the mount. */
export async function jobManifestOf(opts: {
  id?: unknown;
  version?: unknown;
  draft?: unknown;
}): Promise<PipelineManifest> {
  const builtin = await pipelineManifestOf(opts.id);
  if (builtin) return builtin;
  return (await ownPipelineOf(opts)).manifest;
}
