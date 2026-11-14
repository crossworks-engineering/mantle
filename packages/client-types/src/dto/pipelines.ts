/**
 * The pipelines of a brain, as the Settings screen reads them
 * (docs/pipelines.md). GET /api/pipelines answers a `PipelineList`; the MCP
 * tool `pipeline_list` gives the same list. PATCH /api/pipelines/:id takes a
 * `PipelineSetBody` and answers the `PipelineRow`; the MCP tool
 * `pipeline_set` does the same.
 *
 * Every pipeline is a built-in. A reader reads a file into its database; an
 * `after` pipeline adds tabs to a database a reader made. The counts are
 * numbers only: no file name and no id.
 */

/** One option, as a manifest declares it. A copy of the contract's type
 *  (@mantle/files, pipelines/contract.ts): the client does not load that
 *  package. There is no pattern type, by choice. */
export type PipelineOptionSpec =
  | { type: 'number'; label: string; help?: string; default: number; min: number; max: number }
  | { type: 'bool'; label: string; help?: string; default: boolean }
  | {
      type: 'words';
      label: string;
      help?: string;
      default: readonly string[];
      /** At most 200. */
      maxItems: number;
      /** Of one word, at most 16. */
      maxChars: number;
    };

export type PipelineRow = {
  id: string;
  name: string;
  version: string;
  source: 'builtin' | 'curated' | 'own';
  start: 'upload' | 'demand';
  /** A reader reads files; an `after` pipeline adds tabs to a reader's database. */
  kind: 'reader' | 'after';
  /** The file extensions it reads. */
  reads: string[];
  weight: 'light' | 'heavy';
  /** The tab shapes it promises. */
  shapes: string[];
  /** The AI worker kinds it may ask. */
  workers: string[];
  /** The brain tools it may call. */
  tools: string[];
  /** 'all' (a reader), or the ids of the workspaces it is attached to. An
   *  `after` pipeline attached to no workspace does nothing. */
  workspaces: 'all' | string[];
  /** For an `after` pipeline: the shape it reads. Null for a reader. */
  after: string | null;
  /** The tabs an `after` pipeline writes. */
  tabs: string[];
  /** Each declared option, its spec, and the value in force on this box. */
  options: { name: string; spec: PipelineOptionSpec; value: unknown }[];
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

/**
 * What an Admin changes on one pipeline. A field left out stays as it is.
 * `options` merge into the stored ones. `workspaces` replaces the attach
 * list of an `after` pipeline; `[]` switches it off. A reader refuses
 * `workspaces`: it is used in every workspace.
 */
export type PipelineSetBody = {
  options?: Record<string, unknown>;
  workspaces?: string[];
};
