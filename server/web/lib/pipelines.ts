/**
 * The pipelines for the Settings screen (docs/pipelines.md). A thin
 * re-export: the list and the set live in @mantle/tools, beside
 * `pipeline_list` and `pipeline_set`, so each route and its tool give the
 * same answer from one function.
 */
export { listPipelines, setPipeline } from '@mantle/tools';
