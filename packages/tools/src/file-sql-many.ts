/**
 * file_sql over many files: one read-only statement on each file's database,
 * one file at a time, the rows of all of them in one answer, and with
 * `then_sql` one more statement over those rows as table `results`. Nothing is
 * copied and nothing is written to disk.
 *
 * Each file is one statement on the reader pool (@mantle/tabledb sql-runner),
 * and the reader goes back to the pool before the next file. So one call holds
 * at most one reader, and a short read (the Data view, another file_sql) that
 * waits in the queue gets the next free reader between two files. The pool's
 * own limits hold for every statement: the reader limit, the time limit, the
 * memory limit and the reply cap.
 *
 * Rights are the single file's two checks, in batch (@mantle/files
 * file-data.ts): the rows in the caller's scope, then fileDataRefusals. A file
 * that fails one is skipped and counted under its word, by id only. A folder is
 * read in the caller's scope, so a file the caller cannot see is not counted.
 *
 * The caps stop a call with the rows so far, `truncated` and `after`, the
 * continue token: the last file done. A call never loops on one file: a file
 * cut at the row cap is done, and the hint names it.
 */
import { envNum } from '@mantle/config';
import {
  DATA_FILES_UNDER,
  fileDataRefusals,
  fileDataRows,
  fileDataRowsIn,
  fileDbSqlitePath,
  fileSha256Of,
  filesRoot,
  filesRootMounted,
  folderByPath,
  type FileDataRow,
} from '@mantle/files';
import {
  SQL_ROW_CAP_DEFAULT,
  SQL_ROW_CAP_MAX,
  TABLE_SQL_MAX_REPLY_BYTES,
  TableSqlError,
  assertReadOnlySelect,
  runReadOnlySql,
} from '@mantle/tabledb';
import { errorMessage } from '@mantle/std';
import type { ToolHandlerContext } from './types';

/** The most files one call takes, read or skipped. */
export const FILE_SQL_FILES_MAX = 300;
/** The most rows collected for `then_sql`. */
export const FILE_SQL_COLLECT_ROWS_MAX = 50_000;
/** The most bytes collected, about: the reply cap of one file. */
export const FILE_SQL_COLLECT_BYTES_MAX = TABLE_SQL_MAX_REPLY_BYTES;
/** The two columns put in front of every row. */
export const FILE_SQL_FILE_COLUMNS = ['_file_id', '_file'] as const;
/** The most ids listed under one skip word. */
const SKIP_IDS_MAX = 20;
/** Less time than this left: no next file. */
const MIN_FILE_MS = 50;

/** Why a file gave no rows, in the order the answer lists them. */
export const SKIP_WORDS = [
  'not-found',
  'no-access',
  'not-table',
  'no-database',
  'no-such-table',
  'timeout',
  'too-large',
] as const;
export type SkipWord = (typeof SKIP_WORDS)[number];

export type ManyScope = { fileIds: string[] } | { folder: string; below: boolean };

export type FileSqlManyOutput = {
  files: { done: number; read: number; left: number };
  columns: string[];
  rows: unknown[][];
  row_count: number;
  duration_ms: number;
  skipped?: { reason: SkipWord; count: number; file_ids: string[] }[];
  truncated?: true;
  after?: string;
  hint?: string;
};

export type FileSqlManyAnswer =
  | { kind: 'rows'; output: FileSqlManyOutput }
  | { kind: 'not-found' | 'bad-sql' | 'none'; message: string };

type Step = ToolHandlerContext['step'];

/** About what a row costs once serialized, as the reader counts it. */
function rowBytes(row: readonly unknown[]): number {
  let n = 2;
  for (const v of row) {
    if (v === null || v === undefined) n += 4;
    else if (typeof v === 'string') n += Buffer.byteLength(v) + 2;
    else if (v instanceof Uint8Array) n += v.byteLength;
    else n += 8;
  }
  return n;
}

/** An engine error in the caller's words: this tool's name, and no path. */
function sqlWords(err: unknown, abs?: string): string {
  let text = errorMessage(err);
  if (abs) text = text.replaceAll(abs, 'the database');
  return text.replaceAll(filesRoot(), 'the files folder').replace(/\btable_sql\b/g, 'file_sql');
}

const NO_SUCH = /\bno such (table|column)\b/i;

/** The files of the scope after `after`, at most FILE_SQL_FILES_MAX, with the
 *  ids the caller named and cannot read, and how many are left past them. */
async function filesOf(
  ownerId: string,
  scope: ManyScope,
  after: string | undefined,
): Promise<
  | { ok: true; rows: FileDataRow[]; notFound: string[]; left: number }
  | { ok: false; message: string }
> {
  if ('fileIds' in scope) {
    const ids = [...new Set(scope.fileIds)];
    let start = 0;
    if (after) {
      const at = ids.indexOf(after);
      if (at < 0) {
        return {
          ok: false,
          message: `after must be a file id from file_ids, as the last answer gave it (got '${after.slice(0, 60)}').`,
        };
      }
      start = at + 1;
    }
    const window = ids.slice(start, start + FILE_SQL_FILES_MAX);
    const byId = new Map(
      (await fileDataRows(ownerId, window, { full: false })).map((r) => [r.id, r]),
    );
    // In the caller's order; an id with no row is named back as given.
    const rows: FileDataRow[] = [];
    const notFound: string[] = [];
    for (const id of window) {
      const row = byId.get(id);
      if (row) rows.push(row);
      else notFound.push(id);
    }
    return { ok: true, rows, notFound, left: ids.length - start - window.length };
  }
  if (!DATA_FILES_UNDER.test(scope.folder)) {
    return {
      ok: false,
      message: `folder must be a folder path from folder_list, e.g. 'files.drawings' (got '${scope.folder.slice(0, 80)}').`,
    };
  }
  if (!(await folderByPath({ ownerId, path: scope.folder }))) {
    return {
      ok: false,
      message: `folder '${scope.folder}' not found: find its path with folder_list, then call again.`,
    };
  }
  const got = await fileDataRowsIn(ownerId, scope.folder, {
    below: scope.below,
    after,
    limit: FILE_SQL_FILES_MAX,
  });
  const total = got[0]?.total ?? 0;
  return { ok: true, rows: got, notFound: [], left: Math.max(0, total - got.length) };
}

/** Why a call stopped before its last file, for the hint. */
type Stop = 'rows' | 'bytes' | 'time' | 'busy' | 'files';

/**
 * The one answer of file_sql over many files. `cap` is the row cap of the
 * answer (`max_rows`): of the collected rows with no `then_sql`, of its
 * result with one.
 */
export async function fileSqlManyAnswer(
  ownerId: string,
  ask: {
    scope: ManyScope;
    sql: string;
    thenSql?: string;
    cap?: number;
    after?: string;
  },
  opts: { step?: Step } = {},
): Promise<FileSqlManyAnswer> {
  const started = Date.now();
  const deadline = started + envNum('FILE_SQL_MANY_MS');
  // A statement the runner would refuse fails at once, before any file.
  try {
    assertReadOnlySelect(ask.sql);
    if (ask.thenSql !== undefined) assertReadOnlySelect(ask.thenSql);
  } catch (err) {
    return { kind: 'bad-sql', message: sqlWords(err) };
  }
  if (!(await filesRootMounted())) {
    return {
      kind: 'none',
      message:
        'File databases cannot be read in this process: the files folder is not mounted here. Call this from a chat turn, not a background run.',
    };
  }
  const listed = await filesOf(ownerId, ask.scope, ask.after);
  if (!listed.ok) return { kind: 'not-found', message: listed.message };

  const answerCap = Math.max(1, Math.min(ask.cap ?? SQL_ROW_CAP_DEFAULT, SQL_ROW_CAP_MAX));
  const rowCap = ask.thenSql !== undefined ? FILE_SQL_COLLECT_ROWS_MAX : answerCap;

  const skipped = new Map<SkipWord, string[]>();
  const skip = (word: SkipWord, id: string) => {
    const ids = skipped.get(word) ?? [];
    ids.push(id);
    skipped.set(word, ids);
  };
  for (const id of listed.notFound) skip('not-found', id);
  const refused = await fileDataRefusals(ownerId, listed.rows);

  const columns: string[] = [...FILE_SQL_FILE_COLUMNS];
  const at = new Map<string, number>(columns.map((c, i) => [c, i]));
  const rows: unknown[][] = [];
  let bytes = 0;
  let read = 0;
  let done = listed.notFound.length;
  let lastDone: string | undefined = listed.notFound.at(-1);
  let stop: Stop | undefined;
  let cutFile: string | undefined;

  for (const row of listed.rows) {
    const refusal = refused.get(row.id);
    if (refusal) {
      skip(refusal.code === 'not-table-type' ? 'not-table' : 'no-access', row.id);
    } else {
      const abs = await fileDbSqlitePath(row.id, fileSha256Of(row));
      if (!abs) {
        skip('no-database', row.id);
      } else {
        const left = deadline - Date.now();
        if (left < MIN_FILE_MS) {
          stop = 'time';
          break;
        }
        let got: Awaited<ReturnType<typeof runReadOnlySql>>;
        try {
          got = await runReadOnlySql({ file: abs }, ask.sql, {
            cap: rowCap - rows.length,
            maxReplyBytes: FILE_SQL_COLLECT_BYTES_MAX - bytes,
            limitMs: left,
          });
        } catch (err) {
          const code = err instanceof TableSqlError ? err.code : 'missing';
          if (code === 'busy') {
            stop = 'busy';
            break;
          }
          if (code === 'too-big' && rows.length > 0) {
            stop = 'bytes';
            break;
          }
          if (code === 'timeout' && deadline - Date.now() < MIN_FILE_MS) {
            stop = 'time';
            break;
          }
          if (code === 'sql' && !NO_SUCH.test(errorMessage(err))) {
            return {
              kind: 'bad-sql',
              message: `${sqlWords(err, abs)} (file ${row.id}). Fix the statement and call again.`,
            };
          }
          skip(
            code === 'sql'
              ? 'no-such-table'
              : code === 'timeout'
                ? 'timeout'
                : code === 'missing'
                  ? 'no-database'
                  : 'too-large',
            row.id,
          );
          done++;
          lastDone = row.id;
          continue;
        }
        const name = typeof row.data?.filename === 'string' ? row.data.filename : row.title;
        for (const c of got.columns) {
          if ((FILE_SQL_FILE_COLUMNS as readonly string[]).includes(c)) {
            return {
              kind: 'bad-sql',
              message: `The statement returns a column named ${c}, and file_sql adds that column to every row. Rename it with AS and call again.`,
            };
          }
          if (!at.has(c)) {
            at.set(c, columns.length);
            columns.push(c);
          }
        }
        const index = got.columns.map((c) => at.get(c)!);
        for (const r of got.rows) {
          const out: unknown[] = [row.id, name];
          r.forEach((v, i) => (out[index[i]!] = v));
          bytes += rowBytes(out);
          rows.push(out);
        }
        read++;
        if (got.truncated) {
          cutFile = row.id;
          stop = 'rows';
        }
      }
    }
    done++;
    lastDone = row.id;
    if (stop || rows.length >= rowCap) break;
  }
  // A column first seen in a later file: null in the rows before it.
  for (const r of rows) {
    for (let i = 0; i < columns.length; i++) if (r[i] === undefined) r[i] = null;
  }

  const total = listed.rows.length + listed.notFound.length + listed.left;
  const left = total - done;
  if (!stop && left > 0) stop = rows.length >= rowCap ? 'rows' : 'files';

  let outColumns = columns;
  let outRows = rows;
  let outerCut = false;
  if (ask.thenSql !== undefined) {
    try {
      const outer = await runReadOnlySql({ results: { columns, rows } }, ask.thenSql, {
        cap: answerCap,
        limitMs: Math.max(MIN_FILE_MS, deadline - Date.now()),
      });
      outColumns = outer.columns;
      outRows = outer.rows;
      outerCut = outer.truncated;
    } catch (err) {
      if (err instanceof TableSqlError && err.code === 'busy') {
        return { kind: 'none', message: sqlWords(err) };
      }
      const hint =
        rows.length === 0
          ? ' No file gave rows, so results has only the columns _file_id and _file.'
          : '';
      return {
        kind: 'bad-sql',
        message: `then_sql: ${sqlWords(err)}.${hint} It reads table results; fix it and call again.`,
      };
    }
  }

  const skippedOut = SKIP_WORDS.flatMap((reason) => {
    const ids = skipped.get(reason);
    return ids ? [{ reason, count: ids.length, file_ids: ids.slice(0, SKIP_IDS_MAX) }] : [];
  });
  const truncated = stop !== undefined || outerCut;
  const hints: string[] = [];
  if (stop) hints.push(stopWords(stop, rowCap, ask.thenSql !== undefined));
  if (cutFile) hints.push(`File ${cutFile} had more rows than fit: the rest of its rows are left out.`);
  if (stop && ask.thenSql !== undefined) {
    hints.push(`then_sql ran over the rows of the ${done} files done, not all of them.`);
  }
  if (outerCut) {
    hints.push(`The then_sql result was cut at ${answerCap} rows: aggregate more, or raise max_rows.`);
  }
  if (stop && left > 0 && lastDone) {
    hints.push(`${left} files are left: call again with after = '${lastDone}' to go on.`);
  }
  opts.step?.setOutput({ files: done, read, rows: outRows.length, truncated });
  return {
    kind: 'rows',
    output: {
      files: { done, read, left },
      columns: outColumns,
      rows: outRows,
      row_count: outRows.length,
      duration_ms: Date.now() - started,
      ...(skippedOut.length > 0 ? { skipped: skippedOut } : {}),
      ...(truncated ? { truncated: true as const } : {}),
      ...(stop && left > 0 && lastDone ? { after: lastDone } : {}),
      ...(hints.length > 0 ? { hint: hints.join(' ') } : {}),
    },
  };
}

function stopWords(stop: Stop, rowCap: number, outer: boolean): string {
  switch (stop) {
    case 'rows':
      return outer
        ? `Stopped at ${rowCap} collected rows: narrow sql with WHERE, or aggregate per file in sql.`
        : `Stopped at ${rowCap} rows (max_rows): narrow with WHERE, or count with then_sql instead of listing.`;
    case 'bytes':
      return `Stopped at ${Math.round(FILE_SQL_COLLECT_BYTES_MAX / 1048576)} MB of rows: select fewer columns, or aggregate.`;
    case 'time':
      return `Stopped at the time limit of the call (${Math.round(envNum('FILE_SQL_MANY_MS') / 1000)} s).`;
    case 'busy':
      return 'Stopped: every file database reader on this server is in use. Call again in a few seconds.';
    case 'files':
      return `Stopped at ${FILE_SQL_FILES_MAX} files, the most one call reads.`;
  }
}
