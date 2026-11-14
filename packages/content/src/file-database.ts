/**
 * A file's read-only database: one SQLite per table-type file, built from its
 * bytes, kept under its id and sha256 in the files root (the names are
 * @mantle/files file-dbs.ts). Nobody edits its rows: new bytes give new names.
 *
 * Ungated on purpose. The extract decides when a file wants one
 * (server/api/src/agent/extract/auto-table.ts) and a rebuild decides by its own
 * list; both come here, so a rebuilt database is the one a fresh upload gets.
 * No model runs here, and a parse is the parser's or an in-process CSV read.
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
import { db, itemHomeSql, nodes } from '@mantle/db';
import {
  AFTER_PIPELINES,
  afterMatches,
  builtinForExt,
  effectiveOptions,
  extOf,
  fileDbPaths,
  isFileSha256,
  isParserError,
  optionsHash,
  parserGrid,
  parserPdfDrawing,
  pdfDrawingSheets,
  pipelineStampOf,
  PIPELINE_STAMP_KEYS,
  removeFileDbNames,
  removeFileDbNone,
  removeOtherFileDbNames,
  resolveEffectiveIndexing,
  siteProfileOf,
  siteTagsBuilder,
  SITE_TAGS_TEXT_MAX_CHARS,
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
  type ReaderId,
  type TextRow,
} from '@mantle/files';
import {
  DelimitedReadError,
  parseSpreadsheetToGrid,
  type ParsedSheet,
} from '@mantle/files/sheet-to-grid';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { describeWorkbook, importMaxRows, readDocMeta, scanTabColumns } from '@mantle/tabledb';
import { pipelineStateOf, type PipelineState } from './pipeline-state';
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
  if (err instanceof DelimitedReadError) return 'unreadable';
  if (!isParserError(err) || err.retryable || err.code === 'bad_request') return null;
  return err.code === 'too_large' ? 'too-large' : 'unreadable';
}

/**
 * A PDF as a drawing (packages/files/src/pdf-drawing.ts, read in the parser
 * with no model). `decide` is asked only for a file the rules left unsure,
 * and only by a caller that has one: the extract passes the decider, the
 * rebuild passes nothing, so a rebuild starts no model call.
 *
 * A document by the rules gets no name (the next extract of the same bytes
 * reads it again, which costs no model). A file the decider calls a document
 * gets the word `no-rows`: no database, and a name, so it is not asked about
 * again. Every other kind gets its database, which is also the record of the
 * kind.
 */
export async function parsePdfDrawing(
  bytes: Buffer,
  decide?: (drawing: PdfDrawing) => Promise<PdfKindDecision | null>,
): Promise<ParsedFile> {
  const drawing = await parserPdfDrawing(bytes);
  if (drawing.kind === 'document') return { kind: 'not-drawing' };
  const decision = drawing.kind === 'unsure' && decide ? await decide(drawing) : null;
  const { kind, sheets, description } = pdfDrawingSheets(drawing, decision);
  if (kind === 'document') return { kind: 'none', word: 'no-rows' };
  return { kind: 'sheets', sheets, description };
}

type Adapter = (
  bytes: Buffer,
  ext: string,
  pdfKind: Parameters<typeof parsePdfDrawing>[1] | undefined,
  /** The reader's options in force (effectiveOptions). No reader has one yet. */
  options: Readonly<Record<string, unknown>>,
) => Promise<ParsedFile>;

/** The built-in pipelines' readers, by id (`BUILTIN_PIPELINES`, @mantle/files):
 *  each runs in this process, as before there was a registry. Keyed by
 *  ReaderId, so a reader with no adapter does not compile. */
const ADAPTERS: Record<ReaderId, Adapter> = {
  'drawing-pdf': (bytes, _ext, pdfKind) => parsePdfDrawing(bytes, pdfKind),
  'plan-mspdi': async (bytes) => {
    // The root check again, on the bytes in hand: the caller's early check is
    // skipped when the head could not be read. A root that is not Project
    // cannot be a plan, whatever follows.
    const { mspdiRootPresent, sniffMspdi } = await import('@mantle/files/mspdi-sniff');
    if (!mspdiRootPresent(bytes)) return { kind: 'not-plan' };
    // A Project root that fails the full sniff gets its word, so a reader is
    // not told "call again" for ever. The plan itself is read by the parser
    // service.
    if (!sniffMspdi(bytes)) return { kind: 'none', word: 'no-rows' };
    const grid = await parserGrid(bytes, 'xml');
    if (!grid.plan) return { kind: 'sheets', sheets: grid.sheets };
    // Only the ROLL-UP sentence is conditional. Gating the whole description
    // on summaryCount left a flat plan (one with no summary rows) with no
    // description at all, losing the unit guidance, which is true of every
    // plan. Correct-looking and quietly less useful.
    const rollup =
      grid.plan.summaryCount > 0
        ? ` ${grid.plan.summaryCount} of ${grid.plan.taskCount} rows in Tasks are summary` +
          ` (roll-up) rows whose work, duration and cost ALREADY include their child tasks:` +
          ` add WHERE "Summary"=0 to any total, or the same work is counted once per outline` +
          ` level.`
        : '';
    return {
      kind: 'sheets',
      sheets: grid.sheets,
      description:
        `Microsoft Project plan.${rollup}` +
        ` Durations are hours unless the column says days; slack is in days.` +
        ` Rows are in plan order.`,
    };
  },
  'plot-dwf': async (bytes) => {
    // DWF plot sets: the registry workbook (Sheets / Layers / Labels tabs),
    // read by the parser service (packages/files/src/dwf.ts): on circuitization
    // sets the Layers tab IS the circuit registry. The parser gates it on the
    // DWF magic.
    const { sheets } = await parserGrid(bytes, 'dwf');
    return {
      kind: 'sheets',
      sheets,
      ...(sheets.length > 0
        ? {
            description:
              `Autodesk DWF plot-set registry. Layers is the cross-sheet layer/circuit` +
              ` registry; Labels is every annotation string with its occurrence count and` +
              ` sheets. Vector geometry is not in this table: read the Source DWG named` +
              ` per row in Sheets for measurements.`,
          }
        : {}),
    };
  },
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
  sheet: async (bytes, ext) => ({
    kind: 'sheets',
    sheets: await parseSpreadsheetToGrid(bytes, ext),
  }),
};

const logger = log('file-database');

/** The most rows of `Texts` an `after` pipeline reads. */
export const AFTER_TEXT_ROWS_MAX = 500_000;

/** What an `after` pipeline gives: its sheets, by tab name, and warnings. */
type AfterResult = { sheets: ParsedSheet[]; warnings: string[] };
/** An `after` pipeline's code: it reads the database at `abs`, read only,
 *  and gives its tabs. It never reads the file. */
type AfterAdapter = (abs: string, options: Readonly<Record<string, unknown>>) => AfterResult;

/** The `after` built-ins' code, by id. Keyed by AfterId, so an `after`
 *  pipeline with no adapter does not compile. */
const AFTER_ADAPTERS: Record<AfterId, AfterAdapter> = {
  'site-tags': (abs, options) => {
    const tags = siteTagsBuilder(siteProfileOf(options));
    let rows = 0;
    // One page of Texts at a time; a cell is cut in SQL.
    scanTabColumns(
      abs,
      'Texts',
      ['Text', 'Page', 'Layer', 'X', 'Y'],
      { maxRows: AFTER_TEXT_ROWS_MAX, cellMaxChars: SITE_TAGS_TEXT_MAX_CHARS },
      (row) => {
        rows += 1;
        return tags.add(row as TextRow);
      },
    );
    const { sheet, warnings } = tags.done();
    if (rows >= AFTER_TEXT_ROWS_MAX) {
      warnings.push(`Only the first ${AFTER_TEXT_ROWS_MAX.toLocaleString('en')} texts were read.`);
    }
    return { sheets: [sheet], warnings };
  },
};

/** The one read of a file's database: the built-in for its extension. */
async function readSheets(
  bytes: Buffer,
  ext: string,
  pdfKind: Parameters<typeof parsePdfDrawing>[1] | undefined,
  stored: unknown,
): Promise<ParsedFile> {
  const pipeline = builtinForExt(ext);
  if (!pipeline) throw new Error(`no database reader for .${ext}`);
  const options = effectiveOptions(pipeline, stored);
  const parsed = await ADAPTERS[pipeline.id](bytes, ext, pdfKind, options);
  const hash = optionsHash(pipeline, options);
  return parsed.kind === 'sheets' && hash ? { ...parsed, optionsHash: hash } : parsed;
}

/**
 * Parse a file's bytes for its database and its Table, once. A verdict on the
 * document comes back as its word; any other failure throws, and the caller
 * decides (the extract retries).
 *
 * A CSV is read in this process, so past its cap and with no Table wanted it
 * earns its word with no read at all. A box still making Tables parses it
 * anyway, as it did before there was a database.
 */
export async function parseFileSheets(
  bytes: Buffer,
  ext: string,
  opts: {
    tableWanted?: boolean;
    /** The decider, for a PDF the rules left unsure (see parsePdfDrawing).
     *  Left out: no model call. */
    pdfKind?: Parameters<typeof parsePdfDrawing>[1];
    /** The reader's options (pipelineStateOf). Left out: the defaults. */
    options?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<ParsedFile> {
  if (
    ext === 'csv' &&
    !opts.tableWanted &&
    bytes.length > envNum('MANTLE_FILE_DB_CSV_MAX_MB') * 1024 * 1024
  ) {
    return { kind: 'none', word: 'too-large' };
  }
  try {
    return await readSheets(bytes, ext, opts.pdfKind, opts.options);
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
  return { status: 'built', tabs: tabs.length, rows };
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
  // A read here takes the box's options of the reader; a reader with none
  // asks for no state.
  const parsed =
    args.parsed ??
    (await parseFileSheets(bytes, ext, {
      ...(reader && Object.keys(reader.options ?? {}).length > 0
        ? { options: (await pipelineStateOf(ownerId, reader)).options }
        : {}),
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
  file: { sqlite: string; ext: string },
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
  const { sheets, warnings } = AFTER_ADAPTERS[pipeline.id](file.sqlite, state.options);
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
    return patchDatabaseAt({ sqlite: names.sqlite, ext: extOf(row.filename) }, pipeline, state);
  });
}

/**
 * The `after` chain of a build, in the order of BUILTIN_PIPELINES. Two
 * checks for each pipeline: the file's home workspace is in its attach
 * list, and its match rule holds (the extension, then the real tabs). The
 * extension is looked at first, so a file no `after` pipeline reads asks
 * for no state. An error is logged and never fails the build: the
 * reader's database stands, and the stamp has no entry for that pipeline.
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
