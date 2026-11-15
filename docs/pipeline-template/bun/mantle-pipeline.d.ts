/**
 * The types of the Mantle pipeline contract an own Bun step uses (kit 1),
 * copied from packages/files/src/pipelines/contract.ts. The test
 * packages/files/src/pipelines/template.test.ts holds them to the contract,
 * so they cannot drift. Copy this file into your package.
 */

/** One column of a tab. */
export type ParsedColumn = {
  name: string;
  type: 'text' | 'number' | 'date' | 'datetime' | 'checkbox';
};

/** One tab: its columns and its rows, each row aligned to the columns. */
export type ParsedSheet = {
  name: string;
  columns: ParsedColumn[];
  rows: (string | number | boolean | null)[][];
};

/** The input of the one write call, `file_tabs_write`. */
export type FileTabsWriteInput = {
  tabs: ParsedSheet[];
  description?: string;
  ftsSkipColumns?: readonly string[];
};

/** What a step asks the core to do. An own step makes the write call only. */
export type PipelineCall = { call: 'tool'; tool: 'file_tabs_write'; input: FileTabsWriteInput };

/** What the core gives one step. */
export type PipelineStepRequest = {
  api: number;
  step: number;
  file?: { name: string; ext: string; size: number; sha256: string };
  /** The pipeline's options, with the values in force. */
  options: Readonly<Record<string, unknown>>;
  asks?: boolean;
};

/** The job handle: the file's bytes, the job's folder (the only place a
 *  step may write) and its deadline (ms since the epoch). */
export type StepJob = {
  bytes(): Promise<Buffer>;
  dir: string;
  deadline: number;
};

/** What a step gives back. */
export type PipelineStepResult = {
  status: 'ok' | 'not_mine' | 'failed';
  calls?: readonly PipelineCall[];
  warnings?: readonly string[];
  counts?: Readonly<Record<string, number>>;
};

/** A package's entry exports `step`. */
export type PipelineStep = (req: PipelineStepRequest, job: StepJob) => Promise<PipelineStepResult>;
