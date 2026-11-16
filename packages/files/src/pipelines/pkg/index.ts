/**
 * The package index: every packaged built-in (`runtime: 'bun'` in
 * BUILTIN_PIPELINES, ../builtin.ts) by its id, to the loader of its step.
 * The parser job `pipelineRun` looks the id up here; an id that is not a key
 * is a `bad_request`. No path is ever built from a request.
 *
 * builtin.test.ts holds that each `bun` built-in has a key and each key is
 * such a built-in. The parser's boot smoke loads every step once, so a step
 * that does not load fails the image in CI (server/parser/src/main.ts).
 *
 * A move adds one line here (docs/pipelines.md, "The runner").
 */
import type { PipelineStep } from '../contract';

export type StepModule = { step: PipelineStep };
export type StepLoaders = Readonly<Record<string, () => Promise<StepModule>>>;

export const PIPELINE_PACKAGES: StepLoaders = {
  'drawing-cad': () => import('./drawing-cad/step'),
  'drawing-pdf': () => import('./drawing-pdf/step'),
  'iso-title-block': () => import('./iso-title-block/step'),
  'pdf-router': () => import('./pdf-router/step'),
  'plan-mspdi': () => import('./plan-mspdi/step'),
  'plot-dwf': () => import('./plot-dwf/step'),
  'site-tags': () => import('./site-tags/step'),
  sheet: () => import('./sheet/step'),
};

/** The loader of a key of `loaders`, or null. Own keys only, so a name of
 *  the object's prototype is no package. */
export function stepLoaderOf(loaders: StepLoaders, id: string): (() => Promise<StepModule>) | null {
  return Object.hasOwn(loaders, id) ? loaders[id]! : null;
}

/** Load every step of the index once (the boot smoke). */
export async function loadEveryStep(): Promise<number> {
  for (const [id, load] of Object.entries(PIPELINE_PACKAGES)) {
    const mod = await load();
    if (typeof mod.step !== 'function') throw new Error(`the package ${id} has no step`);
  }
  return Object.keys(PIPELINE_PACKAGES).length;
}
