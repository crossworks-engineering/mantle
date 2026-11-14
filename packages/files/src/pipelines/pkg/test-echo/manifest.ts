/**
 * The test-only package's manifest and loader (./step.ts). Not a built-in and
 * not in the package index of the image: the parser job adds this map only
 * when PARSER_TEST_PIPELINES is 1 (server/parser/src/pipeline-job.ts).
 */
import { PIPELINE_API, type PipelineManifest, type PipelineStep } from '../../contract';

export const TEST_PIPELINES: readonly PipelineManifest[] = [
  {
    id: 'test-echo',
    name: 'Test echo',
    description: 'A test-only package: it writes back what it was given.',
    version: '1.0.0',
    api: PIPELINE_API,
    runtime: 'bun',
    entry: 'step.ts',
    start: 'upload',
    match: { ext: ['echo'] },
    produces: {},
    needs: { weight: 'light', timeMs: 3_000, workers: { decider: 1 } },
  },
];

export const TEST_PACKAGES: Readonly<Record<string, () => Promise<{ step: PipelineStep }>>> = {
  'test-echo': () => import('./step'),
};
