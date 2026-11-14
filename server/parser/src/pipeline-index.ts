/**
 * The package index the parser reads, and the manifests of its ids: the
 * brain's own list in the image (BUILTIN_PIPELINES, PIPELINE_PACKAGES). The
 * test-only package (pkg/test-echo) is added only when PARSER_TEST_PIPELINES
 * is 1: the parser's own tests set it. The server reads it for a job's kill
 * deadline (main.ts), the job for its step (./pipeline-job.ts).
 */
import { envFlag } from '@mantle/config';
import { BUILTIN_PIPELINES } from '@mantle/files/pipelines/builtin';
import type { PipelineManifest } from '@mantle/files/pipelines/contract';
import { PIPELINE_PACKAGES, type StepLoaders } from '@mantle/files/pipelines/pkg';

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

/** The manifest of the pipeline `id`, or null when the index has none. An
 *  own-property lookup by equality: no key of a prototype is a pipeline. */
export async function pipelineManifestOf(id: unknown): Promise<PipelineManifest | null> {
  if (typeof id !== 'string') return null;
  return (await pipelineIndex()).manifests.find((m) => m.id === id) ?? null;
}
