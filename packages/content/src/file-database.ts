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
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { ensureWorkbookDoc, tableDocFromGrid } from '@mantle/content-core/table-model';
import { envNum } from '@mantle/config';
import { db, nodes } from '@mantle/db';
import {
  builtinForExt,
  extOf,
  fileDbPaths,
  isFileSha256,
  isParserError,
  parserGrid,
  parserPdfDrawing,
  pdfDrawingSheets,
  pipelineStampOf,
  PIPELINE_STAMP_KEYS,
  removeFileDbNames,
  removeFileDbNone,
  removeOtherFileDbNames,
  resolveEffectiveIndexing,
  writeFileDbNone,
  type BuiltinId,
  type CadExt,
  type FileDbNoneWord,
  type PdfDrawing,
  type PdfKindDecision,
  type PipelineManifest,
  type PipelineStamp,
} from '@mantle/files';
import {
  DelimitedReadError,
  parseSpreadsheetToGrid,
  type ParsedSheet,
} from '@mantle/files/sheet-to-grid';
import { importMaxRows, readDocMeta } from '@mantle/tabledb';
import { writeFileDatabaseDoc } from './table-broker';

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
  pdfKind?: Parameters<typeof parsePdfDrawing>[1],
) => Promise<ParsedFile>;

/** The built-in pipelines' readers, by id (`BUILTIN_PIPELINES`, @mantle/files):
 *  each runs in this process, as before there was a registry. Keyed by
 *  BuiltinId, so a built-in with no adapter does not compile. */
const ADAPTERS: Record<BuiltinId, Adapter> = {
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

/** The one read of a file's database: the built-in for its extension. */
async function readSheets(
  bytes: Buffer,
  ext: string,
  pdfKind?: Parameters<typeof parsePdfDrawing>[1],
): Promise<ParsedFile> {
  const pipeline = builtinForExt(ext);
  if (!pipeline) throw new Error(`no database reader for .${ext}`);
  return ADAPTERS[pipeline.id](bytes, ext, pdfKind);
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
    return await readSheets(bytes, ext, opts.pdfKind);
  } catch (err) {
    const word = noneWordOf(err);
    if (word) return { kind: 'none', word };
    throw err;
  }
}

/** The file row as it stands now: its bytes and whether it is private. */
export async function readFileRowNow(
  fileId: string,
  ownerId: string,
): Promise<{ sha256: string | null; isPrivate: boolean } | null> {
  const [row] = await db
    .select({
      path: nodes.path,
      sha256: sql<string | null>`${nodes.data}->>'sha256'`,
      indexing: sql<string | null>`${nodes.data}->>'indexing'`,
    })
    .from(nodes)
    .where(and(eq(nodes.id, fileId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'file')))
    .limit(1);
  if (!row) return null;
  const { effective } = await resolveEffectiveIndexing(ownerId, {
    path: row.path,
    data: { indexing: row.indexing },
  });
  return { sha256: row.sha256, isPrivate: effective === 'metadata' };
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
  const parsed = args.parsed ?? (await parseFileSheets(bytes, ext));
  if (parsed.kind === 'not-plan' || parsed.kind === 'not-drawing') {
    return { status: 'skipped', reason: parsed.kind };
  }

  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    return { status: 'skipped', reason: 'stale' };
  }
  const before = await readFileRowNow(fileId, ownerId);
  if (!before || before.sha256 !== sha256) return { status: 'skipped', reason: 'stale' };
  if (before.isPrivate) return { status: 'skipped', reason: 'private' };

  const out = await writeRowsOrWord(
    { fileId, ownerId, sha256, sqlite: names.sqlite, pipeline: builtinForExt(ext) },
    parsed,
  );

  // Read again: this write can be long. A name of older bytes goes, and a
  // replace during the write keeps its new one.
  const after = await readFileRowNow(fileId, ownerId);
  if (!after || after.isPrivate) {
    await removeFileDbNames(fileId);
    return { status: 'skipped', reason: 'moved' };
  }
  await removeOtherFileDbNames(fileId, after.sha256);
  return after.sha256 === sha256 ? out : { status: 'skipped', reason: 'moved' };
}

/**
 * The stamp of a file's database at these bytes: which pipeline read it, at
 * which version. Null when there is no database, or it was built before
 * stamps: every reader of the stamp takes null as "read before stamps".
 */
export async function readFileDbStamp(
  fileId: string,
  sha256: unknown,
): Promise<PipelineStamp | null> {
  const names = fileDbPaths(fileId, sha256);
  if (!names) return null;
  const meta = readDocMeta(names.sqlite, PIPELINE_STAMP_KEYS);
  if (!meta) return null;
  const [id, version, api, shapes] = PIPELINE_STAMP_KEYS.map((k) => meta[k]);
  if (id === undefined || version === undefined || api === undefined || shapes === undefined) {
    return null;
  }
  return { pipeline_id: id, pipeline_version: version, pipeline_api: api, shapes };
}
