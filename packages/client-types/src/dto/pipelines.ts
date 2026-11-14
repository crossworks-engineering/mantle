/**
 * The pipelines of a brain, as the Settings screen reads them
 * (docs/pipelines.md). GET /api/pipelines answers a `PipelineList`; the MCP
 * tool `pipeline_list` gives the same list.
 *
 * In phase 1 every pipeline is a built-in reader. The counts are numbers
 * only: no file name and no id.
 */

export type PipelineRow = {
  id: string;
  name: string;
  version: string;
  source: 'builtin' | 'curated' | 'own';
  start: 'upload' | 'demand';
  /** The file extensions it reads. */
  reads: string[];
  weight: 'light' | 'heavy';
  /** The tab shapes it promises. */
  shapes: string[];
  /** The AI worker kinds it may ask. */
  workers: string[];
  /** The brain tools it may call. */
  tools: string[];
  /** Files with a database of this pipeline; null when not counted. */
  files: number | null;
  /** Of those, read at an older version or before stamps. */
  older: number | null;
};

export type PipelineList = {
  /** The contract version. */
  api: number;
  pipelines: PipelineRow[];
  /** The scan stopped at its cap: the counts are of the first files only. */
  countsPartial: boolean;
};
