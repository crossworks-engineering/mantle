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
  PAGE_ASK_KEY_PREFIX,
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
  removeWindowStage,
  PDF_MAX_BYTES,
  PIPELINE_CALLS_MAX,
  PIPELINE_STAMP_KEYS,
  removeFileDbNames,
  removeFileDbNone,
  removeOtherFileDbNames,
  resolveEffectiveIndexing,
  SHAPES,
  stampOfMeta,
  withAfterEntry,
  withoutAfterEntry,
  pageKindsAt,
  pagesWithRows,
  pdfFrameKindOf,
  withPageKinds,
  writeFileDbNone,
  type FileDbNoneWord,
  type PdfPageKind,
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
  pdfNodeVisionOf,
  pdfPageKindsOver,
  pdfReadAgainOf,
  readerStateOf,
  routePdf,
  storedPdfOf,
  type FileStamp,
  type PdfDecide,
  type PdfPageDecide,
  type StoredPdf,
} from './pdf-read';
import {
  bookScanEvidenceOf,
  bookScanPagesOf,
  bookVisionPagesOf,
  drawingLanePagesOf,
} from './book-pages';
import { pagesToRead, windowPagePictures, type BookPagePictures } from './book-page-pictures';
import {
  AGENT_HASH_COLUMN,
  PAGE_TEXT_ANSWER_MAX_CHARS,
  AGENT_LIST_COLUMNS,
  AGENT_PAGE_COLUMN,
  agentRows,
  agentTextOf,
  askCapOf,
  checkAsks,
  type AgentAskFn,
} from './pipeline-agent';
import {
  afterBodyOf,
  agentStep,
  isWindowLost,
  pagesReadOf,
  pdfWindows,
  pdfWindowsAt,
  PipelineRunError,
  windowJob,
  readerGivesText,
  readerRun,
  readerStandsOver,
  readsInWindows,
  routedReaderRun,
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
      /** A Reader that read the file in page windows: the pages read and
       *  the pages of the file, kept in the database's `_meta`. */
      pages?: { read: number; total: number };
      /** The Reader that made these sheets when it is not the reader of the
       *  extension (a Reader that claims the router's kind and stands over
       *  the core's PDF read): the stamp names it, so the text pass and a
       *  status read find it. */
      readBy?: PipelineManifest;
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

/** What an `after` pipeline gives: its sheets, by tab name, and warnings;
 *  and the columns its tabs keep out of search, when its write names some
 *  (Links: ids and kinds, no words to search). */
type AfterResult = { sheets: ParsedSheet[]; warnings: string[]; ftsSkipColumns?: string[] };

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
  const skip = run.write?.ftsSkipColumns;
  return {
    sheets: run.write?.tabs ?? [],
    warnings: [...run.warnings, ...body.warnings],
    ...(skip && skip.length > 0 ? { ftsSkipColumns: [...skip] } : {}),
  };
}

/** A real read: the router's run is counted for this box and file. */
type RouterCount = { ownerId: string; fileId: string };

/** A PDF read again: its stored kind and decision. `reroute`: the kind came
 *  from older rules, so the router names it again with no ask, and the
 *  stored decision (a shadow or weak answer) stays in the File tab. */
type PdfStored = Pick<StoredPdf, 'kind' | 'decision'> & {
  reroute?: boolean;
  /** The page types of its tab Pages (the router's part 2), put in again
   *  with no ask. */
  pageKinds?: readonly PdfPageKind[];
};

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
  // A Reader that claims the kind (readBy) brought the hash of its own options.
  return parsed.kind === 'sheets' && hash && !parsed.readBy
    ? { ...parsed, optionsHash: hash }
    : parsed;
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
 * model. A stored kind from older rules (`reroute`) is named again by the
 * router with no ask, as an upload's is, and its run counts; the stored
 * decision stays.
 *
 * A kind no reader claims (a document) gets no database and no name (the
 * next extract of the same bytes reads it again, which costs no model).
 * Only the rules name a document: the decider's `document` is never used
 * (decidedKind), so an unsure file keeps its database.
 *
 * `count`: a real read counts the router's run when it named the kind, a
 * document too. Left out (a test): no count. A read again with no reroute counts none: the
 * router did not run.
 */
async function readRouted(
  router: PipelineManifest,
  bytes: Buffer,
  ext: string,
  options: Readonly<Record<string, unknown>>,
  opts: Pick<
    ParseOpts,
    'pdfKind' | 'pdfPages' | 'pdfStored' | 'pdfNodeVision' | 'count' | 'pipelines'
  >,
): Promise<ParsedFile> {
  const stored = opts.pdfStored?.pageKinds ?? [];
  const decide = opts.pdfPages;
  // The page types (the router's part 2). With `pdfPages` (given only where
  // they may be made: an upload's extract, or a person's run of one file,
  // Q2), the pages with no stored answer are asked; a stored answer is never
  // asked again (pdfPageKindsOver), and every answer is worked out for this
  // box (pageKindsAt: used only when live). Live (M4): before the Reader,
  // over every page (or the stored pages, on a read again), as they name
  // the Reader (pdfFrameKindOf). Shadow: after the Reader's run, over its
  // tab Pages, and the route does not change. With no `pdfPages` (a read
  // again): the stored ones, with no ask; their used answers (`decider`,
  // only a live read writes it) name the frame again, so a read again keeps
  // a live read's frame, a reroute by newer rules too.
  const before = decide?.live
    ? pageKindsAt(
        await pdfPageKindsOver(
          router,
          bytes,
          options,
          decide,
          stored.length > 0 ? new Set(stored.map((k) => k.page)) : null,
          stored,
        ),
        decide,
      )
    : null;
  const parsed = await readRoutedSheets(
    router,
    bytes,
    ext,
    options,
    opts,
    before ?? (decide ? null : stored),
  );
  if (parsed.kind !== 'sheets') return parsed;
  const kinds =
    before ??
    (decide
      ? pageKindsAt(
          await pdfPageKindsOver(
            router,
            bytes,
            options,
            decide,
            pagesWithRows(parsed.sheets),
            stored,
          ),
          decide,
        )
      : stored);
  if (kinds.length === 0) return parsed;
  // The note of the words of Kind from comes with them (withPageKinds).
  return { ...parsed, ...withPageKinds(parsed, kinds) };
}

/** readRouted's read, before the page types. */
async function readRoutedSheets(
  router: PipelineManifest,
  bytes: Buffer,
  ext: string,
  options: Readonly<Record<string, unknown>>,
  opts: Pick<ParseOpts, 'pdfKind' | 'pdfStored' | 'pdfNodeVision' | 'count' | 'pipelines'>,
  /** The page types that name the frame (M4): a live read's, or the
   *  stored ones of a read again with no ask. */
  pageKinds: readonly PdfPageKind[] | null = null,
): Promise<ParsedFile> {
  const stored = opts.pdfStored;
  // A read again keeps its stored kind; one of older rules is routed again,
  // with no ask, and keeps its stored decision.
  const routed =
    !stored || stored.reroute
      ? await routePdf(router, bytes, options, stored ? undefined : opts.pdfKind)
      : null;
  const named: PdfStored & { facts?: Record<string, unknown> } = routed
    ? { ...routed, decision: stored ? stored.decision : routed.decision }
    : stored!;
  if (routed && opts.count) {
    await countRun(opts.count.ownerId, router.id, opts.count.fileId);
  }
  const { decision } = named;
  // The frame (M4, live): the lanes of the pages name the Reader; with no
  // used page answer the kind as named.
  const kind = pageKinds ? pdfFrameKindOf(pageKinds, named.kind) : named.kind;
  const reader = opts.pipelines.readerFor(ext, kind);
  if (!reader) return { kind: 'not-drawing' };
  // A Reader whose text stands over the core's PDF read (a book), or one
  // that reads in page windows: its run reads the file (never the facts)
  // and is kept for the extract, so the text pass takes the same run.
  if (readerStandsOver(reader) || readsInWindows(reader, ext)) {
    // Its own options in force (the box's, for a real read), not those of
    // the extension's reader: the text pass finds the run by them.
    const own = effectiveOptions(
      reader,
      opts.count ? (await pipelineStateOf(opts.count.ownerId, reader)).options : {},
    );
    // A real read keeps its page windows as they end, so a run tried again
    // reads on from the first window not kept (./window-stage.ts).
    const run = await routedReaderRun(
      reader,
      bytes,
      ext,
      own,
      { kind, state: readerStateOf(decision, false, opts.pdfNodeVision === true) },
      opts.count ? { fileId: opts.count.fileId } : undefined,
    );
    const parsed = withRunFacts(reader, run, parsedFileOfRun(reader, run));
    const hash = optionsHash(reader, own);
    return parsed.kind === 'sheets'
      ? { ...parsed, readBy: reader, ...(hash ? { optionsHash: hash } : {}) }
      : parsed;
  }
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
    state: readerStateOf(decision, body !== undefined, opts.pdfNodeVision === true),
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
    return withRunFacts(
      pipeline,
      run,
      parsedFileOfRun(pipeline, run),
      readerGivesText(pipeline, ext),
    );
  }
  const run = await runPackaged(pipeline, named?.body ?? bytes, stepFileOf(bytes, ext), {
    options,
    ...(named ? { kind: named.kind, state: named.state } : {}),
  });
  return parsedFileOfRun(pipeline, run);
}

/** A Reader's sheets with what else its run says: the length of its text
 *  when that text is the file's (`gives`: readerGivesText, or a Reader that
 *  stands over the core's PDF read), and the pages of a windowed run. */
function withRunFacts(
  pipeline: Pick<PipelineManifest, 'produces' | 'match'>,
  run: PipelineRunResult,
  parsed: ParsedFile,
  gives = readerStandsOver(pipeline),
): ParsedFile {
  if (parsed.kind !== 'sheets') return parsed;
  return {
    ...parsed,
    ...(run.write?.text && gives ? { readerText: run.write.text.length } : {}),
    ...(run.windows
      ? { pages: { read: pagesReadOf(run.windows), total: run.windows.pagesTotal } }
      : {}),
  };
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
  /** The page asks of a PDF's page types (the router's part 2, readRouted):
   *  given only where they may be made, at an upload's extract and at a
   *  person's run of one file (Q2, buildFileDatabase's `pdfPages`). Left
   *  out: no page ask. */
  pdfPages?: PdfPageDecide;
  /** A PDF read again: its stored kind and decision (the File tab). The
   *  router does not run and no model is asked. */
  pdfStored?: PdfStored;
  /** A PDF whose node holds the text of an older whole-page vision read
   *  (pdfNodeVisionOf): the reader's File tab says `node text only`. */
  pdfNodeVision?: boolean;
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
  // The stamp and the count name the Reader that made the sheets.
  if (parsed.readBy) file = { ...file, pipeline: parsed.readBy };
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
    await stampPipelineRead(file.fileId, file.sha256, file.pipeline);
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
    ...(parsed.pages ? { pages: parsed.pages } : {}),
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
  if (file.pipeline) {
    await countRun(file.ownerId, file.pipeline.id, file.fileId);
    await stampPipelineRead(file.fileId, file.sha256, file.pipeline);
  }
  return { status: 'built', tabs: tabs.length, rows };
}

/**
 * The node's copy of the Reader's stamp (docs/files.md, "Reindex and stale
 * indexes"): `data.pipeline_read` { id, name, version }, so a file row says
 * which pipeline read it, and whether an installed version is newer, with no
 * look into its database. Written where the stamp of the database is (the
 * two write spots above), only while the row still has these bytes, and
 * leaves `updated_at` alone (a derived write). System work only (the
 * extract, a run on demand, the maintenance tasks). A failed write is
 * logged and never fails or undoes the database's.
 */
async function stampPipelineRead(
  fileId: string,
  sha256: string,
  pipeline: Pick<PipelineManifest, 'id' | 'name' | 'version'>,
): Promise<void> {
  const stamp = {
    pipeline_read: { id: pipeline.id, name: pipeline.name, version: pipeline.version },
  };
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('mantle.keep_updated_at', 'on', true)`);
      await tx
        .update(nodes)
        .set({ data: sql`${nodes.data} || ${JSON.stringify(stamp)}::jsonb` })
        .where(
          and(
            eq(nodes.id, fileId),
            eq(nodes.type, 'file'),
            sql`${nodes.data}->>'sha256' = ${sha256}`,
          ),
        );
    });
  } catch (err) {
    logger.warn(`the pipeline stamp of ${fileId} was not written: ${errorMessage(err)}`);
  }
}

/** The most rows of an Agent's tab that are read back: an Agent writes one
 *  row for each ask, and a step has 64 calls at most; its list tab one row
 *  for each item, PIPELINE_ASK_LIST_MAX (400) items an ask at most. */
const AGENT_ROWS_MAX = 64 * 400;

/** One tab of the database at `abs`, whole, every cell as text but in a
 *  number column (the Page of a list tab): an Agent's rows, each cell up to
 *  a page of text (PAGE_TEXT_ANSWER_MAX_CHARS: an Agent of page text keeps
 *  a whole page, and a run again or a re-read must not cut it). Null: no
 *  database, no such tab, or it cannot be read. */
function textTabAt(abs: string, name: string): ParsedSheet | null {
  try {
    const tab = describeWorkbook(abs).find((t) => t.name === name);
    if (!tab) return null;
    const columns = tab.columns.map((c) => c.name);
    const numbers = new Set(tab.columns.filter((c) => c.type === 'number').map((c) => c.name));
    const cell = (c: string, v: unknown) =>
      v === null || v === undefined
        ? null
        : numbers.has(c) && typeof v === 'number'
          ? v
          : String(v);
    const rows: (string | number | null)[][] = [];
    scanTabColumns(
      abs,
      name,
      columns,
      { maxRows: AGENT_ROWS_MAX, cellMaxChars: PAGE_TEXT_ANSWER_MAX_CHARS },
      (row) => {
        rows.push(columns.map((c) => cell(c, row[c])));
        return true;
      },
    );
    return {
      name,
      columns: columns.map((c) => ({ name: c, type: numbers.has(c) ? 'number' : 'text' })),
      rows,
    };
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

type BuildArgs = {
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
  /** A read again of a PDF with the page asks of a person's run of one
   *  file (Q2; server/api extract/pipeline-run.ts gives it, behind
   *  pdfPageDeciderOf's two checks, and nothing else does): the pages with
   *  no stored answer are asked. Left out, as for every other build: the
   *  stored page types are put back and no model is asked. With `parsed`:
   *  not read (the caller read it). */
  pdfPages?: PdfPageDecide;
};

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
export async function buildFileDatabase(args: BuildArgs): Promise<FileDbBuild> {
  const { fileId, ownerId, sha256, bytes } = args;
  const names = fileDbPaths(fileId, sha256);
  if (!names || !isFileSha256(sha256)) return { status: 'skipped', reason: 'no-sha' };
  const ext = extOf(args.filename);
  const pipelines = args.pipelines ?? (await boxPipelines(ownerId));
  const reader = pipelines.readerFor(ext);
  // A read here, with no `parsed`, is a read again with no model (a run on
  // demand, a re-read), but for the page asks of a person's run of one PDF
  // (`pdfPages`, Q2). `dwg-reindex --pdf` passes `parsed`, so it is not
  // here: it makes its own check before its parse, as before. For a file
  // type with a router (a PDF) it
  // is ONE read, the job, and ONE conditional write (docs/pipelines.md, "The
  // PDF set"): it works from the stored state of these bytes, read once and
  // fail closed (pdfReadAgainOf), and writes only when that state did not
  // change and the new read is not poorer.
  let again:
    | {
        stored: StoredPdf | null;
        since: FileStamp | null;
        reroute: boolean;
        pageKinds: readonly PdfPageKind[];
      }
    | undefined;
  if (!args.parsed && pipelines.routerFor(ext)) {
    const state = await pdfReadAgainOf(names);
    if (state.skip) return { status: 'skipped', reason: state.skip };
    again = state;
  }
  // A kind from older rules is named again by the router (no ask).
  const pdfStored: PdfStored | undefined = again?.stored
    ? {
        kind: again.stored.kind,
        decision: again.stored.decision,
        ...(again.reroute ? { reroute: true } : {}),
        pageKinds: again.pageKinds,
      }
    : undefined;
  const pdfNodeVision = again ? await pdfNodeVisionOf(fileId) : false;
  // A read here takes the box's options of the reader.
  const options = args.parsed ? undefined : await readerOptionsOf(ownerId, ext, pipelines);
  const parsed =
    args.parsed ??
    (await parseFileSheets(bytes, ext, {
      pipelines,
      ...(options ? { options } : {}),
      ...(pdfStored ? { pdfStored } : {}),
      ...(pdfNodeVision ? { pdfNodeVision } : {}),
      ...(args.pdfPages ? { pdfPages: args.pdfPages } : {}),
      count: { ownerId, fileId },
    }));
  // The read is done: whatever this build does with it, the windows its
  // run kept go (./window-stage.ts). A throw below leaves them, for the
  // build tried again.
  const out = await buildFromParsed(args, { names, ext, pipelines, reader, again, parsed });
  await removeWindowStage(fileId, sha256);
  return out;
}

/** The rest of buildFileDatabase, from the read's result on. */
async function buildFromParsed(
  args: BuildArgs,
  at: {
    names: NonNullable<ReturnType<typeof fileDbPaths>>;
    ext: string;
    pipelines: BoxPipelines;
    reader: BoxPipeline | null;
    again: { stored: StoredPdf | null; since: FileStamp | null; reroute: boolean } | undefined;
    parsed: ParsedFile;
  },
): Promise<FileDbBuild> {
  const { fileId, ownerId, bytes } = args;
  const sha256 = args.sha256 as string;
  const { names, ext, pipelines, reader, again, parsed } = at;
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
 *  write would be the word `too-large` (writeRowsOrWord). A read whose File
 *  tab names another Kind (a new frame) is poorer only with more pages not
 *  read whole. */
function poorerThan(parsed: Extract<ParsedFile, { kind: 'sheets' }>, stored: StoredPdf): boolean {
  if (rowsOf(parsed) > importMaxRows()) return true;
  const tab = parsed.sheets.find((s) => s.name === 'File');
  const now = tab?.rows[0]
    ? pdfFileTabOf(
        tab.columns.map((c) => c.name),
        tab.rows[0],
      )
    : null;
  // A read of another Kind (a new frame, M4: the lanes of the pages named
  // another Reader) is poorer only with more pages not read whole.
  if (!now) return true;
  return now.kind === stored.kind
    ? pdfReadPoorer(now, stored)
    : now.notReadWhole > stored.notReadWhole;
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
  const { sheets, warnings, ftsSkipColumns } = await afterSheetsOf(
    pipeline,
    file.sqlite,
    state.options,
  );
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
    ...(ftsSkipColumns ? { ftsSkipColumns } : {}),
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

/**
 * What the core gives an Agent's step of a file beside the file
 * (agentStep's `from`): the kind stored in the file's database at `sqlite`
 * (a PDF's File tab), for a file type with a router, and the options in
 * force of the file's Reader as the step's state (`readerOptions`: the
 * title block box of a PDF). The one place for a run and a test
 * (`pipeline_test`), so a test shows what a run would ask.
 */
export async function agentInputOf(
  ownerId: string,
  ext: string,
  pipelines: BoxPipelines,
  sqlite: string,
  agent: Pick<PipelineManifest, 'produces'>,
  /** The box routes by page types (`uses.pdf_kind.mode: 'live'`): a page
   *  whose type is unsure keeps its picture (pageLanesOf). */
  pageLive = false,
): Promise<{
  kind?: string;
  state: {
    readerOptions: Readonly<Record<string, unknown>>;
    visionPages?: number[];
    scanPages?: number[];
    drawingPages?: number[];
  };
}> {
  const kind = pipelines.routerFor(ext) ? (await storedPdfOf(sqlite))?.kind : undefined;
  const readerOptions = (await readerOptionsOf(ownerId, ext, pipelines)) ?? {};
  // The pages of a PDF its Agent reads, by the lanes of the pages (M4,
  // ./book-pages.ts pageLanesOf). An Agent of page text (pdf-page-read):
  // the office-lane pages to read (in a book, those its reader marked), and
  // of them the scanned pages, which the Scan reader reads (the step cuts
  // each as a one-page PDF; docs/ai-workers.md, "The Scan reader"). Any
  // other Agent of a PDF (pdf-sheet-read): the drawing-lane pages, when the
  // lanes name them (none named: from page 1, as before).
  const office = kind !== undefined && agent.produces.pages === true;
  const visionPages = office ? await bookVisionPagesOf(sqlite, pageLive) : undefined;
  const scanPages = visionPages?.length ? await bookScanPagesOf(sqlite) : [];
  const drawingPages = kind !== undefined && !office ? await drawingLanePagesOf(sqlite) : null;
  return {
    ...(kind !== undefined ? { kind } : {}),
    state: {
      readerOptions,
      ...(visionPages ? { visionPages } : {}),
      ...(scanPages.length > 0 ? { scanPages } : {}),
      ...(drawingPages ? { drawingPages } : {}),
    },
  };
}

/**
 * Whether an Agent's page text reaches the file's passages by page (P3): it
 * says `produces.pages`, and so does the Reader of the database at `sqlite`
 * (its stamp; the book reader), as filePagesOf reads them. Else (an office
 * page of a PDF drawing, M4) its text goes to the file's text as any
 * Agent's (agentTextOf), so no paid page text is out of search.
 */
function pagesGiveText(
  agent: Pick<PipelineManifest, 'produces'>,
  sqlite: string,
  pipelines: BoxPipelines,
): boolean {
  if (agent.produces.pages !== true) return false;
  try {
    const stamp = stampOfMeta(readDocMeta(sqlite, [...PIPELINE_STAMP_KEYS]));
    return stamp !== null && pipelines.byId(stamp.pipeline_id)?.produces.pages === true;
  } catch {
    return false;
  }
}

export type FileAgentRun =
  /** The asks are answered, as far as they were. `made`: paid calls of this
   *  run. `reused`: asks answered from the tab, with no call. `stopped`: why
   *  the calls ended early; the stamp entry is then not set. */
  | {
      status: 'asked';
      rows: number;
      /** Rows of the Agent's list tab, when it has one. */
      listRows?: number;
      made: number;
      reused: number;
      stopped?: string;
      warnings: string[];
      /** The text of the Agent's tabs as written, for the file's text
       *  (agentTextOf). Left out: the tabs were not written. */
      text?: string;
      /** A book's page pictures saved by this run (G1). */
      pictures?: number;
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
 *
 * An Agent has one tab (`produces.tabs[0]`) and may have a second, its list
 * tab (`produces.tabs[1]`, "The list part of an ask"). Both are written in
 * the one patch. The step gets the kind stored in the file's database, for
 * a file type with a router (a PDF), and the options in force of the file's
 * Reader as its state.
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
  /** Where a book's page pictures are saved (G1): an Agent of page text
   *  that reads the pages a book reader marked (pdf-page-read) saves each
   *  page's picture with the text it read (./book-page-pictures.ts). */
  pagePictures?: BookPagePictures;
  /** The box routes by page types (M4, live): a page whose type is unsure
   *  is read too, and its picture kept (agentInputOf). */
  pageLive?: boolean;
}): Promise<FileAgentRun> {
  const { fileId, ownerId, sha256, bytes } = args;
  const pipelines = args.pipelines ?? (await boxPipelines(ownerId));
  const pipeline = pipelines.agents.find((p) => p.id === args.pipeline.id);
  const tab = pipeline?.produces.tabs?.[0];
  const listTab = pipeline?.produces.tabs?.[1];
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
  // An Agent that claims kinds (pdf-page-read: `book`) cuts no window and
  // runs no parser job on a file of another kind, nor on a book with no page
  // left to vision (M3).
  if (pipeline.match.kind) {
    const input = await agentInputOf(
      ownerId,
      ext,
      pipelines,
      names.sqlite,
      pipeline,
      args.pageLive === true,
    );
    if (input.kind === undefined || !pipeline.match.kind.includes(input.kind)) {
      return { status: 'skipped', reason: 'no-match' };
    }
    // No page of its lane to read (M4): no job.
    if (input.state.visionPages?.length === 0) return { status: 'skipped', reason: 'no-match' };
    if (input.state.drawingPages?.length === 0) return { status: 'skipped', reason: 'no-match' };
  }

  const state = await pipelineStateOf(ownerId, pipeline);
  if (readsInWindows(pipeline, ext)) {
    return runAgentWindowed({ ...args, pipeline, pipelines, ext, sqlite: names.sqlite, state });
  }
  // A PDF past the size pdfjs opens is read in page windows only (a book's
  // drawing pages, M4): a built-in Agent with no windows runs no job on it.
  if (ext === 'pdf' && pipeline.source !== 'own' && bytes.length > PDF_MAX_BYTES) {
    return { status: 'skipped', reason: 'no-match' };
  }
  const step = await agentStep(
    pipeline,
    bytes,
    stepFileOf(bytes, ext),
    state.options,
    await agentInputOf(ownerId, ext, pipelines, names.sqlite, pipeline, args.pageLive === true),
  );
  if (step.status === 'not_mine') return { status: 'skipped', reason: 'no-match' };
  const asks = checkAsks(pipeline, step.asks, step.pictures);
  const storedOf = (name: string) => {
    const t = textTabAt(names.sqlite, name);
    return (t?.rows ?? []).map((r) =>
      Object.fromEntries(t!.columns.map((c, i) => [c.name, r[i] ?? null])),
    );
  };
  const out = await agentRows(
    tab,
    asks,
    storedOf(tab),
    args.ask,
    listTab ? { tab: listTab, stored: storedOf(listTab) } : undefined,
  );
  const done = {
    status: 'asked' as const,
    rows: out.sheet?.rows.length ?? 0,
    ...(listTab ? { listRows: out.listSheet?.rows.length ?? 0 } : {}),
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
    const sheets = [out.sheet, out.listSheet].filter((t): t is ParsedSheet => t !== null);
    patchFileDatabaseDoc(names.sqlite, {
      replaceTabs: listTab ? [tab, listTab] : [tab],
      tabs: tabsOfSheets(sheets),
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
    return {
      ...done,
      text: pagesGiveText(pipeline, names.sqlite, pipelines) ? '' : agentTextOf(sheets),
    };
  });
}

/**
 * An Agent that reads in page windows (`needs.window`, docs/pipelines.md,
 * "Page windows"; P4, write in parts): the money rule of runAgentOnFile,
 * window by window. For each window: one parser job on the window's PDF
 * gives its asks (agentStep, with the window's pages), the core answers
 * them (agentRows: from the tab by hash, else one paid call), and the
 * rows so far are written with one patch, so a kill loses one window's
 * calls at most, and the next run takes the written rows by their hash.
 *
 * The cap of `needs.workers` holds for the whole file: an ask past it is
 * not made, and the run is `stopped` (`cap`). After the first stop no
 * window makes a call; each keeps the rows of its keys that are there. A
 * window the parser cannot cut or the step cannot read is left out with a
 * warning, and its stored rows stay. The stamp entry is set only when every
 * ask of every window has its answer; else it is taken out.
 */
async function runAgentWindowed(args: {
  fileId: string;
  ownerId: string;
  sha256: unknown;
  bytes: Buffer;
  pipeline: BoxPipeline & { needs: { window: { pages: number; mb: number } } };
  pipelines: BoxPipelines;
  ext: string;
  sqlite: string;
  state: PipelineState;
  ask: AgentAskFn;
  pagePictures?: BookPagePictures;
  pageLive?: boolean;
}): Promise<FileAgentRun> {
  const { fileId, ownerId, bytes, pipeline, ext, sqlite, state } = args;
  const sha256 = args.sha256 as string;
  const tab = pipeline.produces.tabs![0]!;
  const listTab = pipeline.produces.tabs?.[1];
  const storedOf = (name: string) => {
    const t = textTabAt(sqlite, name);
    return (t?.rows ?? []).map((r) =>
      Object.fromEntries(t!.columns.map((c, i) => [c.name, r[i] ?? null])),
    );
  };
  const stored = storedOf(tab);
  const storedList = listTab ? storedOf(listTab) : [];
  const input = await agentInputOf(
    ownerId,
    ext,
    args.pipelines,
    sqlite,
    args.pipeline,
    args.pageLive === true,
  );
  // A book's page pictures (G1, ./book-page-pictures.ts): a marked page
  // done already (its picture of these bytes and its text row) is neither
  // drawn nor asked again. The step gets every marked page (its option
  // `pages` counts them all) and the done ones; only the windows that hold
  // a page to read are cut.
  const marked = input.state.visionPages;
  const pagePictures = marked ? args.pagePictures : undefined;
  const toRead =
    marked && pagePictures ? pagesToRead(marked, await pagePictures.done(), stored) : marked;
  const reading = new Set(toRead ?? []);
  const donePages = marked ? marked.filter((n) => !reading.has(n)) : [];
  const stepInput =
    donePages.length === 0 ? input : { ...input, state: { ...input.state, donePages } };
  let picturesSaved = 0;
  const file = stepFileOf(bytes, ext);
  let sheet = null as ParsedSheet | null;
  let listSheet = null as ParsedSheet | null;
  const seen = new Set<string>();
  const warnings: string[] = [];
  let made = 0;
  let reused = 0;
  let noScanReader = 0;
  let stopped: string | undefined;
  let lost = false;
  let first = true;
  const asked = new Map<string, number>();
  // The hashes of the paid answers in the tab: an ask with one is free.
  const paidHashes = new Set(stored.map((r) => String(r[AGENT_HASH_COLUMN] ?? '')));
  const windowView = {
    ...pipeline,
    needs: {
      ...pipeline.needs,
      workers: Object.fromEntries(
        Object.keys(pipeline.needs.workers ?? {}).map((w) => [w, PIPELINE_CALLS_MAX]),
      ),
    },
  };
  /** The stored rows kept over each write (keptUnseenRows): on the last
   *  write of a run that read every window, only those of a page still
   *  marked for vision. */
  const stillMarked = new Set(
    (input.state.visionPages ?? []).map((n) => `${PAGE_ASK_KEY_PREFIX}${n}`),
  );
  const unseen = (
    rows: readonly Readonly<Record<string, unknown>>[],
    to: ParsedSheet | null,
    all: boolean,
  ) =>
    to
      ? keptUnseenRows(rows, seen, all ? 'all' : stillMarked).map((r) =>
          to.columns.map((c) => (r[c.name] ?? null) as string | number | null),
        )
      : [];
  const write = async (final: boolean): Promise<FileAgentRun | null> => {
    const out = await writeUnderRow(fileId, ownerId, sha256, async () => {
      const meta = readDocMeta(sqlite, ['pipelines_after']);
      if (!meta) return 'no-database' as const;
      const keepOld = !final || lost;
      const sheets = [
        sheet ? { ...sheet, rows: [...sheet.rows, ...unseen(stored, sheet, keepOld)] } : null,
        listSheet
          ? { ...listSheet, rows: [...listSheet.rows, ...unseen(storedList, listSheet, keepOld)] }
          : null,
      ].filter((t): t is ParsedSheet => t !== null);
      // A page the box could not read now (no Scan reader) leaves the run
      // not done: the next run reads it.
      const done = final && stopped === undefined && !lost && noScanReader === 0;
      patchFileDatabaseDoc(sqlite, {
        replaceTabs: sheets.map((t) => t.name),
        tabs: tabsOfSheets(sheets),
        ftsSkipColumns: [AGENT_HASH_COLUMN],
        setMeta: {
          pipelines_after: done
            ? withAfterEntry(meta.pipelines_after, pipeline, state.optionsHash)
            : withoutAfterEntry(meta.pipelines_after, pipeline.id),
        },
      });
      return 'written' as const;
    });
    if (out === 'written') return null;
    if (out === 'no-database') return { status: 'skipped', reason: 'no-database' };
    return out;
  };
  // Only the windows that hold a marked page to read are cut (a book of
  // 1,679 pages with one page left to vision is one cut, not 112): each
  // window starts at the first such page past the one before; none when
  // every marked page is done. An Agent with no marked pages in its state
  // reads every window.
  const windows =
    marked && marked.length > 0
      ? pdfWindowsAt(bytes, sha256, pipeline.needs.window, toRead ?? [])
      : pdfWindows(bytes, sha256, pipeline.needs.window);
  for await (const w of windows) {
    if (!w.part) {
      lost = true;
      first = false;
      warnings.push(`Pages ${w.from} to ${w.to} could not be cut from the file.`);
      continue;
    }
    const { part } = w;
    const window = { pageFrom: part.pageFrom, pageTo: part.pageTo, pagesTotal: part.pagesTotal };
    // Render: the step draws the window's pages (no model). One window's
    // asks are checked against a step's own bound (64 calls); the cap of
    // the manifest holds over the whole file, below.
    const read = await windowJob(async () => {
      const step = await agentStep(pipeline, part.bytes, file, state.options, {
        ...stepInput,
        window,
      });
      const checked = step.status === 'ok' ? checkAsks(windowView, step.asks, step.pictures) : [];
      // A page the step sent as a one-page PDF gets the free evidence of
      // the Scan reader's check, from the book reader's tab Pages; an
      // office page of a PDF drawing (M4) has none to give (no line count).
      const scanned = checked.filter((a) => a.pdf && a.page !== null).map((a) => a.page!);
      const evidence = scanned.length > 0 ? await bookScanEvidenceOf(sqlite, scanned) : null;
      const asks = evidence
        ? checked.map((a) => {
            const e =
              a.pdf && a.page !== null ? (evidence.get(a.page) ?? { lines: null }) : undefined;
            return e ? { ...a, scan: e } : a;
          })
        : checked;
      return { step, asks };
    });
    if (isWindowLost(read)) {
      lost = true;
      first = false;
      warnings.push(`Pages ${part.pageFrom} to ${part.pageTo} could not be read: ${read.lost}`);
      continue;
    }
    const { step, asks } = read;
    if (step.status === 'not_mine') {
      if (first) return { status: 'skipped', reason: 'no-match' };
      continue;
    }
    first = false;
    warnings.push(...step.warnings);
    // The cap of the manifest is for the whole file, over every window, and
    // counts the paid calls only: an ask answered from the tab by its hash
    // costs nothing and always has room.
    const room = asks.filter((a) => {
      if (paidHashes.has(a.hash)) return true;
      const n = asked.get(a.worker) ?? 0;
      if (n >= askCapOf(pipeline, a.worker)) return false;
      asked.set(a.worker, n + 1);
      return true;
    });
    for (const a of asks) seen.add(a.key);
    // Read: each ask from the tab by hash, else one paid call.
    const out = await agentRows(
      tab,
      room,
      stored,
      stopped === undefined ? args.ask : undefined,
      listTab ? { tab: listTab, stored: storedList } : undefined,
    );
    made += out.made;
    reused += out.reused;
    noScanReader += out.skipped ?? 0;
    if (out.stopped !== undefined && out.stopped !== 'no_ask') stopped ??= out.stopped;
    if (room.length < asks.length) stopped ??= 'cap';
    // The asks past the cap keep their stored rows.
    const capped = asks.filter((a) => !room.includes(a));
    const kept = capped.flatMap((a) => stored.filter((r) => String(r.Key ?? '') === a.key));
    if (out.sheet || kept.length > 0) {
      const cols: ParsedSheet['columns'] | undefined = out.sheet?.columns ?? sheet?.columns;
      if (cols) {
        const rows: ParsedSheet['rows'] = [
          ...(out.sheet?.rows ?? []),
          ...kept.map((r) => cols.map((c) => (r[c.name] ?? null) as string | null)),
        ];
        sheet = sheet
          ? { ...sheet, rows: [...sheet.rows, ...rows] }
          : { name: tab, columns: cols, rows };
      }
    }
    // ... and their stored list rows, paid as well.
    const cappedKeys = new Set(capped.map((a) => a.key));
    const keptList = storedList.filter((r) => cappedKeys.has(String(r.Key ?? '')));
    const listOut: ParsedSheet | null = out.listSheet
      ? out.listSheet
      : keptList.length > 0 && listTab
        ? {
            name: listTab,
            columns: AGENT_LIST_COLUMNS.map((name) => ({
              name,
              type: name === AGENT_PAGE_COLUMN ? ('number' as const) : ('text' as const),
            })),
            rows: [],
          }
        : null;
    if (listOut) {
      const rows: ParsedSheet['rows'] = [
        ...listOut.rows,
        ...keptList.map((r) =>
          listOut.columns.map((c) => (r[c.name] ?? null) as string | number | null),
        ),
      ];
      listSheet = listSheet
        ? { ...listSheet, rows: [...listSheet.rows, ...rows] }
        : { ...listOut, rows };
    }
    // Save: the rows so far, before the next window's calls; then the
    // page pictures of the rows that answer them (a row taken from the tab
    // is written already).
    if (out.made > 0) {
      const skipped = await write(false);
      if (skipped) return skipped;
    }
    if (pagePictures) {
      const pictures = windowPagePictures(room, out.sheet);
      if (pictures.length > 0) picturesSaved += await pagePictures.save(pictures);
    }
  }
  const skipped = await write(true);
  if (skipped) return skipped;
  if (noScanReader > 0) {
    warnings.push(
      `${noScanReader} scanned pages are not read: this brain has no Scan reader (an OpenRouter key and the Scan reader worker read them).`,
    );
  }
  if (stopped === undefined && !lost) await countRun(ownerId, pipeline.id, fileId);
  // The file's count of page pictures, from what is saved and marked.
  if (pagePictures) {
    await pagePictures.count().catch((err: unknown) => {
      warnings.push(`the page pictures were not counted: ${errorMessage(err)}`);
    });
  }
  const sheets = [sheet, listSheet].filter((t): t is ParsedSheet => t !== null);
  return {
    status: 'asked',
    rows: sheet?.rows.length ?? 0,
    ...(listTab ? { listRows: listSheet?.rows.length ?? 0 } : {}),
    made,
    reused,
    ...(stopped !== undefined ? { stopped } : lost ? { stopped: 'window_failed' } : {}),
    warnings,
    ...(pagePictures ? { pictures: picturesSaved } : {}),
    // An Agent of page text gives the file's passages by page (P3), not the
    // text of its tab: no copy of every page in the node's data. Only where
    // the file's Reader gives pages too (a book; pagesGiveText).
    text: pagesGiveText(pipeline, sqlite, args.pipelines) ? '' : agentTextOf(sheets),
  };
}

/**
 * The stored rows of an Agent's tab a windowed run keeps over its write:
 * those of the keys no window has asked (`seen`). While the run goes on, or
 * when a window was lost (`keep` 'all'), every one, so no paid row is lost.
 * On the last write of a run that read every window, only the rows of the
 * keys in `keep`: the pages still marked for vision that this run did not
 * ask (past the option `pages`), so
 * their paid text stays, and a page no longer marked goes.
 */
export function keptUnseenRows<R extends Readonly<Record<string, unknown>>>(
  rows: readonly R[],
  seen: ReadonlySet<string>,
  keep: 'all' | ReadonlySet<string>,
): R[] {
  return rows.filter((r) => {
    const key = String(r.Key ?? '');
    return !seen.has(key) && (keep === 'all' || keep.has(key));
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
