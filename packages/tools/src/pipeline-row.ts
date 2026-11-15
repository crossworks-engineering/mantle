/**
 * One row of the pipelines list (pipeline_list, GET /api/pipelines), from
 * a pipeline of the registry and its state on this box: the one builder,
 * for the list, the set and the install (docs/pipelines.md).
 */
import { isAfterPipeline, isRouter, type PipelineManifest } from '@mantle/files';
import type { BoxPipeline, BoxPipelines } from '@mantle/content/pipeline-registry';
import type { PipelineState } from '@mantle/content/pipeline-state';
import type { PipelineOptionSpec, PipelineRow } from '@mantle/client-types';

/** The client's copy of the spec is the contract's type: this fails to
 *  compile when the two drift. */
const specOut = (spec: NonNullable<PipelineManifest['options']>[string]): PipelineOptionSpec =>
  spec;

/** One row of the list: the manifest, with its state on this box and its
 *  problem (the registry's sentence, or null). No counts. */
export function rowOf(p: BoxPipeline, state: PipelineState, pipelines: BoxPipelines): PipelineRow {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    version: p.version,
    source: p.source,
    // An own row's problem; a built-in has none (an own row with its id is
    // in `problems` only).
    problem: p.source === 'own' ? (pipelines.problems.get(p.id) ?? null) : null,
    start: p.start,
    kind: isRouter(p) ? 'router' : isAfterPipeline(p) ? 'after' : 'reader',
    reads: [...p.match.ext],
    names: (p.produces.kinds ?? []).map((k) => ({ kind: k.kind, decider: k.decider === true })),
    claims: [...(p.match.kind ?? [])],
    weight: p.needs.weight,
    shapes: [...(p.produces.shapes ?? [])],
    workers: Object.keys(p.needs.workers ?? {}),
    tools: [...(p.needs.tools ?? [])],
    // Kept for older clients, always 'all': the list is `offIn`.
    workspaces: 'all',
    offIn: [...state.offIn],
    after: p.match.after ?? null,
    tabs: [...(p.produces.tabs ?? [])],
    options: Object.entries(p.options ?? {}).map(([name, spec]) => ({
      name,
      spec: specOut(spec),
      value: state.options[name],
    })),
    files: null,
    older: null,
    versions: [],
    runs: state.runs,
    lastRunAt: state.lastRunAt ? state.lastRunAt.toISOString() : null,
  };
}
