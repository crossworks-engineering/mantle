/**
 * The pipelines for the Settings screen (docs/pipelines.md). A thin
 * re-export: the list, the set and the test live in @mantle/tools, beside
 * `pipeline_list`, `pipeline_set` and `pipeline_test`, so each route and its tool give the
 * same answer from one function.
 */
export { listPipelines, setPipeline, testPipeline } from '@mantle/tools';
