/**
 * file_sql: one read-only SELECT over a table-type file's own database, or with
 * no `sql` its tabs, columns and description. The database is built from the
 * file's bytes (packages/content/src/file-database.ts) and nobody edits it.
 *
 * Rights are the file row, read in the caller's scope first, and then the one
 * refusal every reader of a file's rows shares (@mantle/files file-data.ts). The
 * statement rules are table_sql's, as it is the same runner: ATTACH and PRAGMA
 * refused, one statement, the row cap.
 *
 * Every other answer says why there are no rows, in a fixed order (noDatabase).
 * A name can go during a read (a replace, a flip to private), and a missing file
 * would name its path, so a read error with the name gone goes back through the
 * list. A path never reaches the reply. The rows are the uploader's, so the
 * result is fenced as data.
 */
import {
  fileDataExt,
  fileDataRefusal,
  fileDataRow,
  extractorRefusesFile,
  fileDbSqlitePath,
  fileSha256Of,
  filesRoot,
  filesRootMounted,
  loadFileHead,
  readFileDbNone,
  tableNamingFile,
  type FileDataRow,
  type FileDbNoneWord,
} from '@mantle/files';
import { mspdiRootPresent } from '@mantle/files/mspdi-sniff';
import {
  SQL_ROW_CAP_DEFAULT,
  SQL_ROW_CAP_MAX,
  describeWorkbook,
  importMaxRows,
  runTableSql,
} from '@mantle/tabledb';
import { errorMessage } from '@mantle/std';
import { FILE_ID_PRE } from './builtins-common';
import { str } from './coerce';
import type { BuiltinToolDef, ToolHandlerContext, ToolHandlerResult } from './types';

const fail = (error: string): ToolHandlerResult => ({ ok: false, error });

/** What a file of this extension is, for the words of its `.none`. */
function kindOf(ext: string): 'workbook' | 'csv' | 'plan' | 'drawing' {
  if (ext === 'csv') return 'csv';
  if (ext === 'xml') return 'plan';
  return ext === 'xlsx' || ext === 'xls' ? 'workbook' : 'drawing';
}

/**
 * Why a file's `.none` says there are no rows. No "call again": the word stays
 * until new bytes or a rebuild replace it. One word covers the 32 MB ceiling of
 * sheet XML and the row cap, and only the ceiling is helped by a CSV, so a
 * workbook is told both.
 */
function noneReason(word: FileDbNoneWord, ext: string): string {
  const cap = importMaxRows().toLocaleString('en-US');
  const words: Record<ReturnType<typeof kindOf>, Record<FileDbNoneWord, string>> = {
    workbook: {
      'too-large': `This workbook is too large to read: past 32 MB of sheet XML, or past ${cap} rows. Under ${cap} rows, save it as CSV and upload that. Past them, split it into smaller files.`,
      'no-rows':
        'This workbook has no rows to read: no sheet has both a header and data. Read its text with file_read.',
      unreadable:
        'This workbook could not be read: it may be encrypted or damaged. Save an open copy and upload that.',
    },
    csv: {
      'too-large': `This CSV is too large to read: past the size limit, or past ${cap} rows. Split it into smaller files and upload those.`,
      'no-rows':
        'This CSV has no rows to read: it needs both a header and data. Read its text with file_read.',
      unreadable:
        'This CSV could not be read: it may have a stray quote or broken rows. Fix it and upload it again.',
    },
    plan: {
      'too-large':
        'This plan is too large to read. Export a smaller part of it from Microsoft Project and upload that.',
      'no-rows':
        'This XML has a Microsoft Project root, but no plan could be read from it. Read its text with file_read.',
      unreadable:
        'This plan could not be read: it may be damaged. Export it from Microsoft Project again and upload that.',
    },
    drawing: {
      'too-large':
        'This drawing is too large to read into a database. Look at it with dwg_render, if it is a DWG or DXF.',
      'no-rows': 'This drawing gave no rows. Look at it with dwg_render, if it is a DWG or DXF.',
      unreadable:
        'This drawing could not be read: it may be damaged. Save it again from the CAD program and upload that.',
    },
  };
  return words[kindOf(ext)][word];
}

/**
 * The answer when a file has no database, in its order (build spec E, with rounds
 * 10 and 11): each one only after the ones above it. `tableHint` names the Table
 * that holds the rows: left out for a caller who cannot use it (mayBePointedAtTable),
 * and the tracer reads that Table by itself.
 */
export async function noDatabaseWords(
  row: FileDataRow,
  tableHint?: { ownerId: string },
): Promise<string> {
  // First: with no mount, no answer below says anything about this file.
  if (!(await filesRootMounted())) {
    return 'File databases cannot be read in this process: the files folder is not mounted here. Call this from a chat turn, not a background run.';
  }
  const ext = fileDataExt(row);
  if (ext === 'xml') {
    // A head that cannot be read is not evidence: the list goes on.
    const head = await loadFileHead(row);
    if (head && !mspdiRootPresent(head)) {
      return 'This XML is not a Microsoft Project plan. Read its text with file_read.';
    }
  }
  const word = await readFileDbNone(row.id, fileSha256Of(row));
  if (word) return noneReason(word, ext);
  // For the time between the release and the backfill.
  if (tableHint) {
    const tableId = await tableNamingFile(tableHint.ownerId, row.id);
    if (tableId) {
      return `Its rows are in Table ${tableId}: use table_sql. This Table may hold an older version of the file.`;
    }
  }
  if (extractorRefusesFile(row)) {
    return 'This file was not read into the brain, so it has no database.';
  }
  return 'No database yet. If it was just uploaded, call again. If not, ask an owner to run the rebuild.';
}

/** Whether this caller could use a pointer to a Table: no app reads one, and a
 *  key limited to other areas cannot call table_sql. */
function mayBePointedAtTable(ctx: ToolHandlerContext): boolean {
  if (ctx.caller?.entry === 'app') return false;
  const areas = (ctx.caller?.gate?.facts?.keyAreas ?? null) as readonly string[] | null;
  return areas === null || areas.includes('tables');
}

const noDatabase = async (row: FileDataRow, ctx: ToolHandlerContext): Promise<ToolHandlerResult> =>
  fail(await noDatabaseWords(row, mayBePointedAtTable(ctx) ? ctx : undefined));

/** The tabs, columns and description of a file's database. */
async function describe(row: FileDataRow, abs: string, ctx: ToolHandlerContext) {
  const tabs = describeWorkbook(abs);
  const meta = await runTableSql(abs, `SELECT v FROM _meta WHERE k = 'description'`, { cap: 1 });
  const description = meta.rows[0]?.[0];
  ctx.step?.setOutput({ file_id: row.id, tabs: tabs.length });
  return {
    ok: true as const,
    output: {
      file_id: row.id,
      title: row.title,
      ...(typeof description === 'string' ? { description } : {}),
      tabs: tabs.map((t) => ({
        name: t.name,
        view: t.viewName,
        ...(t.ftsTable ? { fts_table: t.ftsTable } : {}),
        row_count: t.rowCount,
        columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      })),
      hint: 'Query a view with file_sql and `sql`: double-quote names, and double-quote FTS MATCH terms.',
    },
  };
}

/** The rows of one statement. */
async function query(
  row: FileDataRow,
  abs: string,
  sqlText: string,
  cap: number | undefined,
  ctx: ToolHandlerContext,
) {
  const r = await runTableSql(abs, sqlText, { cap });
  ctx.step?.setOutput({ file_id: row.id, rows: r.rowCount, truncated: r.truncated });
  return {
    ok: true as const,
    output: {
      file_id: row.id,
      columns: r.columns,
      rows: r.rows,
      row_count: r.rowCount,
      duration_ms: r.durationMs,
      ...(r.truncated
        ? {
            truncated: true,
            hint: `Result cut at ${r.rowCount} rows: narrow with WHERE, or aggregate (count/GROUP BY) instead of listing.`,
          }
        : {}),
    },
  };
}

/** A read error in the caller's words: this tool's name, and no path. */
function readError(err: unknown, abs: string): string {
  return errorMessage(err)
    .replaceAll(abs, 'the database')
    .replaceAll(filesRoot(), 'the files folder')
    .replace(/\btable_sql\b/g, 'file_sql');
}

async function answer(
  ctx: ToolHandlerContext,
  ask: { fileId: string; sql: string; cap: number | undefined },
  again = true,
): Promise<ToolHandlerResult> {
  const row = await fileDataRow(ctx.ownerId, ask.fileId);
  if (!row) {
    return fail(
      'file not found: find the right id with file_list or search_nodes, then call again.',
    );
  }
  const refused = await fileDataRefusal(ctx.ownerId, row);
  if (refused) return fail(refused.message);
  const abs = await fileDbSqlitePath(row.id, fileSha256Of(row));
  if (!abs) return noDatabase(row, ctx);
  try {
    return ask.sql.trim()
      ? await query(row, abs, ask.sql, ask.cap, ctx)
      : await describe(row, abs, ctx);
  } catch (err) {
    if (await fileDbSqlitePath(row.id, fileSha256Of(row))) return fail(readError(err, abs));
    return again ? answer(ctx, ask, false) : noDatabase(row, ctx);
  }
}

export const file_sql: BuiltinToolDef = {
  slug: 'file_sql',
  policy: {
    matrix: { action: 'read', param: 'file_id', kinds: ['file'] },
    effect: 'read',
    spends: 'none',
    scope: 'any',
    keyArea: 'files',
    // The rows are the uploader's: fenced as data (the header says why).
    outside: { untrusted: true },
  },
  preconditions: FILE_ID_PRE,
  name: 'Query a file with SQL',
  description:
    "Run one read-only SELECT against an uploaded file's own database and return columns + rows; with no `sql`, return its tabs, columns and description. Spreadsheets, CSVs, Microsoft Project XML and drawings (DWG, DXF, DWF) each have one, built from the file's bytes: new bytes make a new one, and nobody edits its rows. Query a tab's view with double-quoted names. **Always double-quote FTS MATCH terms.** If there are no rows, the reply says why. Saves nothing. For a Table in Tables use `table_sql`; for a file's text use `file_read`.",
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The file's id, from `file_list` or `search_nodes`.",
      },
      sql: {
        type: 'string',
        description: `One SELECT/WITH statement, e.g. SELECT "Status", count(*) FROM "Circuits" GROUP BY "Status". Leave it out to see the tabs and columns.`,
      },
      max_rows: {
        type: 'number',
        description: 'Row cap for the result.',
        default: SQL_ROW_CAP_DEFAULT,
        minimum: 1,
        maximum: SQL_ROW_CAP_MAX,
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    if (!fileId) return fail('file_id required: find it with file_list or search_nodes.');
    return answer(ctx, {
      fileId,
      sql: str(input.sql),
      cap: typeof input.max_rows === 'number' ? input.max_rows : undefined,
    });
  },
};

export const FILE_SQL_TOOLS: BuiltinToolDef[] = [file_sql];
