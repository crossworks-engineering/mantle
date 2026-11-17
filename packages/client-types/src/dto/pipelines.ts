/**
 * The pipelines of a brain, as the Settings screen reads them
 * (docs/pipelines.md). GET /api/pipelines answers a `PipelineList`; the MCP
 * tool `pipeline_list` gives the same list. PATCH /api/pipelines/:id takes a
 * `PipelineSetBody` and answers the `PipelineRow`; the MCP tool
 * `pipeline_set` does the same. POST /api/pipelines/:id/reread takes a
 * `PipelineRereadBody` and answers a `PipelineRunAnswer`; the MCP tool
 * `pipeline_reread` does the same.
 *
 * An Admin installs an own pipeline with POST /api/pipelines (a
 * `PipelineInstallBody`; the MCP tool `pipeline_install`), reads its
 * package with GET /api/pipelines/:id/package (`pipeline_get`) and removes
 * it with DELETE /api/pipelines/:id (`pipeline_remove`); each answers a
 * `PipelineInstallAnswer` or the package.
 *
 * A pipeline is a built-in or an own one (`source`). A reader reads a file into its database; an
 * `after` pipeline adds tabs to a database a reader made; a router names the
 * kind of a file, and the reader that claims the kind reads it. An agent
 * asks an AI model about a file, and the core writes its
 * answers into one tab of the file's database. The counts are numbers only:
 * no file name and no id.
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

/** The files a pipeline read at one version, from its stamp. `version` null:
 *  read before versions were recorded (a database with no stamp). */
export type PipelineVersionCount = { version: string | null; files: number };

export type PipelineRow = {
  id: string;
  name: string;
  /** What it reads and what it writes, in one or two plain sentences. */
  description: string;
  version: string;
  source: 'builtin' | 'curated' | 'own';
  /** Why this pipeline does not run on this box, in one plain sentence (an
   *  installed pipeline whose id or extension a built-in took, or whose
   *  manifest no longer passes the check). Null: it runs. Always null for a
   *  built-in. A server before this field sends none: read a missing one as
   *  null (`row.problem ?? null`). */
  problem?: string | null;
  /** The same problem as a short fixed word (PipelineProblemCode), so a
   *  client can offer its act without reading the sentence: `not-on-disk`
   *  gets "Write the files again". Null or missing: no problem, or a
   *  server before this field. */
  problemCode?: PipelineProblemCode | null;
  start: 'upload' | 'demand';
  /** A reader reads files; an `after` pipeline adds tabs to a reader's
   *  database; a router names the kind of a file and writes no tabs. A
   *  router has no options, no workspace list, no run and no re-read. A
   *  later server may add a word: show an unknown one as a plain row.
   *  People read `after` as Transformer. An `agent` asks an AI model about
   *  a file and the core writes its answers into one tab: it runs after a
   *  file's upload and on demand (the run on a file or a folder), and it
   *  has no re-read of the whole box. */
  kind: 'reader' | 'after' | 'router' | 'agent';
  /** The file extensions it reads (a router: the file types it names a
   *  kind for). */
  reads: string[];
  /** A router: the kinds it can name. `decider`: named only by the
   *  decider's answer, for a file the rules left unsure. Empty for a
   *  pipeline. */
  names: { kind: string; decider: boolean }[];
  /** A reader: the kinds it claims, so it reads a file of its types only
   *  when the router names one of them. Empty: it takes its files by
   *  extension alone. */
  claims: string[];
  weight: 'light' | 'heavy';
  /** The tab shapes it promises. */
  shapes: string[];
  /** The AI worker kinds it may ask. */
  workers: string[];
  /** The most asks of each AI worker for one file. Empty for a pipeline
   *  that asks nothing. A server before this field sends none: read a
   *  missing one as empty. */
  asks?: { worker: string; max: number }[];
  /** An agent: the paid asks of all agents of this box in the last 24
   *  hours, and the most the box allows in 24 hours (`dayCap`). At the cap
   *  no agent asks until the count falls. Null for a pipeline that is no
   *  agent; missing from a server before these fields, and on the row a
   *  set or an install gives back. */
  asksToday?: number | null;
  dayCap?: number | null;
  /** The brain tools it may call. */
  tools: string[];
  /** Always 'all' since the server of milestone WO: a pipeline is on in
   *  every workspace but those in `offIn`. Kept for older clients: read
   *  `offIn`. */
  workspaces: 'all' | string[];
  /** The ids of the workspaces the pipeline is switched off in. Empty: on
   *  in every workspace. Always empty for a router, which has no switch. */
  offIn: string[];
  /** For an `after` pipeline: the shape it reads. Null for a reader. */
  after: string | null;
  /** The tabs an `after` pipeline writes; the one tab of an agent. */
  tabs: string[];
  /** Each declared option, its spec, and the value in force on this box. */
  options: { name: string; spec: PipelineOptionSpec; value: unknown }[];
  /** Files with a database of this pipeline; null when not counted (a
   *  router is never counted: it has no database of its own). */
  files: number | null;
  /** Of those, not current: read at an older version, before stamps, or with
   *  other options. POST /api/pipelines/:id/reread reads them again. */
  older: number | null;
  /** `files` by the version in their stamp, highest first; `null` (read
   *  before versions were recorded) last. For an `after` pipeline, the
   *  versions of its entries. From the same look as `files`, with the same
   *  cap (`countsPartial`). Empty when not counted. */
  versions: PipelineVersionCount[];
  /** How many times it wrote its result into a file's database on this box:
   *  a reader's build, an `after` pipeline's patch (an upload, a sketch
   *  read's rebuild, a run on demand, a re-read). A skip, a word with no
   *  rows, a failure and a test count none. A router: how many times it
   *  named the kind of a file in a real read, a document too. Today that
   *  is an upload and `dwg-reindex --pdf`; a run on demand and a re-read
   *  count for PDF drawings too since MV5, when the router runs. A
   *  test and the sketch read count none. Read with the state on every
   *  call, never kept. */
  runs: number | null;
  /** When it last wrote, as an ISO time; null before its first run. */
  lastRunAt: string | null;
};

/** Why an own pipeline does not run, as a fixed word: its files are not on
 *  disk (`not-on-disk`: install it again with the same files), the box runs
 *  curated pipelines only, a built-in has its id now, a reader before it
 *  reads one of its extensions, or its manifest does not pass. A later
 *  server may add a word: show the `problem` sentence for an unknown one. */
export type PipelineProblemCode =
  'not-on-disk' | 'curated-only' | 'builtin-id' | 'ext-taken' | 'manifest';

export type PipelineList = {
  /** The contract version. */
  api: number;
  pipelines: PipelineRow[];
  /** The scan stopped at its cap: the counts are of the first files only. */
  countsPartial: boolean;
};

/**
 * What an Admin changes on one pipeline. A field left out stays as it is.
 * `options` merge into the stored ones. `offIn` replaces the list of the
 * workspaces the pipeline is off in; `[]` switches it on everywhere. A
 * router refuses `offIn`: it is used wherever its readers are.
 */
export type PipelineSetBody = {
  options?: Record<string, unknown>;
  offIn?: string[];
  /** Refused by the server since milestone WO, with a sentence that names
   *  `offIn` (an old allow list sent as it was would do the opposite).
   *  Kept so an older client still compiles. */
  workspaces?: string[];
};

/** Why a run on demand did not take a file: the extension or the tabs do
 *  not match, no database for an `after` pipeline or an agent, `not-attached`: the
 *  pipeline is off in the file's home workspace (the word is older than
 *  the off list, and stays), no checksum, a private file, or the reader of a
 *  PDF drawing: `pdf`, which no server gives since MV5 (the word stays).
 *  `text` (the re-read, from P3-2): a file whose Reader gave its text and
 *  no tabs; a re-read keeps a file's text, so its new text needs a
 *  re-extract. A later server may add a word: count an unknown one as
 *  skipped. */
export type PipelineRunSkip =
  'no-match' | 'no-database' | 'not-attached' | 'no-sha' | 'private' | 'pdf' | 'text';

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

/** The body of POST /api/pipelines/:id/reread: read the older files of one
 *  pipeline again. With no `apply`, the dry run. */
export type PipelineRereadBody = {
  apply?: boolean;
  /** The most older files one call takes: 100 by default, at most 1000. */
  limit?: number;
  /** Go on after this file id: the `next` of the call before. */
  after?: string;
};

/** The answer of a run on demand, the dry run and the run alike. An older
 *  server has no run route (404). The re-read of the older files
 *  (POST /api/pipelines/:id/reread) gives the same answer, with one choice:
 *  its `files` are the older files found in this page. */
export type PipelineRunAnswer = {
  apply: boolean;
  /** The extract queue is busy: nothing was queued. */
  busy: boolean;
  /** The pipelines that can run on these files, with the count each takes.
   *  `refused`: always null since MV5 (the field stays; an older server
   *  gave 'pdf' for the reader of a PDF drawing). `asksMax`: for an agent,
   *  the most paid asks of an AI model a run of these files can make (the
   *  files times the most asks for one file); a file asked before pays
   *  nothing again. Null for a pipeline that asks no model; missing from a
   *  server before this field. */
  choices: {
    pipeline: string;
    name: string;
    files: number;
    refused: string | null;
    asksMax?: number | null;
  }[];
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
  /** A draft package to test in place of the installed one (its id may be
   *  one that is not installed). Nothing is written but its draft folder,
   *  which goes when the test ends. */
  files?: PipelinePackage['files'];
};

/** One file of an own package: text as it is, or binary bytes as base64.
 *  A copy of the contract's type (@mantle/files, pipelines/contract.ts). */
export type PipelinePackageFile = string | { base64: string };

/** An own package: path -> file. `pipeline.json` is its manifest. */
export type PipelinePackage = { files: Record<string, PipelinePackageFile> };

/** What an Admin sends to install an own pipeline: the whole package. */
export type PipelineInstallBody = PipelinePackage;

/** The answer of an install or a remove. `row`: the pipeline as the list
 *  shows it (no counts); null after a remove. `note`: one plain line to
 *  show with it. */
export type PipelineInstallAnswer = {
  row: PipelineRow | null;
  note: string;
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
  /** An agent: what it would ask an AI model about this file, shown and
   *  not asked. For each ask its key, the worker, the field names, and the
   *  picture's size in bytes and its type. Missing for any other pipeline,
   *  and from a server before this field. */
  asks?: {
    key: string;
    worker: string;
    fields: string[];
    bytes: number;
    mime: string;
    /** The ask wants the list part too (docs/pipelines.md, "The list part
     *  of an ask"), and the page of its picture. Missing: no list part, no
     *  page, or a server before them. */
    list?: true;
    page?: number;
  }[];
  /** A Reader that gives a file's text (an own Reader with `produces.text`,
   *  for a format the core has no text reader for): the length of the text
   *  its run gave, in characters. Missing for any other pipeline, and from
   *  a server before P3-2. */
  textLength?: number;
  /** A fixed word when there is no result. With `not_mine`, the refusal
   *  file_sql gives the file, when it gives one ('private': the file stays
   *  out of the brain). */
  word:
    | 'no-database'
    | 'no-match'
    | 'too-large'
    | 'unreadable'
    | 'no-rows'
    | 'not-table-type'
    | 'no-sha'
    | 'email-attachment'
    | 'private'
    | null;
};
