/**
 * A file's read-only database: one SQLite per table-type file, built from its
 * bytes, kept under its id and sha256 in the files root (the names are
 * @mantle/files file-dbs.ts). Nobody edits its rows: new bytes give new names.
 *
 * Ungated on purpose. The extract decides when a file wants one
 * (server/api/src/agent/extract/auto-table.ts) and a rebuild decides by its own
 * list; both come here, so a rebuilt database is the one a fresh upload gets.
 * No model runs here, and a parse is the parser's (a CSV's too, since `sheet`
 * runs as a package).
 *
 * There is no 20-tab cap: that cap exists because a Table is a node that fans
 * out into extractor runs (auto-table.ts), and a database is not. The row cap
 * stays, as a Table enforces it in createTable and writeDocFile does not.
 *
 * The `after` chain (docs/pipelines.md, "Transformers"): when a reader
 * built a database, each `after` pipeline that is not off in the file's
 * home workspace and whose match rule holds adds its tabs, by a patch of that
 * database (patchFileDatabase, the one writer of an `after` pipeline). It
 * reads the database, never the file again, asks no model, and an error
 * in it never fails the build: the reader's database stands.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { ensureWorkbookDoc, tableDocFromGrid } from '@mantle/content-core/table-model';
import { envNum } from '@mantle/config';
import { db, itemHomeSql, nodes, notifyPipelineRun } from '@mantle/db';
import {
  afterEntryIn,
  afterMatches,
  effectiveOptions,
  extOf,
  fileDbPaths,
  isFileSha256,
  isParserError,
  isParserUnavailable,
  optionsHash,
  pdfFileTabOf,
  pdfReadPoorer,
  pipelineStampOf,
  PIPELINE_STAMP_KEYS,
  removeFileDbNames,
  removeFileDbNone,
  removeOtherFileDbNames,
  resolveEffectiveIndexing,
  AFTER_CELL_MAX_CHARS,
  SHAPES,
  stampOfMeta,
  withAfterEntry,
  withoutAfterEntry,
  writeFileDbNone,
  type FileDbNoneWord,
  type PipelineManifest,
  type PipelineStamp,
  type ShapeId,
  type ShapeTab,
} from '@mantle/files';
import {
  DelimitedReadError,
  readsAsDelimited,
  type ParsedSheet,
} from '@mantle/files/sheet-to-grid';
import { mspdiRootPresent, sniffMspdi } from '@mantle/files/mspdi-sniff';
import { sniffCad } from '@mantle/files/cad-sniff';
import { isCadExt } from '@mantle/files/slug';
import { ConflictError, errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { describeWorkbook, importMaxRows, readDocMeta, scanTabColumns } from '@mantle/tabledb';
import {
  countPipelineRun,
  pipelineOffHere,
  pipelineStateOf,
  type PipelineState,
} from './pipeline-state';
import {
  pdfReadAgainOf,
  readerStateOf,
  routePdf,
  type FileStamp,
  type PdfDecide,
  type StoredPdf,
} from './pdf-read';
import { AGENT_HASH_COLUMN, agentRows, checkAsks, type AgentAskFn } from './pipeline-agent';
import {
  afterBodyOf,
  agentStep,
  PipelineRunError,
  readerGivesText,
  readerRun,
  runPackaged,
  stepFileOf,
  type PipelineRunResult,
} from './pipeline-runner';
import { boxPipelines, type BoxPipeline, type BoxPipelines } from './pipeline-registry';
import { patchFileDatabaseDoc, writeFileDatabaseDoc } from './table-broker';

/** What a file's bytes gave: sheets, a word for why there are none, or an XML
 *  that is not a plan at all, which gets no name. */
export type ParsedFile =
  | {
      kind: 'sheets';
      sheets: ParsedSheet[];
      /** Caveat the reader needs before querying: set only where the grid is
       *  genuinely misleading read the obvious way. */
      description?: string;
      /** A drawing's table names the bytes it was built from (its revision). */
      sourceSha256?: string;
      /** Columns the search index leaves out (a drawing's SVG). */
      ftsSkipColumns?: readonly string[];
      /** The hash of the reader's options the sheets were read with, when
       *  they are not all the defaults (optionsHash). */
      optionsHash?: string;
      /** The length of the text the Reader's run gave, when that text is
       *  the file's (readerGivesText) and not empty: with no tabs, its stamp
       *  goes in the file's word (writeRowsOrWord). */
      readerText?: number;
    }
  | { kind: 'none'; word: FileDbNoneWord }
  | { kind: 'not-plan' }
  /** A PDF that is a document, not a drawing: it gets no name, as an XML
   *  that is not a plan. */
  | { kind: 'not-drawing' };

/**
 * The word a failed read earns, or null for an error that says nothing about
 * the document, which must be retried and writes no name: a retryable parser
 * failure, a bad_request (a mismatch during a roll, not a verdict), a throw from
 * the failure ledger on a database blip.
 */
export function noneWordOf(err: unknown): FileDbNoneWord | null {
  // DelimitedReadError: the Table import route reads a CSV in its own
  // process (parseSpreadsheetToGrid) and asks this for its word.
  if (err instanceof DelimitedReadError || err instanceof PipelineRunError) return 'unreadable';
  if (!isParserError(err) || err.retryable || err.code === 'bad_request') return null;
  return err.code === 'too_large' ? 'too-large' : 'unreadable';
}

const logger = log('file-database');

/** What an `after` pipeline gives: its sheets, by tab name, and warnings. */
type AfterResult = { sheets: ParsedSheet[]; warnings: string[] };

/**
 * Run an `after` pipeline on the database at `abs`, read only: its sheets
 * and warnings, and nothing written. The one place that runs it, for every
 * caller: the patch (patchDatabaseAt: the upload's chain, the run on demand
 * and pipeline-reread), the test of a pipeline (pipeline_test) and
 * pipeline-compare. Each caller checks the match rule first.
 *
 * The pipeline is a package (docs/pipelines.md, "Transformers"): one
 * parser job a run, whose body is the needed tabs of the shape it reads
 * (afterBodyOf). A needed tab that is missing or has no row is no work:
 * no job, and no sheets, as before the move (the old read gave an empty
 * tab, which no writer keeps: tabsOfSheets drops a tab with no rows).
 */
export async function afterSheetsOf(
  pipeline: PipelineManifest,
  abs: string,
  options: Readonly<Record<string, unknown>>,
): Promise<AfterResult> {
  const shape = SHAPES[pipeline.match.after as ShapeId];
  const hasRow = (tab: ShapeTab) => {
    let any = false;
    scanTabColumns(abs, tab.name, tab.columns, { maxRows: 1, cellMaxChars: 1 }, () => {
      any = true;
      return false;
    });
    return any;
  };
  if (!shape.tabs.filter((t) => t.needed).every(hasRow)) return { sheets: [], warnings: [] };
  const body = afterBodyOf(abs, pipeline);
  const run = await runPackaged(pipeline, body.body, undefined, { options });
  if (run.status !== 'ok') {
    throw new PipelineRunError(`${pipeline.id} ended with the status ${run.status}`);
  }
  return { sheets: run.write?.tabs ?? [], warnings: [...run.warnings, ...body.warnings] };
}

/** A real read: the router's run is counted for this box and file. */
type RouterCount = { ownerId: string; fileId: string };

/** The facts of a PDF's stored File tab a read again keeps: its kind and
 *  the decider's answer. */
type PdfStored = Pick<StoredPdf, 'kind' | 'decision'>;

/** The one read of a file's database: the box's reader for its extension
 *  (the registry). A file type with a router (a PDF) has its kind named
 *  first (readRouted). Every built-in reader is a package (`runtime:
 *  'bun'`) since MV5 and MV6: it runs in the parser (packagedSheets). */
async function readSheets(bytes: Buffer, ext: string, opts: ParseOpts): Promise<ParsedFile> {
  const pipeline = opts.pipelines.readerFor(ext);
  if (!pipeline) throw new Error(`no database reader for .${ext}`);
  const options = effectiveOptions(pipeline, opts.options);
  const router = opts.pipelines.routerFor(ext);
  const parsed = router
    ? await readRouted(router, bytes, ext, options, opts)
    : await packagedSheets(pipeline, bytes, ext, options);
  const hash = optionsHash(pipeline, options);
  return parsed.kind === 'sheets' && hash ? { ...parsed, optionsHash: hash } : parsed;
}

/**
 * A file of a type with a router (a PDF; docs/pipelines.md, "The router"):
 * the router's job names the kind (the rules, then for an unsure file the
 * decider, when the caller gives one), and the job of the reader that
 * claims it makes the rows, with the kind and the decision in its first
 * state. The router's job reads the page facts once, with the read's
 * options, and gives them back: the reader's job takes them as its body
 * and does not read the file again. A read again of a file with a
 * database (`pdfStored`) keeps the stored kind and decision: the router
 * does not run, so it is one job (the reader reads the file) and asks no
 * model.
 *
 * A kind no reader claims (a document) gets no database and no name (the
 * next extract of the same bytes reads it again, which costs no model).
 * Only the rules name a document: the decider's `document` is never used
 * (decidedKind), so an unsure file keeps its database.
 *
 * `count`: a real read counts the router's run when it named the kind, a
 * document too. Left out (a test): no count. A read again counts none: the
 * router did not run.
 */
async function readRouted(
  router: PipelineManifest,
  bytes: Buffer,
  ext: string,
  options: Readonly<Record<string, unknown>>,
  opts: Pick<ParseOpts, 'pdfKind' | 'pdfStored' | 'count' | 'pipelines'>,
): Promise<ParsedFile> {
  const named: PdfStored & { facts?: Record<string, unknown> } =
    opts.pdfStored ?? (await routePdf(router, bytes, options, opts.pdfKind));
  if (!opts.pdfStored && opts.count) {
    await countRun(opts.count.ownerId, router.id, opts.count.fileId);
  }
  const { kind, decision } = named;
  const reader = opts.pipelines.readerFor(ext, kind);
  if (!reader) return { kind: 'not-drawing' };
  // The router's page facts go to a reader that claims the kind (a
  // built-in: an own Reader claims none), as the body of its job: the file
  // is read one time. A reader by extension alone gets the file.
  const body =
    reader.match.kind?.includes(kind) && named.facts
      ? Buffer.from(JSON.stringify(named.facts), 'utf8')
      : undefined;
  // Only the body goes on: the parsed facts (from up to 32 MB of JSON) are
  // held by nothing while the Reader runs, as this returns its job and does
  // not await it.
  return packagedSheets(reader, bytes, ext, options, {
    kind,
    state: readerStateOf(decision, body !== undefined),
    ...(body ? { body } : {}),
  });
}

/**
 * A packaged reader's run in the parser, as a ParsedFile (parsedFileOfRun).
 * The run is model-free here: a reader's database read asks no model (the
 * decider is the router's, the sketch read starts elsewhere). `named`: the
 * kind the router named and the core's state of step 1 (readRouted). A
 * typed parser failure throws, and parseFileSheets gives its word.
 */
async function packagedSheets(
  pipeline: BoxPipeline,
  bytes: Buffer,
  ext: string,
  options: Readonly<Record<string, unknown>>,
  named: { kind: string; state: unknown; body?: Buffer } | null = null,
): Promise<ParsedFile> {
  // A Reader whose one run serves the three passes (the database, the text,
  // the pictures): the CAD reader, an own Reader, and a built-in that says
  // `produces.text` or `produces.pictures` (drawing-raster). Its run is kept for
  // the extract (readerRun), so the text and picture passes take the same
  // one (docs/pipelines.md, "Text and pictures from every Reader").
  const passes = pipeline.produces.text === true || pipeline.produces.pictures === true;
  if (!named && (pipeline.id === 'drawing-cad' || pipeline.source === 'own' || passes)) {
    const run = await readerRun(pipeline, bytes, ext, options);
    const parsed = parsedFileOfRun(pipeline, run);
    return parsed.kind === 'sheets' && run.write?.text && readerGivesText(pipeline, ext)
      ? { ...parsed, readerText: run.write.text.length }
      : parsed;
  }
  const run = await runPackaged(pipeline, named?.body ?? bytes, stepFileOf(bytes, ext), {
    options,
    ...(named ? { kind: named.kind, state: named.state } : {}),
  });
  return parsedFileOfRun(pipeline, run);
}

/**
 * The ParsedFile of a reader's last result, the one mapping of a package's
 * answer to the write spot: `not_mine` is that reader's answer with no name
 * (a PDF's `not-drawing`, else `not-plan`); `ok` with a write is its
 * sheets; `ok` with no write is no sheets, so the write spot gives
 * `no-rows`; any other status throws PipelineRunError (the word
 * `unreadable`). The golden compare of a
 * move calls it on a step run in its own process (docs/pipelines.md).
 */
export function parsedFileOfRun(
  pipeline: Pick<PipelineManifest, 'match'>,
  run: Pick<PipelineRunResult, 'status' | 'write'>,
): ParsedFile {
  if (run.status === 'not_mine') {
    return pipeline.match.ext.includes('pdf') ? { kind: 'not-drawing' } : { kind: 'not-plan' };
  }
  // A reader ends `ok` or `not_mine`. `unsure` is a router's word (its kind
  // goes to the pipeline that claims it, not to this write spot), and a
  // `failed` step is a failed job before it gets here: any other end is
  // no rows to write over a database, so it is a failure with its word.
  if (run.status !== 'ok') {
    throw new PipelineRunError(`a reader ended with the status ${run.status}`);
  }
  const w = run.write;
  return {
    kind: 'sheets',
    sheets: w?.tabs ?? [],
    ...(w?.description ? { description: w.description } : {}),
    ...(w?.sourceSha256 ? { sourceSha256: w.sourceSha256 } : {}),
    ...(w?.ftsSkipColumns ? { ftsSkipColumns: w.ftsSkipColumns } : {}),
  };
}

/**
 * Parse a file's bytes for its database and its Table, once. A verdict on the
 * document comes back as its word; any other failure throws, and the caller
 * decides (the extract retries).
 *
 * Delimited text past its cap earns its word here, with no read and no
 * parser job, for every caller: a file the package `sheet` reads whose bytes
 * it will read as delimited text (readsAsDelimited, the reader's own test),
 * whatever the file's name, so a CSV named `.xlsx` is held too. A real
 * workbook keeps its own limits. The cap stays in the core though the read
 * is the package's, and no Table is made of such a file either. An XML that
 * is no plan earns its answer here too, with no job, for every caller.
 */
type ParseOpts = {
  /** The pipelines of the box (boxPipelines): the reader and the router of
   *  the file type come from here. */
  pipelines: BoxPipelines;
  /** The decider, for a PDF the rules left unsure (readRouted). Left out:
   *  no model call. */
  pdfKind?: PdfDecide;
  /** A PDF read again: its stored kind and decision (the File tab). The
   *  router does not run and no model is asked. */
  pdfStored?: PdfStored;
  /** The reader's options (pipelineStateOf). Left out: the defaults. */
  options?: Readonly<Record<string, unknown>>;
  /** A real read (an upload, a run on demand, a re-read): the run of the
   *  file type's router is counted when it names the kind. Left out (a
   *  test): no count. */
  count?: RouterCount;
};

export async function parseFileSheets(
  bytes: Buffer,
  ext: string,
  opts: ParseOpts,
): Promise<ParsedFile> {
  if (
    opts.pipelines.readerFor(ext)?.id === 'sheet' &&
    readsAsDelimited(bytes, ext) &&
    bytes.length > envNum('MANTLE_FILE_DB_CSV_MAX_MB') * 1024 * 1024
  ) {
    return { kind: 'none', word: 'too-large' };
  }
  // An XML: the plan check on the bytes in hand, before any job (the old
  // adapter's first lines; docs/pipelines.md, "The built-ins"). Both
  // sniffs read the first 8 KB only. A root that is not Project is no plan
  // and gets no name; a Project root that fails the full sniff gets its
  // word, so a reader is not told "call again" for ever. The step keeps its
  // own `not_mine` for a run that reaches it directly.
  if (ext === 'xml') {
    if (!mspdiRootPresent(bytes)) return { kind: 'not-plan' };
    if (!sniffMspdi(bytes)) return { kind: 'none', word: 'no-rows' };
  }
  // A drawing whose bytes are not the format its extension names (the old
  // adapter's first line): no tabs, with no job, for every caller. The step
  // keeps the same answer for a run that reaches it directly.
  if (isCadExt(ext) && !sniffCad(bytes, ext)) {
    const { cadSniffMiss } = await import('@mantle/files/dwg');
    return parsedFileOfRun({ match: { ext: [ext] } }, { status: 'ok', write: cadSniffMiss(bytes) });
  }
  try {
    return await readSheets(bytes, ext, opts);
  } catch (err) {
    const word = noneWordOf(err);
    if (word) return { kind: 'none', word };
    throw err;
  }
}

/** The file row as it stands now: its bytes, whether it is private, its
 *  home workspace and its file name. */
export async function readFileRowNow(
  fileId: string,
  ownerId: string,
): Promise<{
  sha256: string | null;
  isPrivate: boolean;
  home: string | null;
  filename: string;
} | null> {
  const [row] = await db
    .select({
      path: nodes.path,
      sha256: sql<string | null>`${nodes.data}->>'sha256'`,
      indexing: sql<string | null>`${nodes.data}->>'indexing'`,
      home: itemHomeSql(),
      filename: sql<string>`coalesce(${nodes.data}->>'filename', ${nodes.title}, '')`,
    })
    .from(nodes)
    .where(and(eq(nodes.id, fileId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'file')))
    .limit(1);
  if (!row) return null;
  const { effective } = await resolveEffectiveIndexing(ownerId, {
    path: row.path,
    data: { indexing: row.indexing },
  });
  return {
    sha256: row.sha256,
    isPrivate: effective === 'metadata',
    home: row.home,
    filename: row.filename,
  };
}

type FileRowNow = NonNullable<Awaited<ReturnType<typeof readFileRowNow>>>;
type RowSkip = { status: 'skipped'; reason: 'stale' | 'private' | 'moved' };

/**
 * The row checks of every write to a file's database, in one place: the
 * build of a reader and the patch of an `after` pipeline both go through
 * here. Before: the row still names these bytes and the file is not
 * private. After (a write can be long): a name of older bytes goes, a file
 * that turned private or went loses its names, and a replace during the
 * write keeps its new name.
 */
async function writeUnderRow<T>(
  fileId: string,
  ownerId: string,
  sha256: string,
  write: (row: FileRowNow) => Promise<T>,
): Promise<T | RowSkip> {
  const before = await readFileRowNow(fileId, ownerId);
  if (!before || before.sha256 !== sha256) return { status: 'skipped', reason: 'stale' };
  if (before.isPrivate) return { status: 'skipped', reason: 'private' };

  const out = await write(before);

  const after = await readFileRowNow(fileId, ownerId);
  if (!after || after.isPrivate) {
    await removeFileDbNames(fileId);
    return { status: 'skipped', reason: 'moved' };
  }
  await removeOtherFileDbNames(fileId, after.sha256);
  return after.sha256 === sha256 ? out : { status: 'skipped', reason: 'moved' };
}

export type FileDbBuild =
  | { status: 'built'; tabs: number; rows: number }
  | { status: 'none'; word: FileDbNoneWord }
  /** Nothing written. `no-sha`: the row cannot name one. `not-plan`: an XML
   *  that is not a plan. `not-drawing`: a PDF that is a document (on a read
   *  again also a PDF whose word is the `no-rows` of an older read, the
   *  decider's document). `sketch`: a
   *  PDF whose database holds a sketch read, which a read with no model
   *  would lose. `kept`: a read again of a PDF left its database as it was:
   *  its stored state could not be read, it changed during the read, or the
   *  new read is poorer. `stale`: the bytes are not the row's, or the row is
   *  gone: a replace brings its own extract. `private`: it stays out. `moved`:
   *  written, then the row moved on, and the name went with it. */
  | {
      status: 'skipped';
      reason:
        'no-sha' | 'not-plan' | 'not-drawing' | 'sketch' | 'kept' | 'stale' | 'private' | 'moved';
    };

/** The tabs of parsed sheets, for a database and for a Table: one tab per sheet
 *  with rows, so a file's two forms hold the same grid. */
export function tabsOfSheets(sheets: readonly ParsedSheet[]) {
  return (
    sheets
      .map((sheet, i) => ({
        ...tableDocFromGrid(sheet),
        name: (sheet.name || `Sheet${i + 1}`).slice(0, 100),
      }))
      // Skip grids with no usable tabular data (empty / header-only).
      .filter((t) => t.columns.length > 0 && t.rows.length > 0)
  );
}

/** The rows of a read's sheets, as the import cap counts them. */
function rowsOf(parsed: Extract<ParsedFile, { kind: 'sheets' }>): number {
  return parsed.sheets.reduce((n, s) => n + (s.columns.length > 0 ? s.rows.length : 0), 0);
}

/** The rows, or the word for why there are none. The database carries the
 *  stamp of the pipeline that read it. A word has none, but for a file whose
 *  Reader gave its text and no tabs (`readerText`): its word `no-rows`
 *  carries the stamp as a second line (packages/files/src/file-dbs.ts), and
 *  the run counts, as the Reader's result was taken. */
async function writeRowsOrWord(
  file: {
    fileId: string;
    ownerId: string;
    sha256: string;
    sqlite: string;
    pipeline: PipelineManifest | null;
    /** A conditional write (a read again of a PDF): the database as the one
     *  read saw it (null: none). Another file at the rename refuses it
     *  (ConflictError), and nothing is written. */
    since?: FileStamp | null;
    /** The tabs of the box's Agents: paid rows, kept over this write
     *  (agentTabsAt). Left out: none is kept. */
    agentTabs?: readonly string[];
  },
  parsed: Exclude<ParsedFile, { kind: 'not-plan' | 'not-drawing' }>,
): Promise<FileDbBuild> {
  // `parsed`: the word comes from the rows of a read that worked, so it
  // replaces a database of these bytes; a failure's word leaves one.
  const word = async (
    w: FileDbNoneWord,
    parsed = false,
    stamp?: PipelineStamp,
  ): Promise<FileDbBuild> => {
    await writeFileDbNone(file.fileId, file.sha256, w, { parsed, ...(stamp ? { stamp } : {}) });
    return { status: 'none', word: w };
  };
  if (parsed.kind === 'none') return word(parsed.word);
  // The cap before the conversion: past it the word costs no copy of the rows.
  const rows = rowsOf(parsed);
  if (rows > importMaxRows()) return word('too-large', true);
  const tabs = tabsOfSheets(parsed.sheets);
  if (tabs.length === 0) {
    if (!parsed.readerText || !file.pipeline) return word('no-rows', true);
    const built = await word(
      'no-rows',
      true,
      pipelineStampOf(file.pipeline, [], parsed.optionsHash ?? ''),
    );
    await countRun(file.ownerId, file.pipeline.id, file.fileId);
    return built;
  }
  // The paid rows of the Agents, read before the write puts a new database
  // in this place. They go into that ONE write, after the Reader's tabs, with
  // no stamp entry: the file shows as not done for the Agent, and its next
  // run takes these rows by their hash and pays nothing. The stamp and the
  // counts below are of the Reader's tabs only.
  const paid = tabsOfSheets(
    agentTabsAt(file.sqlite, file.agentTabs ?? [], new Set(tabs.map((t) => t.name))),
  );
  const ftsSkipColumns = [
    ...(parsed.ftsSkipColumns ?? []),
    // A hash is no word to search for.
    ...(paid.length > 0 ? [AGENT_HASH_COLUMN] : []),
  ];
  writeFileDatabaseDoc(file.sqlite, ensureWorkbookDoc({ tabs: [...tabs, ...paid] }), {
    fileId: file.fileId,
    ownerId: file.ownerId,
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(ftsSkipColumns.length > 0 ? { ftsSkipColumns } : {}),
    ...(file.since !== undefined ? { since: file.since } : {}),
    ...(file.pipeline
      ? {
          stamp: pipelineStampOf(
            file.pipeline,
            tabs.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name) })),
            parsed.optionsHash ?? '',
          ),
        }
      : {}),
  });
  // An older word for these bytes (a rebuild healing it) stops answering.
  await removeFileDbNone(file.fileId, file.sha256);
  if (file.pipeline) await countRun(file.ownerId, file.pipeline.id, file.fileId);
  return { status: 'built', tabs: tabs.length, rows };
}

/** The most rows of an Agent's tab that are read back: an Agent writes one
 *  row for each ask, and a step has 64 calls at most. */
const AGENT_ROWS_MAX = 1_000;

/** One tab of the database at `abs`, whole, every cell as text: an Agent's
 *  rows. Null: no database, no such tab, or it cannot be read. */
function textTabAt(abs: string, name: string): ParsedSheet | null {
  try {
    const tab = describeWorkbook(abs).find((t) => t.name === name);
    if (!tab) return null;
    const columns = tab.columns.map((c) => c.name);
    const rows: (string | null)[][] = [];
    scanTabColumns(
      abs,
      name,
      columns,
      { maxRows: AGENT_ROWS_MAX, cellMaxChars: AFTER_CELL_MAX_CHARS },
      (row) => {
        rows.push(
          columns.map((c) => (row[c] === null || row[c] === undefined ? null : String(row[c]))),
        );
        return true;
      },
    );
    return { name, columns: columns.map((c) => ({ name: c, type: 'text' })), rows };
  } catch {
    return null;
  }
}

/**
 * The Agents' tabs that are in the database at `abs` now, to keep over a
 * Reader's new write (docs/pipelines.md, "Agents"): a paid answer has the
 * life of the file's bytes, not of one Reader version. One check: a tab the
 * new read writes itself (`taken`) is the Reader's, and is not kept.
 */
function agentTabsAt(
  abs: string,
  names: readonly string[],
  taken: ReadonlySet<string>,
): ParsedSheet[] {
  return names
    .filter((n) => !taken.has(n))
    .map((n) => textTabAt(abs, n))
    .filter((t): t is ParsedSheet => t !== null && t.rows.length > 0);
}

/** One run of a pipeline, counted where its result was written (the two
 *  write spots: writeRowsOrWord and patchDatabaseAt), or of a router where
 *  it named the kind (readSheets). A failed count is logged and never fails
 *  or undoes the write or the read. */
async function countRun(ownerId: string, pipelineId: string, fileId: string): Promise<void> {
  try {
    await countPipelineRun(ownerId, pipelineId);
  } catch (err) {
    logger.warn(`the run of ${pipelineId} on ${fileId} was not counted: ${errorMessage(err)}`);
  }
}

/**
 * The box's options in force of the reader of this extension (a PDF's title
 * block), for parseFileSheets. A reader with no options asks for no state and
 * gives undefined, as does an extension no reader of the box reads.
 */
export async function readerOptionsOf(
  ownerId: string,
  ext: string,
  pipelines: BoxPipelines,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const reader = pipelines.readerFor(ext);
  if (!reader || Object.keys(reader.options ?? {}).length === 0) return undefined;
  return (await pipelineStateOf(ownerId, reader)).options;
}

/**
 * Build a file's database, or write its word. `sha256` is the row's as the
 * caller read it, and names the result. `parsed`: the sheets when the caller has
 * them, so an extract parses once for the database and the Table; without it
 * this parses, and an error with no word throws.
 *
 * The check before writing and the tidy after it are here so no caller can
 * forget them: bytes a replace swapped mid-read never land under the old name,
 * a file that turned private gets nothing, and a replace during a long write
 * keeps its own name.
 */
export async function buildFileDatabase(args: {
  fileId: string;
  ownerId: string;
  sha256: unknown;
  bytes: Buffer;
  filename: string;
  parsed?: ParsedFile;
  /** The pipelines of the box, when the caller holds them already (one
   *  read of the registry for one file). Left out: read here. */
  pipelines?: BoxPipelines;
  /** The build of an upload (the extract's file database pass): it queues
   *  the run of each Agent of the file type (queueAgentRuns). Every other
   *  build (a run on demand, a read again, a maintenance task) queues
   *  none: the Agents' tabs are kept over its write, and it starts no
   *  model work. */
  upload?: true;
}): Promise<FileDbBuild> {
  const { fileId, ownerId, sha256, bytes } = args;
  const names = fileDbPaths(fileId, sha256);
  if (!names || !isFileSha256(sha256)) return { status: 'skipped', reason: 'no-sha' };
  const ext = extOf(args.filename);
  const pipelines = args.pipelines ?? (await boxPipelines(ownerId));
  const reader = pipelines.readerFor(ext);
  // A read here, with no `parsed`, is a read again with no model (a run on
  // demand, a re-read). `dwg-reindex --pdf` passes `parsed`, so it is not
  // here: it makes its own check before its parse, as before. For a file
  // type with a router (a PDF) it
  // is ONE read, the job, and ONE conditional write (docs/pipelines.md, "The
  // PDF set"): it works from the stored state of these bytes, read once and
  // fail closed (pdfReadAgainOf), and writes only when that state did not
  // change and the new read is not poorer.
  let again: { stored: StoredPdf | null; since: FileStamp | null } | undefined;
  if (!args.parsed && pipelines.routerFor(ext)) {
    const state = await pdfReadAgainOf(names);
    if (state.skip) return { status: 'skipped', reason: state.skip };
    again = state;
  }
  const pdfStored: PdfStored | undefined = again?.stored
    ? { kind: again.stored.kind, decision: again.stored.decision }
    : undefined;
  // A read here takes the box's options of the reader.
  const options = args.parsed ? undefined : await readerOptionsOf(ownerId, ext, pipelines);
  const parsed =
    args.parsed ??
    (await parseFileSheets(bytes, ext, {
      pipelines,
      ...(options ? { options } : {}),
      ...(pdfStored ? { pdfStored } : {}),
      count: { ownerId, fileId },
    }));
  if (parsed.kind === 'not-plan' || parsed.kind === 'not-drawing') {
    return { status: 'skipped', reason: parsed.kind };
  }
  // A read again over a stored database writes only better sheets: a read
  // that failed, gave a word or is poorer writes nothing, and no word.
  if (again?.stored && (parsed.kind !== 'sheets' || poorerThan(parsed, again.stored))) {
    return { status: 'skipped', reason: 'kept' };
  }

  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    return { status: 'skipped', reason: 'stale' };
  }
  return writeUnderRow(fileId, ownerId, sha256, async (row) => {
    let built: FileDbBuild;
    try {
      built = await writeRowsOrWord(
        {
          fileId,
          ownerId,
          sha256,
          sqlite: names.sqlite,
          pipeline: reader,
          ...(again ? { since: again.since } : {}),
          agentTabs: pipelines.agents
            .filter((a) => a.match.ext.includes(ext))
            .flatMap((a) => a.produces.tabs ?? []),
        },
        parsed,
      );
    } catch (err) {
      // The database changed since the one read: the write is refused.
      if (again && err instanceof ConflictError) return { status: 'skipped', reason: 'kept' };
      throw err;
    }
    if (built.status === 'built') {
      await runAfterPipelines(
        { fileId, ownerId, sqlite: names.sqlite, ext, home: row.home },
        pipelines.after,
      );
      if (args.upload) {
        await queueAgentRuns({ fileId, ownerId, ext, home: row.home }, pipelines.agents);
      }
    }
    return built;
  });
}

/**
 * The Agents of an upload's build (docs/pipelines.md, "Agents"): for each Agent of
 * the box that reads this file type and is not off in the file's home
 * workspace, ONE run is queued, the job of `pipeline_run`
 * (notifyPipelineRun). So the fields are there after an upload with no
 * command. The run is a job of its own, after this build: one parser job,
 * then the paid asks behind their guards, then the core's write. It has no
 * retry, and it starts no build, so it never queues itself. Only an
 * upload's build queues it: a Reader's run on demand or read again keeps
 * the Agents' tabs and starts no model work. A failure to
 * queue is logged and never fails the build: `pipeline_run` fills the tab
 * later.
 */
async function queueAgentRuns(
  file: { fileId: string; ownerId: string; ext: string; home: string | null },
  agents: readonly PipelineManifest[],
): Promise<void> {
  for (const agent of agents) {
    if (!agent.match.ext.includes(file.ext)) continue;
    try {
      if (pipelineOffHere(await pipelineStateOf(file.ownerId, agent), file.home)) continue;
      await notifyPipelineRun(file.fileId, agent.id);
    } catch (err) {
      logger.warn(`${agent.id} on ${file.fileId}: no run was queued: ${errorMessage(err)}`);
    }
  }
}

/** Whether a PDF's new read is poorer than its stored one (pdfReadPoorer),
 *  by the File tab of the new read. A read with no File tab to tell by is
 *  poorer: the stored one stands. So is a read past the import cap, whose
 *  write would be the word `too-large` (writeRowsOrWord). */
function poorerThan(parsed: Extract<ParsedFile, { kind: 'sheets' }>, stored: StoredPdf): boolean {
  if (rowsOf(parsed) > importMaxRows()) return true;
  const tab = parsed.sheets.find((s) => s.name === 'File');
  const now = tab?.rows[0]
    ? pdfFileTabOf(
        tab.columns.map((c) => c.name),
        tab.rows[0],
      )
    : null;
  return !now || pdfReadPoorer(now, stored);
}

export type FilePatch =
  | { status: 'patched'; tabs: number; rows: number; warnings: string[] }
  /** Nothing written. `no-sha`: the row names no bytes. `no-database`: no
   *  database of these bytes. `no-match`: the extension or the shape does
   *  not match. `not-after`: the pipeline is a reader. The rest as a build. */
  | {
      status: 'skipped';
      reason: 'no-sha' | 'no-database' | 'no-match' | 'not-after' | RowSkip['reason'];
    };

/**
 * The one writer of an `after` pipeline, inside the row checks: the match
 * rule on the real tabs, the adapter on the database, then the patch of
 * only the tabs `produces.tabs` names, and the pipeline's entry in
 * `pipelines_after`. The entries of other pipelines stay.
 */
async function patchDatabaseAt(
  file: { fileId: string; ownerId: string; sqlite: string; ext: string },
  pipeline: PipelineManifest,
  state: Pick<PipelineState, 'options' | 'optionsHash'>,
): Promise<FilePatch> {
  // The file before its first read here: the patch refuses when a read
  // rebuilt the database since, so no tab is made from older rows.
  const since = statSync(file.sqlite);
  const tabs = describeWorkbook(file.sqlite).map((t) => ({
    name: t.name,
    columns: t.columns.map((c) => c.name),
  }));
  if (!afterMatches(pipeline, file.ext, tabs)) return { status: 'skipped', reason: 'no-match' };
  const { sheets, warnings } = await afterSheetsOf(pipeline, file.sqlite, state.options);
  const declared: readonly string[] = pipeline.produces.tabs ?? [];
  const own = new Set(declared);
  const stray = sheets.find((sheet) => !own.has(sheet.name));
  if (stray) throw new Error(`${pipeline.id} gave a tab it does not declare: ${stray.name}`);
  const written = tabsOfSheets(sheets);
  const meta = readDocMeta(file.sqlite, ['pipelines_after']);
  patchFileDatabaseDoc(file.sqlite, {
    since,
    replaceTabs: declared,
    tabs: written,
    setMeta: {
      pipelines_after: withAfterEntry(meta?.pipelines_after, pipeline, state.optionsHash),
    },
  });
  await countRun(file.ownerId, pipeline.id, file.fileId);
  return {
    status: 'patched',
    tabs: written.length,
    rows: written.reduce((n, t) => n + t.rows.length, 0),
    warnings,
  };
}

/**
 * Patch a file's database with one `after` pipeline: the way a run on
 * demand and `pipeline-reread` add its tabs. The row checks of a build
 * hold (writeUnderRow). It takes the options in force, and does not read
 * the off list: the caller (pipeline_run's skipOf, the re-read task)
 * picked the file.
 */
export async function patchFileDatabase(args: {
  fileId: string;
  ownerId: string;
  sha256: unknown;
  pipeline: PipelineManifest;
  /** The pipelines of the box, when the caller holds them already. Left
   *  out: read here. */
  pipelines?: BoxPipelines;
}): Promise<FilePatch> {
  const { fileId, ownerId, sha256 } = args;
  const pipelines = args.pipelines ?? (await boxPipelines(ownerId));
  const pipeline = pipelines.after.find((p) => p.id === args.pipeline.id);
  if (!pipeline) return { status: 'skipped', reason: 'not-after' };
  const names = fileDbPaths(fileId, sha256);
  if (!names || !isFileSha256(sha256)) return { status: 'skipped', reason: 'no-sha' };
  const state = await pipelineStateOf(ownerId, pipeline);
  return writeUnderRow(fileId, ownerId, sha256, async (row): Promise<FilePatch> => {
    if (!readDocMeta(names.sqlite, [])) return { status: 'skipped', reason: 'no-database' };
    return patchDatabaseAt(
      { fileId, ownerId, sqlite: names.sqlite, ext: extOf(row.filename) },
      pipeline,
      state,
    );
  });
}

export type FileAgentRun =
  /** The asks are answered, as far as they were. `made`: paid calls of this
   *  run. `reused`: asks answered from the tab, with no call. `stopped`: why
   *  the calls ended early; the stamp entry is then not set. */
  | {
      status: 'asked';
      rows: number;
      made: number;
      reused: number;
      stopped?: string;
      warnings: string[];
    }
  | {
      status: 'skipped';
      reason: 'no-sha' | 'no-database' | 'no-match' | 'not-agent' | RowSkip['reason'];
    };

/**
 * Run an Agent on one file (docs/pipelines.md, "Agents"): the one way its
 * tab is written. The order is the money rule:
 *
 *  1. One parser job on the file's bytes gives the asks and their pictures
 *     (agentStep). No model is asked yet.
 *  2. The core answers each ask: from the tab when the hash of its input is
 *     there, else with one paid call through `ask` (agentRows).
 *  3. The core writes the rows itself, with one patch. No code of the
 *     pipeline runs after a paid call.
 *
 * The stamp entry in `pipelines_after` is set only when every ask has its
 * answer. A run that stopped writes the rows it paid for and takes the
 * entry out, so the file shows as not done; a run again pays only for what
 * is missing. An ask with no answer keeps the row of its key that is there.
 * The patch takes the database as it is right before the write: an Agent's
 * rows come from the file's bytes, not from a Reader's tabs, so a Reader's
 * new read in between does not make them wrong.
 *
 * It does not read the off list and makes no cost check: `ask` holds every
 * guard of a paid call (server/api/src/agent/extract/pipeline-ask.ts).
 */
export async function runAgentOnFile(args: {
  fileId: string;
  ownerId: string;
  sha256: unknown;
  bytes: Buffer;
  filename: string;
  pipeline: PipelineManifest;
  pipelines?: BoxPipelines;
  ask: AgentAskFn;
}): Promise<FileAgentRun> {
  const { fileId, ownerId, sha256, bytes } = args;
  const pipelines = args.pipelines ?? (await boxPipelines(ownerId));
  const pipeline = pipelines.agents.find((p) => p.id === args.pipeline.id);
  const tab = pipeline?.produces.tabs?.[0];
  if (!pipeline || !tab) return { status: 'skipped', reason: 'not-agent' };
  const ext = extOf(args.filename);
  if (!pipeline.match.ext.includes(ext)) return { status: 'skipped', reason: 'no-match' };
  const names = fileDbPaths(fileId, sha256);
  if (!names || !isFileSha256(sha256)) return { status: 'skipped', reason: 'no-sha' };
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    return { status: 'skipped', reason: 'stale' };
  }
  // The row checks before any work, and again around the write.
  const before = await readFileRowNow(fileId, ownerId);
  if (!before || before.sha256 !== sha256) return { status: 'skipped', reason: 'stale' };
  if (before.isPrivate) return { status: 'skipped', reason: 'private' };
  if (!readDocMeta(names.sqlite, [])) return { status: 'skipped', reason: 'no-database' };

  const state = await pipelineStateOf(ownerId, pipeline);
  const step = await agentStep(pipeline, bytes, stepFileOf(bytes, ext), state.options);
  if (step.status === 'not_mine') return { status: 'skipped', reason: 'no-match' };
  const asks = checkAsks(pipeline, step.asks, step.pictures);
  const stored = textTabAt(names.sqlite, tab);
  const storedRows = (stored?.rows ?? []).map((r) =>
    Object.fromEntries(stored!.columns.map((c, i) => [c.name, r[i] ?? null])),
  );
  const out = await agentRows(tab, asks, storedRows, args.ask);
  const done = {
    status: 'asked' as const,
    rows: out.sheet?.rows.length ?? 0,
    made: out.made,
    reused: out.reused,
    ...(out.stopped !== undefined ? { stopped: out.stopped } : {}),
    warnings: step.warnings,
  };
  return writeUnderRow(fileId, ownerId, sha256, async (): Promise<FileAgentRun> => {
    const meta = readDocMeta(names.sqlite, ['pipelines_after']);
    if (!meta) return { status: 'skipped', reason: 'no-database' };
    const stopped = out.stopped !== undefined;
    // A stop before any paid call: the tab is not written again, so the
    // older rows stay exactly as they are. On a file with no entry nothing
    // is written. On a file with one, one patch of the meta alone takes the
    // entry out.
    if (stopped && out.made === 0) {
      if (afterEntryIn(meta.pipelines_after, pipeline.id)) {
        patchFileDatabaseDoc(names.sqlite, {
          replaceTabs: [],
          tabs: [],
          setMeta: { pipelines_after: withoutAfterEntry(meta.pipelines_after, pipeline.id) },
        });
      }
      return done;
    }
    patchFileDatabaseDoc(names.sqlite, {
      replaceTabs: [tab],
      tabs: out.sheet ? tabsOfSheets([out.sheet]) : [],
      // A hash is no word to search for.
      ftsSkipColumns: [AGENT_HASH_COLUMN],
      // The entry says "every ask has its answer": a stop takes it out.
      setMeta: {
        pipelines_after: stopped
          ? withoutAfterEntry(meta.pipelines_after, pipeline.id)
          : withAfterEntry(meta.pipelines_after, pipeline, state.optionsHash),
      },
    });
    if (!stopped) await countRun(ownerId, pipeline.id, fileId);
    return done;
  });
}

/**
 * The `after` chain of a build, in the order of the box's list (`after`,
 * boxPipelines). Two
 * checks for each pipeline: it is not off in the file's home workspace
 * (pipelineOffHere), and its match rule holds (the extension, then the real tabs). The
 * extension is looked at first, so a file no `after` pipeline reads asks
 * for no state. An error is logged and never fails the build: the
 * reader's database stands, and the stamp has no entry for that pipeline.
 * When the parser was busy or down, one run on demand is queued for it.
 */
async function runAfterPipelines(
  file: {
    fileId: string;
    ownerId: string;
    sqlite: string;
    ext: string;
    home: string | null;
  },
  after: readonly PipelineManifest[],
): Promise<void> {
  for (const pipeline of after) {
    if (!pipeline.match.ext.includes(file.ext)) continue;
    try {
      const state = await pipelineStateOf(file.ownerId, pipeline);
      if (pipelineOffHere(state, file.home)) continue;
      const out = await patchDatabaseAt(file, pipeline, state);
      for (const w of out.status === 'patched' ? out.warnings : []) {
        logger.warn(`${pipeline.id} on ${file.fileId}: ${w}`);
      }
    } catch (err) {
      logger.warn(`${pipeline.id} on ${file.fileId} wrote nothing: ${errorMessage(err)}`);
      // A reason outside the file (the parser busy or down): ONE run on
      // demand of this pipeline on this file, the Run button's job, which
      // waits in the extract queue behind the uploads. That job patches by
      // patchFileDatabase, never through this chain, so it sends no other.
      if (isParserUnavailable(err)) {
        await notifyPipelineRun(file.fileId, pipeline.id).catch((e: unknown) =>
          logger.warn(`${pipeline.id} on ${file.fileId}: no run was queued: ${errorMessage(e)}`),
        );
      }
    }
  }
}

/**
 * The stamp of a file's database at these bytes: which pipeline read it, at
 * which version, with which options, and the `after` pipelines that wrote
 * tabs. Null when there is no database, it is not a database SQLite can
 * read (readDocMeta), or it was built before stamps: every reader of the
 * stamp takes null as "read before stamps". The keys are read by
 * stampOfMeta (@mantle/files), the one reader of the stamp's form.
 */
export async function readFileDbStamp(
  fileId: string,
  sha256: unknown,
): Promise<PipelineStamp | null> {
  const names = fileDbPaths(fileId, sha256);
  if (!names) return null;
  return stampOfMeta(readDocMeta(names.sqlite, PIPELINE_STAMP_KEYS));
}

/** The `pipelines_after` key of a file's database at these bytes, also on a
 *  database built before stamps. Null when there is no database. */
export async function readFileDbAfter(
  fileId: string,
  sha256: unknown,
): Promise<{ pipelines_after?: string } | null> {
  const names = fileDbPaths(fileId, sha256);
  return names ? readDocMeta(names.sqlite, ['pipelines_after']) : null;
}
