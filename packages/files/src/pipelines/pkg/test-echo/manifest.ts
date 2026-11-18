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
  {
    id: 'test-window',
    name: 'Test window',
    description: 'A test-only package: it reads a PDF in page windows (./window-step.ts).',
    version: '1.0.0',
    api: PIPELINE_API,
    runtime: 'bun',
    entry: 'window-step.ts',
    start: 'upload',
    match: { ext: ['pdf'] },
    produces: { text: true, pages: true },
    needs: { weight: 'heavy', timeMs: 120_000, window: { pages: 50, mb: 50 } },
  },
];

export const TEST_PACKAGES: Readonly<Record<string, () => Promise<{ step: PipelineStep }>>> = {
  'test-echo': () => import('./step'),
  'test-window': () => import('./window-step'),
};
