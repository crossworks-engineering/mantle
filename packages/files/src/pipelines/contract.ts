/**
 * The pipeline contract: pure types and constants, no I/O. A pipeline reads
 * a file and writes the file's database (docs/pipelines.md). In phase 1 the
 * only pipelines are the built-in readers (./builtin.ts), each one step with
 * one `file_tabs_write` call, done in process by writeRowsOrWord
 * (packages/content/src/file-database.ts). The steps, calls and answers are
 * fixed now so a later phase adds code and breaks nothing.
 */
import type { ExtractWeight } from '../slug';

/** The contract version. It changes only when the contract breaks. */
export const PIPELINE_API = 1;
/** Steps one run may have (plan 3.4). */
export const PIPELINE_STEPS_MAX = { router: 2, pipeline: 4 } as const;
/** The one write tool of the first set, by its name in a call. */
export const FILE_TABS_WRITE = 'file_tabs_write';
/** The longest description of a pipeline, in characters. */
export const PIPELINE_DESCRIPTION_MAX = 300;

export type PipelineSource = 'builtin' | 'curated' | 'own';
/** `core`: a built-in reader that runs in this process, behind an adapter. */
export type PipelineRuntime = 'core' | 'python' | 'bun';
export type PipelineStart = 'upload' | 'demand';
export type PipelineInput = 'file' | 'none';
export type ShapeId = 'drawing-v1' | 'circuit-v1' | 'pdf-file-v1' | 'texts-v1';

/** One option, as a manifest declares it. There is no pattern type, by
 *  choice: JavaScript cannot stop a slow pattern, and the built-ins run in
 *  the web and api processes. A word list steers a grammar we have. */
export type PipelineOptionSpec =
  | { type: 'number'; label: string; help?: string; default: number; min: number; max: number }
  | { type: 'bool'; label: string; help?: string; default: boolean }
  | {
      type: 'words';
      label: string;
      help?: string;
      default: readonly string[];
      maxItems: number; // at most 200
      maxChars: number; // of one word, at most 16
    };

export type PipelineManifest = {
  id: string; // lower case, a-z 0-9 and '-', for example 'drawing-cad'
  name: string;
  /** What it reads and what it writes, in one or two plain sentences, 1 to
   *  PIPELINE_DESCRIPTION_MAX characters. A router uses the same field. Not
   *  in the version pin: it says nothing about the rows. */
  description: string;
  version: string; // semver, the pipeline's own
  api: number; // PIPELINE_API
  kit?: number;
  runtime: PipelineRuntime;
  entry?: string; // not for 'core'
  start: PipelineStart;
  input?: PipelineInput; // for start 'demand' only
  router?: true;
  match: {
    ext: readonly string[];
    magic?: readonly string[];
    kind?: readonly string[];
    after?: string;
  };
  /** The options a box may set, by name (OPTION_NAME: lower case, a-z 0-9
   *  and '_', starting with a letter). */
  options?: Readonly<Record<string, PipelineOptionSpec>>;
  produces: {
    kinds?: readonly string[];
    shapes?: readonly ShapeId[];
    text?: boolean;
    pictures?: boolean;
    file?: boolean;
    answer?: boolean;
    /** The tabs an `after` pipeline writes, by name. It may write no other. */
    tabs?: readonly string[];
  };
  needs: {
    timeMs?: number;
    memoryMb?: number;
    weight: ExtractWeight;
    /** AI worker kind -> the most asks for one file. */
    workers?: Readonly<Record<string, number>>;
    /** Brain tools it may call, by name. */
    tools?: readonly string[];
  };
};

/** What a step asks the core to do before the next step. */
export type PipelineCall =
  | { call: 'worker'; worker: string; input: unknown; question?: string }
  | { call: 'tool'; tool: string; input: unknown };

export type PipelineCallAnswer =
  | { ok: true; output: unknown }
  | { ok: false; error: 'not_available' | 'refused' | 'failed'; reason?: string };

export type PipelineStepRequest = {
  api: number;
  step: number; // 1 is the first
  file?: { name: string; ext: string; size: number; sha256: string };
  options: Readonly<Record<string, unknown>>;
  answers?: readonly PipelineCallAnswer[]; // from step 2 on
  state?: unknown; // what the step before returned
};

export type PipelineStepResult = {
  status: 'ok' | 'not_mine' | 'unsure' | 'failed';
  calls?: readonly PipelineCall[];
  state?: unknown;
  // From the last step:
  kind?: string;
  confidence?: number;
  answer?: string;
  warnings?: readonly string[];
  counts?: Readonly<Record<string, number>>;
};

/** The stamp of a file database: the four `_meta` keys of phase 1, and two
 *  that are written only when not ''. */
export type PipelineStamp = {
  pipeline_id: string;
  pipeline_version: string;
  pipeline_api: string; // a number as text: `_meta` values are text
  shapes: string; // ShapeId list joined by ',', '' for none
  /** The reader's options in force: 8 hex of their hash. Left out: all defaults. */
  pipeline_options?: string;
  /** The `after` pipelines that wrote tabs: `id@version#hash`, joined by ','. Left out: none. */
  pipelines_after?: string;
};
