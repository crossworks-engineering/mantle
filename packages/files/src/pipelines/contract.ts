/**
 * The pipeline contract: pure types and constants, no I/O. A pipeline reads
 * a file and writes the file's database (docs/pipelines.md). In phase 1 the
 * only pipelines are the built-in readers (./builtin.ts), each one step with
 * one `file_tabs_write` call, done in process by writeRowsOrWord
 * (packages/content/src/file-database.ts). The steps, calls and answers are
 * fixed now so a later phase adds code and breaks nothing.
 */
import type { DwfRenderFn } from '../dwf-images';
import type { EyeFn, RenderFn } from '../pdf-drawing';
import type { ParsedSheet } from '../sheet-to-grid';
import type { ExtractWeight } from '../slug';

/** The contract version. It changes only when the contract breaks. */
export const PIPELINE_API = 1;
/** Steps one run may have (plan 3.4). */
export const PIPELINE_STEPS_MAX = { router: 2, pipeline: 4 } as const;
/** The one write tool of the first set, by its name in a call. */
export const FILE_TABS_WRITE = 'file_tabs_write';
/** The kit version: what a package may import (./kit.ts). */
export const PIPELINE_KIT = 1;
/** The limits of one step's result (./step-check.ts): the calls, the
 *  `state` as JSON, and the length of `kind`. The request travels as the
 *  parser's options (512 KB at most), so `state` is half of that. */
export const PIPELINE_CALLS_MAX = 64;
export const PIPELINE_STATE_MAX_BYTES = 256 * 1024;
export const PIPELINE_KIND_MAX_CHARS = 64;
/** The most bytes, as JSON, of the facts a router hands the reader
 *  (`facts`, docs/pipelines.md "The router"). A router with more leaves
 *  them out, and the reader reads the file itself. Well under the answer
 *  cap, so a router's answer never passes it for the facts alone. */
export const PIPELINE_FACTS_MAX_BYTES = 32 * 1024 * 1024;
/** The longest description of a pipeline, in characters. */
export const PIPELINE_DESCRIPTION_MAX = 300;

export type PipelineSource = 'builtin' | 'curated' | 'own';

/** One file of an own package: text as it is, or binary bytes as base64. */
export type PipelinePackageFile = string | { base64: string };
/** An own package (docs/pipelines.md, "Own pipelines"): a tree of files,
 *  path -> file. `pipeline.json` is its manifest. */
export type PipelinePackage = { files: Readonly<Record<string, PipelinePackageFile>> };
/** The manifest of an own package, always text. */
export const PIPELINE_MANIFEST_FILE = 'pipeline.json';
/** The most files of one package. */
export const PIPELINE_PACKAGE_FILES_MAX = 200;
/** The most bytes of one package, all files as bytes on disk. The install
 *  travels as one JSON body, and the route's ceiling is 8 MB
 *  (JSON_BODY_CEILING_BYTES, server/web/lib/body-limit.ts): 5 MB of binary
 *  files is 6.7 MB of base64, with room for the JSON around it. */
export const PIPELINE_PACKAGE_MAX_BYTES = 5 * 1024 * 1024;
/** `core`: a reader that runs in this process. No built-in is one now:
 *  each is a package in the image (`bun`). */
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
  /** A router names the kind of a file and writes no tabs (docs/pipelines.md,
   *  "The router"). It is no reader: it has no database, no options, and no
   *  run of its own. */
  router?: true;
  match: {
    ext: readonly string[];
    magic?: readonly string[];
    /** The kinds a reader claims: it reads a file of its extensions only
     *  when the router of that file type names one of these. Left out: it
     *  takes its files by extension alone. */
    kind?: readonly string[];
    after?: string;
  };
  /** The options a box may set, by name (OPTION_NAME: lower case, a-z 0-9
   *  and '_', starting with a letter). */
  options?: Readonly<Record<string, PipelineOptionSpec>>;
  produces: {
    /** The kinds a router can name. `decider`: named only by the decider's
     *  answer, never by the rules. */
    kinds?: readonly PipelineKind[];
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

/** One kind a router can name. */
export type PipelineKind = { kind: string; decider?: true };

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
  /** This run may ask AI workers. False or left out: a model-free run. A
   *  step then returns no worker call. */
  asks?: boolean;
  /** The kind the router named, for a pipeline that claims kinds. On a
   *  re-read it is the kind stored in the file's database. */
  kind?: string;
};

/** The input of the one write call. */
export type FileTabsWriteInput = {
  tabs: ParsedSheet[]; // whole tabs (../sheet-to-grid.ts)
  description?: string;
  ftsSkipColumns?: readonly string[];
  sourceSha256?: string;
  /** The text for search and the pictures, for every Reader (P3-2). The
   *  core takes the text where it has no text reader for the extension and
   *  the manifest says `produces.text`, and the pictures where it reads no
   *  pictures of the extension and the manifest says `produces.pictures`
   *  (docs/pipelines.md, "Text and pictures from every Reader"). A picture
   *  is a file the step wrote in `job.dir`; the job sends its bytes. */
  text?: string;
  pictures?: readonly { file: string; mime: string; caption?: string }[];
};

/**
 * The job handle a packaged step gets: built by the parser job
 * `pipelineRun` (server/parser/src/pipeline-job.ts). A step that does not
 * need a helper does not touch it.
 */
export type StepJob = {
  /** The job's body: the file's bytes, or for an `after` pipeline the tabs
   *  input (./tabs-body.ts), or for a reader the router handed its facts to
   *  (the core's state says so) those facts as JSON. */
  bytes(): Promise<Buffer>;
  /** The rows of one tab of an `after` pipeline's body, read line by line,
   *  each in the order of the tab's columns. */
  tabRows(tab: string): AsyncIterable<unknown[]>;
  /** The job's folder: the only place a step may write. */
  dir: string;
  /** When the step must be done (ms since the epoch): the job's end less
   *  the reserve for its answer. */
  deadline: number;
  /** The native helpers of the parser (server/parser/src/cad.ts and
   *  pictures.ts), bound to this job's body, folder and end. */
  pdfEye: EyeFn;
  pdfPictures: RenderFn;
  pdfPagePieces(
    png: Buffer,
    widthMm: number,
    name: string,
  ): Promise<{ dpi: number; pieces: unknown[]; notSent: unknown[]; pictures: Buffer[] } | null>;
  /** The CAD tier on the body (`--dwg-render`): its JSON reply. */
  cadRender(opts: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>>;
  dwfRender: DwfRenderFn;
};

/** A package's entry: `pkg/<id>/step.ts` exports `step`. */
export type PipelineStep = (req: PipelineStepRequest, job: StepJob) => Promise<PipelineStepResult>;

export type PipelineStepResult = {
  status: 'ok' | 'not_mine' | 'unsure' | 'failed';
  calls?: readonly PipelineCall[];
  state?: unknown;
  /** From a router: what it read of the file (a PDF's page facts). The core
   *  sends them as the body of the job of the reader that claims the kind,
   *  so the file is read one time (docs/pipelines.md, "The router"). */
  facts?: Record<string, unknown>;
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
