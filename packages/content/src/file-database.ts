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
 * The `after` chain (docs/pipelines.md, "After pipelines"): when a reader
 * built a database, each `after` pipeline attached to the file's home
 * workspace whose match rule holds adds its tabs, by a patch of that
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
  AFTER_PIPELINES,
  afterMatches,
  builtinForExt,
  effectiveOptions,
  extOf,
  fileDbPaths,
  isFileSha256,
  isParserError,
  isParserUnavailable,
  optionsHash,
  parserPdfDrawing,
  titleBlockOf,
  pdfDrawingSheets,
  pipelineStampOf,
  PIPELINE_STAMP_KEYS,
  readerFor,
  removeFileDbNames,
  removeFileDbNone,
  removeOtherFileDbNames,
  resolveEffectiveIndexing,
  routerForExt,
  SHAPES,
  stampOfMeta,
  withAfterEntry,
  writeFileDbNone,
  type AfterId,
  type AfterPipeline,
  type CadExt,
  type FileDbNoneWord,
  type PdfDrawing,
  type PdfKindDecision,
  type PipelineManifest,
  type PipelineStamp,
  type ReaderPipeline,
  type ShapeId,
  type ShapeTab,
} from '@mantle/files';
import { DelimitedReadError, type ParsedSheet } from '@mantle/files/sheet-to-grid';
import { mspdiRootPresent, sniffMspdi } from '@mantle/files/mspdi-sniff';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { describeWorkbook, importMaxRows, readDocMeta, scanTabColumns } from '@mantle/tabledb';
import { countPipelineRun, pipelineStateOf, type PipelineState } from './pipeline-state';
import {
  afterBodyOf,
  PipelineRunError,
  runPackaged,
  type PipelineRunResult,
} from './pipeline-runner';
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

/**
 * A PDF as a drawing (packages/files/src/pdf-drawing.ts, read in the parser
 * with no model). `decide` is asked only for a file the rules left unsure,
 * and only by a caller that has one: the extract passes the decider, the
 * rebuild passes nothing, so a rebuild starts no model call.
 *
 * The one read is the PDF router's and the reader's (docs/pipelines.md, "The
 * router"): the router names the kind (the rules, then for an unsure file
 * the decider), and the reader that claims it (readerFor) gets the rows of
 * the same read. A kind no reader claims (a document) gets no database. A
 * document by the rules gets no name (the next extract of the same bytes
 * reads it again, which costs no model). A file the decider calls a document
 * gets the word `no-rows`: no database, and a name, so it is not asked about
 * again. Every other kind gets its database, which is also the record of the
 * kind.
 *
 * `routed`: called once when the router named the kind, a document too, so
 * a real read counts the router's run. Left out (a test): no count.
 */
export async function parsePdfDrawing(
  bytes: Buffer,
  decide?: (drawing: PdfDrawing) => Promise<PdfKindDecision | null>,
  options: Readonly<Record<string, unknown>> = {},
  routed?: () => Promise<void>,
): Promise<ParsedFile> {
  const drawing = await parserPdfDrawing(bytes, titleBlockOf(options));
  if (!readerFor('pdf', drawing.kind)) {
    await routed?.();
    return { kind: 'not-drawing' };
  }
  const decision = drawing.kind === 'unsure' && decide ? await decide(drawing) : null;
  const { kind, sheets, description } = pdfDrawingSheets(drawing, decision);
  await routed?.();
  if (!readerFor('pdf', kind)) return { kind: 'none', word: 'no-rows' };
  return { kind: 'sheets', sheets, description };
}

/** The built-ins that still run in this process (`runtime: 'core'`). When the
 *  last reader has moved to a package, ADAPTERS is gone. */
type CoreReaderId = Extract<ReaderPipeline, { runtime: 'core' }>['id'];

type Adapter = (
  bytes: Buffer,
  ext: string,
  pdfKind: Parameters<typeof parsePdfDrawing>[1] | undefined,
  /** The reader's options in force (effectiveOptions). */
  options: Readonly<Record<string, unknown>>,
  /** Counts the run of the file type's router, in a real read (readSheets). */
  routed: (() => Promise<void>) | undefined,
) => Promise<ParsedFile>;

/** The built-in pipelines' readers, by id (`BUILTIN_PIPELINES`, @mantle/files):
 *  each runs in this process, as before there was a registry. Keyed by
 *  ReaderId, so a reader with no adapter does not compile. */
const ADAPTERS: Record<CoreReaderId, Adapter> = {
  'drawing-pdf': (bytes, _ext, pdfKind, options, routed) =>
    parsePdfDrawing(bytes, pdfKind, options, routed),
  'drawing-cad': async (bytes, ext) => {
    // CAD drawings (DWG, DXF, DGN): the registry workbook (Layers / Texts / Blocks / Counts,
    // and the bones: Segments / Nodes / Inserts / Circuits) from
    // @mantle/files/{dwg,dxf}, read by the parser's CAD tier, so this pass
    // shares the one memoised exchange with the text digest and the image pass.
    // The description says what each tab holds and what it does not.
    // builtinForExt gives this adapter the CAD list only.
    const { CAD_FTS_SKIP_COLUMNS, cadRegistryWorkbook, dwgSourceSha } =
      await import('@mantle/files/dwg');
    const built = await cadRegistryWorkbook(bytes, ext as CadExt);
    return {
      kind: 'sheets',
      sheets: built.grids.sheets,
      sourceSha256: dwgSourceSha(bytes),
      ftsSkipColumns: CAD_FTS_SKIP_COLUMNS,
      ...(built.description ? { description: built.description } : {}),
    };
  },
};

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
 * The pipeline is a package (docs/pipelines.md, "After pipelines"): one
 * parser job a run, whose body is the needed tabs of the shape it reads
 * (afterBodyOf). A needed tab that is missing or has no row is no work:
 * no job, and no sheets, as before the move (the old read gave an empty
 * tab, which no writer keeps: tabsOfSheets drops a tab with no rows).
 */
export async function afterSheetsOf(
  id: AfterId,
  abs: string,
  options: Readonly<Record<string, unknown>>,
): Promise<AfterResult> {
  const pipeline = AFTER_PIPELINES.find((p) => p.id === id)!;
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
    throw new PipelineRunError(`${id} ended with the status ${run.status}`);
  }
  return { sheets: run.write?.tabs ?? [], warnings: [...run.warnings, ...body.warnings] };
}

/** A real read: the router's run is counted for this box and file. */
type RouterCount = { ownerId: string; fileId: string };

/** The one read of a file's database: the built-in for its extension. A
 *  file type with a router (a PDF) names its kind in the same read, and the
 *  reader that claims it keeps the rows (parsePdfDrawing). A packaged one
 *  (`runtime: 'bun'`) runs in the parser (packagedSheets); a `core` one by
 *  its adapter. */
async function readSheets(
  bytes: Buffer,
  ext: string,
  pdfKind: Parameters<typeof parsePdfDrawing>[1] | undefined,
  stored: unknown,
  count: RouterCount | undefined,
): Promise<ParsedFile> {
  const pipeline = builtinForExt(ext);
  if (!pipeline) throw new Error(`no database reader for .${ext}`);
  const options = effectiveOptions(pipeline, stored);
  const router = routerForExt(ext);
  const routed =
    router && count ? () => countRun(count.ownerId, router.id, count.fileId) : undefined;
  const parsed = isPackaged(pipeline)
    ? await packagedSheets(pipeline, bytes, ext, options)
    : await ADAPTERS[pipeline.id](bytes, ext, pdfKind, options, routed);
  const hash = optionsHash(pipeline, options);
  return parsed.kind === 'sheets' && hash ? { ...parsed, optionsHash: hash } : parsed;
}

/** Whether a pipeline is a package in the image (runtime `bun`). */
function isPackaged<P extends PipelineManifest>(p: P): p is Extract<P, { runtime: 'bun' }> {
  return p.runtime === 'bun';
}

/**
 * A packaged reader's run in the parser, as a ParsedFile (parsedFileOfRun).
 * The run is model-free here, as every read of this file is today but the
 * decider's (MV5 gives it its ask). A typed parser failure throws, and
 * parseFileSheets gives its word.
 */
async function packagedSheets(
  pipeline: PipelineManifest,
  bytes: Buffer,
  ext: string,
  options: Readonly<Record<string, unknown>>,
): Promise<ParsedFile> {
  const run = await runPackaged(
    pipeline,
    bytes,
    {
      name: `file.${ext}`,
      ext,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    { options },
  );
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
 * A CSV past its cap earns its word here, with no read and no parser job,
 * for every caller: the cap stays in the core though the read is the package
 * `sheet`'s. So no Table is made of it either. An XML that is no plan earns
 * its answer here too, with no job, for every caller.
 */
export async function parseFileSheets(
  bytes: Buffer,
  ext: string,
  opts: {
    /** The decider, for a PDF the rules left unsure (see parsePdfDrawing).
     *  Left out: no model call. */
    pdfKind?: Parameters<typeof parsePdfDrawing>[1];
    /** The reader's options (pipelineStateOf). Left out: the defaults. */
    options?: Readonly<Record<string, unknown>>;
    /** A real read (an upload, a run on demand, a re-read): the run of the
     *  file type's router is counted when it names the kind. Left out (a
     *  test): no count. */
    count?: RouterCount;
  } = {},
): Promise<ParsedFile> {
  if (ext === 'csv' && bytes.length > envNum('MANTLE_FILE_DB_CSV_MAX_MB') * 1024 * 1024) {
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
  try {
    return await readSheets(bytes, ext, opts.pdfKind, opts.options, opts.count);
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
   *  that is not a plan. `not-drawing`: a PDF that is a document. `stale`: the bytes are not the row's, or the row is
   *  gone: a replace brings its own extract. `private`: it stays out. `moved`:
   *  written, then the row moved on, and the name went with it. */
  | {
      status: 'skipped';
      reason: 'no-sha' | 'not-plan' | 'not-drawing' | 'stale' | 'private' | 'moved';
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

/** The rows, or the word for why there are none. The database carries the
 *  stamp of the pipeline that read it; a word has none (its format is one
 *  word, packages/files/src/file-dbs.ts). */
async function writeRowsOrWord(
  file: {
    fileId: string;
    ownerId: string;
    sha256: string;
    sqlite: string;
    pipeline: PipelineManifest | null;
  },
  parsed: Exclude<ParsedFile, { kind: 'not-plan' | 'not-drawing' }>,
): Promise<FileDbBuild> {
  // `parsed`: the word comes from the rows of a read that worked, so it
  // replaces a database of these bytes; a failure's word leaves one.
  const word = async (w: FileDbNoneWord, parsed = false): Promise<FileDbBuild> => {
    await writeFileDbNone(file.fileId, file.sha256, w, { parsed });
    return { status: 'none', word: w };
  };
  if (parsed.kind === 'none') return word(parsed.word);
  // The cap before the conversion: past it the word costs no copy of the rows.
  const rows = parsed.sheets.reduce((n, s) => n + (s.columns.length > 0 ? s.rows.length : 0), 0);
  if (rows > importMaxRows()) return word('too-large', true);
  const tabs = tabsOfSheets(parsed.sheets);
  if (tabs.length === 0) return word('no-rows', true);
  writeFileDatabaseDoc(file.sqlite, ensureWorkbookDoc({ tabs }), {
    fileId: file.fileId,
    ownerId: file.ownerId,
    ...(parsed.description ? { description: parsed.description } : {}),
    ...(parsed.ftsSkipColumns ? { ftsSkipColumns: parsed.ftsSkipColumns } : {}),
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
 * gives undefined, as does an extension no built-in reads.
 */
export async function readerOptionsOf(
  ownerId: string,
  ext: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const reader = builtinForExt(ext);
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
}): Promise<FileDbBuild> {
  const { fileId, ownerId, sha256, bytes } = args;
  const names = fileDbPaths(fileId, sha256);
  if (!names || !isFileSha256(sha256)) return { status: 'skipped', reason: 'no-sha' };
  const ext = extOf(args.filename);
  const reader = builtinForExt(ext);
  // A read here takes the box's options of the reader.
  const options = args.parsed ? undefined : await readerOptionsOf(ownerId, ext);
  const parsed =
    args.parsed ??
    (await parseFileSheets(bytes, ext, {
      ...(options ? { options } : {}),
      count: { ownerId, fileId },
    }));
  if (parsed.kind === 'not-plan' || parsed.kind === 'not-drawing') {
    return { status: 'skipped', reason: parsed.kind };
  }

  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    return { status: 'skipped', reason: 'stale' };
  }
  return writeUnderRow(fileId, ownerId, sha256, async (row) => {
    const built = await writeRowsOrWord(
      { fileId, ownerId, sha256, sqlite: names.sqlite, pipeline: reader },
      parsed,
    );
    if (built.status === 'built') {
      await runAfterPipelines({ fileId, ownerId, sqlite: names.sqlite, ext, home: row.home });
    }
    return built;
  });
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
  pipeline: AfterPipeline,
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
  const { sheets, warnings } = await afterSheetsOf(pipeline.id, file.sqlite, state.options);
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
 * hold (writeUnderRow). It takes the options in force, and ignores the
 * attach list: the caller picked the file.
 */
export async function patchFileDatabase(args: {
  fileId: string;
  ownerId: string;
  sha256: unknown;
  pipeline: PipelineManifest;
}): Promise<FilePatch> {
  const { fileId, ownerId, sha256 } = args;
  const pipeline = AFTER_PIPELINES.find((p) => p.id === args.pipeline.id);
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

/**
 * The `after` chain of a build, in the order of BUILTIN_PIPELINES. Two
 * checks for each pipeline: the file's home workspace is in its attach
 * list, and its match rule holds (the extension, then the real tabs). The
 * extension is looked at first, so a file no `after` pipeline reads asks
 * for no state. An error is logged and never fails the build: the
 * reader's database stands, and the stamp has no entry for that pipeline.
 * When the parser was busy or down, one run on demand is queued for it.
 */
async function runAfterPipelines(file: {
  fileId: string;
  ownerId: string;
  sqlite: string;
  ext: string;
  home: string | null;
}): Promise<void> {
  for (const pipeline of AFTER_PIPELINES) {
    if (!pipeline.match.ext.includes(file.ext)) continue;
    try {
      const state = await pipelineStateOf(file.ownerId, pipeline);
      const attached =
        state.workspaces === 'all' || (file.home !== null && state.workspaces.includes(file.home));
      if (!attached) continue;
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
