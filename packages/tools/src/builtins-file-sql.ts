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
import { fileSqlManyAnswer, type ManyScope } from './file-sql-many';
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
        'This drawing is too large to read into a database. Look at it with dwg_render, if it is a DWG, DXF or DGN.',
      'no-rows':
        'This drawing gave no rows. Look at it with dwg_render, if it is a DWG, DXF or DGN.',
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
  // A PDF gets a database only when it reads as a drawing, a form or a
  // table of data. None of its states is helped by waiting, by a CAD
  // program, or by a rebuild (`--pdf` reads with no model and gives the same
  // answer): its own words, for every state.
  if (ext === 'pdf') {
    if (word === 'unreadable' || word === 'too-large') {
      return `This PDF could not be read as a drawing (${word}), so it has no database. Read its text with file_read.`;
    }
    // No name: a document by the rules, a file from before PDFs were read
    // this way, or one read that failed. `no-rows`: a document by the decider.
    return 'This PDF has no database: it did not read as a drawing, a form or a table of data, or it was not read for one. Read its text with file_read.';
  }
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

/** One tab of a file's database, as `file_sql` with no `sql` lists it. */
export type FileSqlTab = {
  name: string;
  view: string;
  fts_table?: string;
  row_count: number;
  columns: { name: string; type: string }[];
};

/**
 * What `file_sql` answers, for the tool and for the Files route
 * (`POST /api/files/files/:id/database`): one code path, so a person in Files
 * and their agent see the same tabs, rows and words.
 *  - `describe`: the tabs, columns and description;
 *  - `rows`: the rows of one statement;
 *  - `none`: the file has no database, and the words say why;
 *  - `not-found`, `refused`, `bad-sql`: the words say what to do.
 */
export type FileSqlAnswer =
  | {
      kind: 'describe';
      output: {
        file_id: string;
        title: string;
        description?: string;
        tabs: FileSqlTab[];
        hint: string;
      };
    }
  | {
      kind: 'rows';
      output: {
        file_id: string;
        columns: string[];
        rows: unknown[][];
        row_count: number;
        duration_ms: number;
        truncated?: true;
        hint?: string;
      };
    }
  | { kind: 'none' | 'not-found' | 'refused' | 'bad-sql'; message: string };

type Step = ToolHandlerContext['step'];

/** The tabs, columns and description of a file's database. */
async function describe(row: FileDataRow, abs: string, step: Step): Promise<FileSqlAnswer> {
  const tabs = describeWorkbook(abs);
  const meta = await runTableSql(abs, `SELECT v FROM _meta WHERE k = 'description'`, { cap: 1 });
  const description = meta.rows[0]?.[0];
  step?.setOutput({ file_id: row.id, tabs: tabs.length });
  return {
    kind: 'describe',
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
  step: Step,
): Promise<FileSqlAnswer> {
  const r = await runTableSql(abs, sqlText, { cap });
  step?.setOutput({ file_id: row.id, rows: r.rowCount, truncated: r.truncated });
  return {
    kind: 'rows',
    output: {
      file_id: row.id,
      columns: r.columns,
      rows: r.rows as unknown[][],
      row_count: r.rowCount,
      duration_ms: r.durationMs,
      ...(r.truncated
        ? {
            truncated: true as const,
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

/**
 * The one answer of `file_sql`. Rights are the two checks in the file header:
 * the row in the caller's scope, then fileDataRefusal. `tableHint` says
 * whether the words may point at an old Table (mayBePointedAtTable).
 */
/**
 * A file's database for a reader: the two checks in the file header (the row
 * in the caller's scope, then fileDataRefusal), then its path, or the words
 * that say why there is none. `file_sql` and `drawing_redraw` read through it.
 */
export async function readableFileDb(
  ownerId: string,
  fileId: string,
  tableHint: boolean,
): Promise<
  | { ok: true; row: FileDataRow; abs: string }
  | { ok: false; kind: 'not-found' | 'refused' | 'none'; message: string }
> {
  const row = await fileDataRow(ownerId, fileId);
  if (!row) {
    return {
      ok: false,
      kind: 'not-found',
      message: 'file not found: find the right id with file_list or search_nodes, then call again.',
    };
  }
  const refused = await fileDataRefusal(ownerId, row);
  if (refused) return { ok: false, kind: 'refused', message: refused.message };
  const abs = await fileDbSqlitePath(row.id, fileSha256Of(row));
  if (!abs) {
    return {
      ok: false,
      kind: 'none',
      message: await noDatabaseWords(row, tableHint ? { ownerId } : undefined),
    };
  }
  return { ok: true, row, abs };
}

export async function fileSqlAnswer(
  ownerId: string,
  ask: { fileId: string; sql: string; cap: number | undefined },
  opts: { tableHint: boolean; step?: Step },
  again = true,
): Promise<FileSqlAnswer> {
  const got = await readableFileDb(ownerId, ask.fileId, opts.tableHint);
  if (!got.ok) return { kind: got.kind, message: got.message };
  const { row, abs } = got;
  const none = async (): Promise<FileSqlAnswer> => ({
    kind: 'none',
    message: await noDatabaseWords(row, opts.tableHint ? { ownerId } : undefined),
  });
  try {
    return ask.sql.trim()
      ? await query(row, abs, ask.sql, ask.cap, opts.step)
      : await describe(row, abs, opts.step);
  } catch (err) {
    if (await fileDbSqlitePath(row.id, fileSha256Of(row))) {
      return { kind: 'bad-sql', message: readError(err, abs) };
    }
    return again ? fileSqlAnswer(ownerId, ask, opts, false) : none();
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
    'Run one read-only SELECT against an uploaded file\'s own database and return columns + rows; with no `sql`, return its tabs, columns and description. Spreadsheets, CSVs, Project XML and drawings (tabs Texts, Symbols, Placements, Segments, Shapes) have one, built from the file\'s bytes. **For many files pass `file_ids` or `folder`; never loop or copy:** `sql` runs on each file, rows get `_file_id` and `_file`, a file without the tab is skipped and counted, and `then_sql` reads all rows as table `results`, e.g. sql `SELECT "Key" FROM "Placements"`, then_sql `SELECT "Key", count(*) FROM results GROUP BY 1`. A cut answer gives `after`. Double-quote names; **always double-quote FTS MATCH terms.** Saves nothing. For a Table use `table_sql`; for text use `file_read`.',
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "One file's id, from `file_list` or `search_nodes`.",
      },
      file_ids: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        maxItems: 5000,
        description:
          'Many files: run `sql` on each, in this order. Use instead of `file_id` or `folder`.',
      },
      folder: {
        type: 'string',
        description:
          "Many files: every file with a database in this folder, by its path from `folder_list`, e.g. 'files.drawings'.",
      },
      below: {
        type: 'boolean',
        description: 'With `folder`: its sub-folders too.',
        default: false,
      },
      then_sql: {
        type: 'string',
        description:
          'With many files: one SELECT over the rows of `sql` from all files, as table `results`, e.g. SELECT "_file", count(*) FROM results GROUP BY 1.',
      },
      after: {
        type: 'string',
        format: 'uuid',
        description: 'With many files: go on after this file, the `after` of a cut answer.',
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
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    const fileIds = Array.isArray(input.file_ids)
      ? input.file_ids.map((v) => str(v).trim()).filter(Boolean)
      : [];
    const folder = str(input.folder).trim();
    const scopes = [fileId !== '', fileIds.length > 0, folder !== ''].filter(Boolean).length;
    if (scopes !== 1) {
      return fail(
        scopes === 0
          ? 'Name the files: file_id for one, file_ids or folder for many. Find ids with file_list or search_nodes, folders with folder_list.'
          : 'Pass only one of file_id, file_ids and folder.',
      );
    }
    const cap = typeof input.max_rows === 'number' ? input.max_rows : undefined;
    const thenSql = typeof input.then_sql === 'string' ? input.then_sql : undefined;
    const after = str(input.after).trim() || undefined;
    if (!fileId) {
      const sql = str(input.sql);
      if (!sql.trim()) {
        return fail(
          'sql required with file_ids or folder: see the tabs of one file first with file_id and no sql.',
        );
      }
      const scope: ManyScope =
        fileIds.length > 0 ? { fileIds } : { folder, below: input.below === true };
      const many = await fileSqlManyAnswer(
        ctx.ownerId,
        { scope, sql, thenSql, cap, after },
        { step: ctx.step },
      );
      return many.kind === 'rows' ? { ok: true, output: many.output } : fail(many.message);
    }
    if (thenSql !== undefined || after !== undefined) {
      return fail(
        'then_sql and after go with file_ids or folder: for one file, put it all in sql.',
      );
    }
    const got = await fileSqlAnswer(
      ctx.ownerId,
      { fileId, sql: str(input.sql), cap },
      { tableHint: mayBePointedAtTable(ctx), step: ctx.step },
    );
    return 'output' in got ? { ok: true, output: got.output } : fail(got.message);
  },
};

export const FILE_SQL_TOOLS: BuiltinToolDef[] = [file_sql];
