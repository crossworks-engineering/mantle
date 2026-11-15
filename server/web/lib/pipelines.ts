/**
 * The pipelines for the Settings screen (docs/pipelines.md). A thin
 * re-export: the list, the set, the test, the install, the package and the
 * remove live in @mantle/tools, beside
 * `pipeline_list`, `pipeline_set`, `pipeline_test` and `pipeline_reread`, so each route and its tool give the
 * same answer from one function.
 */
export {
  installPipeline,
  listPipelines,
  pipelinePackage,
  removePipeline,
  rereadPipeline,
  setPipeline,
  testPipeline,
} from '@mantle/tools';
