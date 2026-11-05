/**
 * Extractor: A table-type file becomes its read-only database, and a Tables workbook on a box that
 * still makes them, before extraction.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { and, eq, sql } from 'drizzle-orm';
import { createPartOfFile, db, nodes, readIndexWork } from '@mantle/db';
import {
  extOf,
  FILE_DB_EXTS,
  fileDbNameExists,
  isFileSha256,
  isParserUnavailable,
} from '@mantle/files';
import { log, recordIngest, step } from '@mantle/tracing';
import { createTable, deleteTable, tableDocFromGrid } from '@mantle/content';
import { buildFileDatabase, parseFileSheets, type ParsedFile } from '@mantle/content/file-database';
import { envNum, feature } from '@mantle/config';
import { errorMessage } from '@mantle/std';
import { loadFileBytes, loadFileHead } from './file-bytes';

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
  if (!FILE_DB_EXTS.has(fileExt)) return;

  // `.xml` is a container, so its place in FILE_DB_EXTS is conditional. Rule
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
  let wantTable = !feature('noAutoTables');
  if (wantTable) {
    // Dedupe: if a table already references this file, do nothing (re-ingest safe).
    const existing = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.type, 'table'),
          sql`${nodes.data}->>'sourceFileId' = ${node.id}`,
        ),
      )
      .limit(1);
    wantTable = existing.length === 0;
  }
  if (!wantDb && !wantTable) return;

  // Bytes that cannot be read give no name, and no retry: a row with truly
  // missing bytes would dead-letter. The rebuild heals it.
  const loaded = await loadFileBytes(node);
  if (!loaded) return;

  const isCad = fileExt === 'dwg' || fileExt === 'dxf';
  let parsed: ParsedFile;
  try {
    parsed = await parseFileSheets(loaded.bytes, fileExt, { tableWanted: wantTable });
  } catch (err) {
    // Not a verdict on the document. With a database wanted, or for a drawing,
    // whose workbook, text digest and image pass all hang off the SAME parser
    // exchange, the whole extract fails and retries: a transient failure here
    // used to vanish, the text pass then succeeded against a recovered service,
    // and the node completed WITHOUT its registry table, permanently and
    // silently. The failure is kept for the rest of this extract (dwg.ts), so no
    // later pass asks again or counts it twice.
    if (wantDb || isCad) throw fatal(err);
    // The parser busy or restarting: the whole extract is retried (gates.ts).
    if (isParserUnavailable(err)) throw err;
    return; // the Table alone: leave it as a plain file, as ever
  }

  if (wantDb) {
    try {
      await step(
        {
          name: 'file_database',
          kind: 'compute',
          input: { filename: loaded.filename, sourceFileId: node.id, parsed: parsed.kind },
        },
        async (h) => {
          const built = await buildFileDatabase({
            fileId: node.id,
            ownerId,
            sha256: data.sha256,
            bytes: loaded.bytes,
            filename: loaded.filename,
            parsed,
          });
          h.setMeta({ ...built });
        },
      );
    } catch (err) {
      // This file has no database until the rebuild, and nothing else changes.
      log('extractor').error(`file database failed for ${node.id}: ${errorMessage(err)}`);
    }
  }
  if (!wantTable || parsed.kind !== 'sheets' || parsed.sheets.length === 0) return;
  const { sheets, description, sourceSha256 } = parsed;

  // One workbook per spreadsheet (v2.1 P2): every usable sheet becomes a TAB
  // of a single table node — no more sibling-table splitting (the client-box
  // sweep's "129 auto-tables" class shrinks by the sheet multiplier). The cap
  // now bounds TABS per workbook; the vestigial part logic is gone (parts
  // were never set post-v2).
  const toTab = sheets.slice(0, MAX_AUTO_TABLE_TABLES);
  const skipped = sheets.length - toTab.length;
  const base =
    loaded.filename.replace(/\.(xlsx|xls|csv|xml|dwf|dwg|dxf)$/i, '').trim() || 'Imported table';
  await step(
    {
      name: 'auto_table',
      kind: 'compute',
      input: {
        filename: loaded.filename,
        grids: sheets.length,
        creating: toTab.length,
        skipped,
        sourceFileId: node.id,
      },
    },
    async (h) => {
      const tabs = toTab
        .map((sheet, i) => ({
          ...tableDocFromGrid(sheet),
          name: (sheet.name || `Sheet${i + 1}`).slice(0, 100),
        }))
        // Skip grids with no usable tabular data (empty / header-only).
        .filter((t) => t.columns.length > 0 && t.rows.length > 0);
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
