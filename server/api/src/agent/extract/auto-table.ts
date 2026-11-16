/**
 * Extractor: A table-type file becomes its read-only database, and a Tables workbook on a box that
 * still makes them, before extraction.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { createPartOfFile, nodes, readIndexWork } from '@mantle/db';
import {
  extOf,
  fileDbNameExists,
  isCadExt,
  isFileSha256,
  isParserError,
  isParserUnavailable,
  tableNamingFile,
} from '@mantle/files';
import { log, recordIngest, step, type StepHandle } from '@mantle/tracing';
import { createTable, deleteTable } from '@mantle/content';
import {
  buildFileDatabase,
  parseFileSheets,
  readFileRowNow,
  tabsOfSheets,
  type ParsedFile,
} from '@mantle/content/file-database';
import { boxPipelines, type BoxPipelines } from '@mantle/content/pipeline-registry';
import { pipelineOffHere, pipelineStateOf } from '@mantle/content/pipeline-state';
import { envNum, feature } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { loadFileBytes, loadFileHead } from './file-bytes';
import { askPdfKind } from './pdf-kind';
import { askReaderVision } from './reader-vision';
import { inOwnTrace } from './trace';

/** Max TABLES a single auto-import will create (sheets × paginated parts). Each
 *  table is its own indexed node, so a huge or many-sheet workbook would fan out
 *  into a burst of extractor runs from one upload. Beyond this we create the
 *  leading tables and log the rest as skipped (the source file stays fully
 *  searchable). An explicit `table_from_file` is user-initiated, not capped. */
const MAX_AUTO_TABLE_TABLES = envNum('MANTLE_MAX_AUTO_TABLE_TABLES');

/** This row's extract has not finished. The stamp alone is not enough (a very
 *  old row, and a first upload, carry none), and neither is the missing marker
 *  (a flip back to full keeps it and sets the stamp). */
function extractPending(data: Record<string, unknown>): boolean {
  if (readIndexWork(data) === 'extract') return true;
  return !data.extract_completed_at && !data.extract_skipped && !data.extract_parked;
}

/** Why a failure is thrown past the side pass: the whole extract is retried. */
function fatal(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  return Object.assign(e, { fatalToExtract: true });
}

/**
 * On ingest, read a table-type file once and give it what it lacks: its
 * read-only database (packages/content/src/file-database.ts), and, on a box
 * without MANTLE_NO_AUTO_TABLES, a Table, so registers land in /tables however
 * the file arrived (Files upload, chat attachment, email/Telegram).
 *
 * A file wants a database only while its extract is pending, with a valid
 * sha256 and no name for those bytes. So a title change on an old file costs
 * nothing, and an old file gets its database only from the rebuild or from new
 * bytes. It wants a Table when no Table names it (`data.sourceFileId`: a
 * re-ingest never makes a second one). With neither wanted: no read, no parser
 * call.
 *
 * The Table's tabs mirror the `table_from_file` tool's core
 * (parseSheetToGrid → tableDocFromGrid → createTable) so manual and automatic
 * imports yield identical grids.
 *
 * Isolated: a failed database write is logged and the Table still lands, and a
 * failed Table throws to the caller, which logs it, with the database already
 * written. A failed read is the exception. With a database wanted, an error
 * that is no verdict on the document fails the whole extract, so the pg-boss
 * retry heals every pass together before any model runs.
 */
export async function maybeAutoTableSpreadsheet(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<void> {
  if (node.type !== 'file') return;
  const data = (node.data ?? {}) as Record<string, unknown>;
  const nameForExt = typeof data.filename === 'string' ? data.filename : node.title;
  const fileExt = extOf(nameForExt);
  // The box's pipelines (the registry): the file types that get a database
  // and the reader of this one.
  const pipelines = await boxPipelines(ownerId);
  if (!pipelines.dbExts.has(fileExt)) return;

  // `.xml` is a container, so its place in the box's `dbExts` is conditional. Rule
  // out the ~99% that aren't plans from the first 8 KB, before the dedupe query
  // and before reading the file — under the 64 MB cap the alternative is a whole
  // file read to answer a question the root element already answers.
  //
  // Only the ROOT check is safe this early. The full sniff's second signal is
  // the namespace OR a `<Tasks>` element, and `<Tasks>` is not near the top: in a
  // real 25 MB export it sat at byte 114,966. A head-scoped full sniff would
  // answer false for a namespace-less plan and silently skip it.
  if (fileExt === 'xml') {
    const head = await loadFileHead(node);
    // An unreadable head is not evidence — fall through and let the full path
    // decide, exactly as it did before.
    if (head && !(await import('@mantle/files/mspdi-sniff')).mspdiRootPresent(head)) return;
  }

  const wantDb =
    extractPending(data) &&
    isFileSha256(data.sha256) &&
    !(await fileDbNameExists(node.id, data.sha256));
  // A PDF never makes a Table: one that reads as a drawing gets a database,
  // any other gets nothing here (the plan, dev-brain page 11a16779, 10.1).
  const isPdf = fileExt === 'pdf';
  // Dedupe: if a table already references this file, do nothing (re-ingest safe).
  const wantTable =
    !isPdf && !feature('noAutoTables') && (await tableNamingFile(ownerId, node.id)) === null;
  if (!wantDb && !wantTable) return;

  // The read and what it writes run in a trace: the one open, if any, else
  // one of their own, opened here BEFORE the read (an upload's pass runs in
  // the admission, gates.ts, before the extract's trace opens), so every
  // step made during it lands there: `file_database`, `auto_table`, and the
  // decider's `decide_pdf_kind` with its cost. Its kind is `pipeline_run`,
  // never `extractor_run`: this runs before the extract, and a reader of
  // extracts (the sweep's `noExtractSinceWriteSql`, the integrity checks)
  // must not take it for one. `source: 'upload'` tells it from a run on
  // demand. Ids and fixed words only: no file name.
  await inOwnTrace(
    ownerId,
    node,
    { fileId: node.id, source: 'upload', pass: 'file_database' },
    () => readAndWrite({ node, ownerId, data, fileExt, isPdf, wantDb, wantTable, pipelines }),
  );
}

/** The read of {@link maybeAutoTableSpreadsheet} and its writes, once a
 *  database or a Table is wanted. Its steps go to the trace in context. */
async function readAndWrite(a: {
  node: typeof nodes.$inferSelect;
  ownerId: string;
  data: Record<string, unknown>;
  fileExt: string;
  isPdf: boolean;
  wantDb: boolean;
  wantTable: boolean;
  pipelines: BoxPipelines;
}): Promise<void> {
  const { node, ownerId, data, fileExt, isPdf, wantDb, wantTable, pipelines } = a;

  // The reader's off list (docs/pipelines.md, "Where a pipeline runs"): the
  // one automatic read of a file's database is here, so the test is here,
  // before the bytes, any parser job and the PDF router. A reader that is off
  // in the file's home workspace reads nothing: no database, no word, no
  // decider call, and no Table (a Table is made of this same read). The
  // text and the pictures of the file come from their own passes, as
  // before. One reader claims each extension, the kinds of a PDF too
  // (builtin.test.ts), so the reader of the extension is the one to ask.
  const reader = pipelines.readerFor(fileExt);

  // The steps of this pass. Ids, fixed words and numbers only: no file name
  // and no cell.
  const stepOf = <T>(
    name: 'file_database' | 'auto_table',
    input: Record<string, unknown>,
    body: (h: StepHandle) => Promise<T>,
  ) => step({ name, kind: 'compute', input: { sourceFileId: node.id, ...input } }, body);
  /** The `file_database` step of a read that built nothing: why. */
  const noDatabase = (meta: { status: 'skipped' | 'failed'; reason: string; readMs?: number }) =>
    stepOf('file_database', {}, async (h) => {
      h.setMeta({ pipeline: reader?.id ?? null, ...meta });
      if (meta.status === 'failed') h.setError(meta.reason);
    });

  const state = reader ? await pipelineStateOf(ownerId, reader) : null;
  if (state && pipelineOffHere(state, (await readFileRowNow(node.id, ownerId))?.home ?? null)) {
    if (wantDb) await noDatabase({ status: 'skipped', reason: 'off' });
    return;
  }

  // Bytes that cannot be read give no name, and no retry: a row with truly
  // missing bytes would dead-letter. The rebuild heals it.
  const loaded = await loadFileBytes(node);
  if (!loaded) {
    if (wantDb) await noDatabase({ status: 'skipped', reason: 'no-bytes' });
    return;
  }

  const isCad = isCadExt(fileExt);
  // The box's options of the reader (a PDF's title block), from the one read
  // of its state above, so the rows and the stamp's hash follow them. A
  // reader with no options sends none, as an extract always did.
  const options =
    reader && state && Object.keys(reader.options ?? {}).length > 0 ? state.options : undefined;
  let parsed: ParsedFile;
  const readStart = Date.now();
  try {
    parsed = await parseFileSheets(loaded.bytes, fileExt, {
      pipelines,
      ...(options ? { options } : {}),
      // The decider, for a PDF the rules left unsure: at most one call, and
      // only here, where `wantDb` says these bytes have no database yet.
      ...(isPdf ? { pdfKind: (state) => askPdfKind(ownerId, node.id, state) } : {}),
      // An own Reader's vision asks (at most its needs.workers.vision), on
      // the same terms: only here, only while these bytes have no database.
      ...(wantDb
        ? { readerAsk: (call, pictures) => askReaderVision(ownerId, node.id, call, pictures) }
        : {}),
      // An upload is a real read: the PDF router's run counts.
      count: { ownerId, fileId: node.id },
    });
  } catch (err) {
    if (wantDb) {
      await noDatabase({
        status: 'failed',
        reason: isParserError(err) ? err.code : 'error',
        readMs: Date.now() - readStart,
      });
    }
    // Not a verdict on the document. With a database wanted, or for a drawing,
    // whose workbook, text digest and image pass all hang off the SAME parser
    // exchange, the whole extract fails and retries: a transient failure here
    // used to vanish, the text pass then succeeded against a recovered service,
    // and the node completed WITHOUT its registry table, permanently and
    // silently. The failure is kept for the rest of this extract (dwg.ts), so no
    // later pass asks again or counts it twice.
    // A PDF is the exception: its text, pictures and summary do not hang off
    // this read, so a failure here never holds them back. It is logged and
    // the file keeps no name. This extract then completes, so nothing reads
    // the file again by itself: a person's re-extract or the person-run
    // `dwg-reindex --pdf` does (a second counted failure of the same bytes
    // is then the parser's verdict, and the file gets its word).
    if (isPdf && !isParserUnavailable(err)) {
      log('extractor').error(`pdf drawing read failed for ${node.id}: ${errorMessage(err)}`);
      return;
    }
    if (wantDb || isCad) throw fatal(err);
    // The parser busy or restarting: the whole extract is retried (gates.ts).
    if (isParserUnavailable(err)) throw err;
    return; // the Table alone: leave it as a plain file, as ever
  }
  const readMs = Date.now() - readStart;

  if (wantDb) {
    try {
      await stepOf('file_database', { parsed: parsed.kind }, async (h) => {
        // `failed` until the build gives its own status.
        h.setMeta({ pipeline: reader?.id ?? null, status: 'failed', readMs });
        const built = await buildFileDatabase({
          fileId: node.id,
          ownerId,
          sha256: data.sha256,
          bytes: loaded.bytes,
          filename: loaded.filename,
          parsed,
          pipelines,
        });
        h.setMeta({ ...built });
      });
    } catch (err) {
      // This file has no database until the rebuild, and nothing else changes.
      log('extractor').error(`file database failed for ${node.id}: ${errorMessage(err)}`);
    }
  }
  if (!wantTable || parsed.kind !== 'sheets' || parsed.sheets.length === 0) return;
  // The caller read the indexing before this parse, which can be long. A file
  // that turned private since gets no Table, as it gets no database. A row gone
  // since is the part's own refusal, below.
  if ((await readFileRowNow(node.id, ownerId))?.isPrivate) return;
  const { sheets, description, sourceSha256 } = parsed;

  // One workbook per spreadsheet (v2.1 P2): every usable sheet becomes a TAB
  // of a single table node — no more sibling-table splitting (the client-box
  // sweep's "129 auto-tables" class shrinks by the sheet multiplier). The cap
  // now bounds TABS per workbook; the vestigial part logic is gone (parts
  // were never set post-v2).
  const toTab = sheets.slice(0, MAX_AUTO_TABLE_TABLES);
  const skipped = sheets.length - toTab.length;
  const base =
    loaded.filename
      .replace(new RegExp(`\\.(${[...pipelines.dbExts].join('|')})$`, 'i'), '')
      .trim() || 'Imported table';
  await stepOf(
    'auto_table',
    { grids: sheets.length, creating: toTab.length, skipped },
    async (h) => {
      const tabs = tabsOfSheets(toTab);
      if (tabs.length === 0) {
        h.setMeta({ created: 0, skipped });
        return [];
      }
      // A part of the file: its home and grants, once (docs/workspaces.md).
      const table = await createPartOfFile(
        node.id,
        () =>
          createTable(ownerId, {
            title: base.slice(0, 200),
            tabs,
            tags: ['auto-import'],
            sourceFileId: node.id,
            ...(sourceSha256 ? { sourceSha256 } : {}),
            ...(description ? { description } : {}),
          }),
        (t) => deleteTable(ownerId, t.id),
      );
      void recordIngest({
        source: 'extractor',
        ownerId,
        nodeId: table.id,
        summary: `Auto-imported table from ${loaded.filename} (${tabs.length} tab${tabs.length === 1 ? '' : 's'}): ${table.title}`,
        payload: {
          via: 'auto_table_on_ingest',
          sourceFileId: node.id,
          tabs: tabs.map((t) => t.name),
        },
      });
      h.setMeta({ created: 1, tableIds: [table.id], tabs: tabs.length, skipped });
      return [table.id];
    },
  );
}

// ─── embedded images ──────────────────────────────────────────────────
