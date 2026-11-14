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

/** Why a run on demand did not take a file: the extension or the tabs do
 *  not match, no database for an `after` pipeline, the file's workspace is
 *  not in its attach list, no checksum, a private file, or the reader of a
 *  PDF drawing (refused for now). */
export type PipelineRunSkip =
  'no-match' | 'no-database' | 'not-attached' | 'no-sha' | 'private' | 'pdf';

/** The body of POST /api/files/files/:id/run and /api/files/folders/:id/run.
 *  With no `apply`, the dry run. `pipeline` is needed with `apply`. */
export type PipelineRunBody = {
  pipeline?: string;
  apply?: boolean;
  /** The most files one call looks at: 100 by default, at most 1000. */
  limit?: number;
  /** Go on after this file id: the `next` of the call before. */
  after?: string;
};

/** The answer of a run on demand, the dry run and the run alike. An older
 *  server has no run route (404). */
export type PipelineRunAnswer = {
  apply: boolean;
  /** The extract queue is busy: nothing was queued. */
  busy: boolean;
  /** The pipelines that can run on these files, with the count each takes.
   *  `refused`: a word when it may not run ('pdf'). */
  choices: { pipeline: string; name: string; files: number; refused: string | null }[];
  /** The files queued. Each one's stamp shows the run when it is done. */
  queued: number;
  /** The files the named pipeline does not take, by PipelineRunSkip word. */
  skipped: Record<string, number>;
  /** The last file id looked at, when there are more: send it as `after`. */
  next: string | null;
};

/** What an Admin sends to test one pipeline on one file. `options`, when
 *  given, are used in place of the saved ones (checked the same way), so a
 *  value is tried before the save. Nothing is written. */
export type PipelineTestBody = {
  fileId: string;
  options?: Record<string, unknown>;
};

/**
 * The result of a test of one pipeline on one file
 * (POST /api/pipelines/:id/test, the MCP tool `pipeline_test`). Nothing was
 * written: no database, no row, no stamp.
 */
export type PipelineTestResult = {
  /** `not_mine`: the pipeline does not take this file. `unsure`: a PDF the
   *  rules left unsure; no model was asked. `busy`: the parser was busy, try
   *  again; it is no failure. */
  status: 'ok' | 'not_mine' | 'unsure' | 'failed' | 'busy';
  pipeline: string;
  version: string;
  ms: number;
  /** For each tab: its row count, its columns, and its first 5 rows (a cell
   *  is cut at 200 characters). */
  tabs: { name: string; rows: number; columns: string[]; first: unknown[][] }[];
  shapes: string[];
  warnings: string[];
  /** The calls it would make, shown and not done. For a built-in: ['file_tabs_write']. */
  writes: string[];
  /** A fixed word when there is no result. */
  word: 'no-database' | 'no-match' | 'too-large' | 'unreadable' | 'no-rows' | null;
};
