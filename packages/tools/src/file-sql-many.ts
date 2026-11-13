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
  TableFileMissingError,
  TableSqlError,
  assertReadOnlySelect,
  fileDbReaders,
  runReadOnlySql,
} from '@mantle/tabledb';
import { UUID_RE, errorMessage } from '@mantle/std';
import type { ToolHandlerContext } from './types';

/** The most files one call takes, read or skipped. Measured on a 2-core,
 *  2 GB stand-in with 300 real drawing databases read in turn: a count per
 *  file over 1,000 files took 0.9 s, 39 MB and at most 26 ms of event loop
 *  stall (report file-sql-many). */
export const FILE_SQL_FILES_MAX = 1000;
/** The most rows collected for `then_sql`. The rows are sent to the reader
 *  that runs it, and that send stalls this process: 50,000 wide rows took
 *  190 ms and 150 MB, 20,000 took 79 ms and 90 MB (same measure). */
export const FILE_SQL_COLLECT_ROWS_MAX = 20_000;
/** The most bytes collected, about: half the reply cap of one file
 *  (TABLE_SQL_MAX_REPLY_BYTES), for the same reason. */
export const FILE_SQL_COLLECT_BYTES_MAX = 8 * 1024 * 1024;
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
  'error',
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

/** What one null slot of a row costs in this process's memory. */
const NULL_BYTES = 8;

/** About what a row costs in this process's memory: every value its slot,
 *  a string or a BLOB its object as well as its bytes. An empty value is not
 *  free: 2,000 empty BLOBs a row are 2,000 objects. */
function rowBytes(row: readonly unknown[]): number {
  let n = 16;
  for (const v of row) {
    if (typeof v === 'string') n += 16 + Buffer.byteLength(v);
    else if (v instanceof Uint8Array) n += 64 + v.byteLength;
    else n += NULL_BYTES;
  }
  return n;
}

/** An engine error in the caller's words: this tool's name, and no path. */
function sqlWords(err: unknown, abs?: string): string {
  let text = errorMessage(err);
  if (abs) text = text.replaceAll(abs, 'the database');
  return text.replaceAll(filesRoot(), 'the files folder').replace(/\btable_sql\b/g, 'file_sql');
}

/** A column name as SQLite compares it: A to Z fold, nothing else does. So
 *  "Key" and "key" are one column of results, as they are one in SQLite, and
 *  two names SQLite keeps apart stay apart. */
const nameKey = (name: string) => name.replace(/[A-Z]/g, (ch) => ch.toLowerCase());

const NO_SUCH = /\bno such (table|column)\b/i;
/** An error of the statement itself, the same on every file: its syntax, a
 *  function it names, or a step the read-only rule refuses. */
const STATEMENT =
  /\bsyntax error\b|\bincomplete input\b|\bunrecognized token\b|\bno such function\b|\bwrong number of arguments\b|\bnot authorized\b/i;

/** The files of the scope after `after`, at most FILE_SQL_FILES_MAX, in
 *  order, each with its row in the caller's scope or none, and how many are
 *  left past them. */
async function filesOf(
  ownerId: string,
  scope: ManyScope,
  after: string | undefined,
): Promise<
  | { ok: true; items: { id: string; row: FileDataRow | null }[]; left: number }
  | { ok: false; message: string }
> {
  if (after !== undefined && !UUID_RE.test(after)) {
    return {
      ok: false,
      message: `after must be a file id, as the last answer gave it (got '${after.slice(0, 60)}').`,
    };
  }
  if ('fileIds' in scope) {
    // Ids as Postgres gives them back, so a match does not hang on case.
    const ids = [...new Set(scope.fileIds.map((id) => id.toLowerCase()))];
    let start = 0;
    if (after) {
      const at = ids.indexOf(after.toLowerCase());
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
    return {
      ok: true,
      items: window.map((id) => ({ id, row: byId.get(id) ?? null })),
      left: ids.length - start - window.length,
    };
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
    after: after?.toLowerCase(),
    limit: FILE_SQL_FILES_MAX,
  });
  const total = got[0]?.total ?? 0;
  return {
    ok: true,
    items: got.map((row) => ({ id: row.id, row })),
    left: Math.max(0, total - got.length),
  };
}

/** Calls over many files running now in this process. Each holds what it
 *  collected (up to FILE_SQL_COLLECT_BYTES_MAX) between its files, so at most
 *  the reader limit of them run at once: the memory of this process stays
 *  bounded however many calls a login sends. One more hears busy at once. */
let running = 0;

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
  if (running >= fileDbReaders()) {
    return {
      kind: 'none',
      message:
        'file_sql: busy, as many calls over many files as this server runs at once are running; try again in a few seconds.',
    };
  }
  running++;
  try {
    return await readMany(ownerId, ask, opts);
  } finally {
    running--;
  }
}

async function readMany(
  ownerId: string,
  ask: Parameters<typeof fileSqlManyAnswer>[1],
  opts: { step?: Step },
): Promise<FileSqlManyAnswer> {
  const started = Date.now();
  const deadline = started + envNum('FILE_SQL_MANY_MS');
  const outer = ask.thenSql !== undefined;
  // then_sql gets one statement's time limit of the call, kept back from the
  // files, so a call that reads until its limit can still total.
  const filesDeadline = outer
    ? deadline - Math.min(envNum('TABLE_SQL_TIMEOUT_MS'), (deadline - started) / 2)
    : deadline;
  // A statement the runner would refuse fails at once, before any file.
  try {
    assertReadOnlySelect(ask.sql);
    if (outer) assertReadOnlySelect(ask.thenSql!);
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
  const inFolder = 'folder' in ask.scope;

  const answerCap = Math.max(1, Math.min(ask.cap ?? SQL_ROW_CAP_DEFAULT, SQL_ROW_CAP_MAX));
  const rowCap = outer ? FILE_SQL_COLLECT_ROWS_MAX : answerCap;

  const skipped = new Map<SkipWord, string[]>();
  const skip = (word: SkipWord, id: string) => {
    const ids = skipped.get(word) ?? [];
    ids.push(id);
    skipped.set(word, ids);
  };
  const refused = await fileDataRefusals(
    ownerId,
    listed.items.flatMap((item) => (item.row ? [item.row] : [])),
  );

  const columns: string[] = [...FILE_SQL_FILE_COLUMNS];
  // By the name in lower case: SQLite names are not case-sensitive, so "Key"
  // and "key" of two files are one column of results.
  const at = new Map<string, number>(columns.map((c, i) => [c, i]));
  const rows: unknown[][] = [];
  let bytes = 0;
  let read = 0;
  let done = 0;
  let lastDone: string | undefined;
  let stop: Stop | undefined;
  let cutFile: string | undefined;
  /** The engine's words for the first file skipped by an error of its own. */
  let firstError: string | undefined;

  for (const { id, row } of listed.items) {
    if (!row) {
      skip('not-found', id);
    } else {
      const refusal = refused.get(id);
      if (refusal) {
        // A list leaves out an email attachment the caller may not read, and
        // says nothing of it: so does a folder. A list of ids names it back.
        if (!(inFolder && refusal.code === 'email-attachment')) {
          skip(refusal.code === 'not-table-type' ? 'not-table' : 'no-access', id);
        }
      } else {
        const abs = await fileDbSqlitePath(id, fileSha256Of(row));
        if (!abs) {
          skip('no-database', id);
        } else {
          const left = filesDeadline - Date.now();
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
            // A file gone between its name and its read (a replace): its
            // database is gone with it. Anything else is no answer of a file.
            if (!(err instanceof TableSqlError) && !(err instanceof TableFileMissingError)) {
              throw err;
            }
            const code = err instanceof TableSqlError ? err.code : 'missing';
            const words = sqlWords(err, abs);
            if (code === 'busy') {
              stop = 'busy';
              break;
            }
            if (code === 'too-big' && rows.length > 0) {
              stop = 'bytes';
              break;
            }
            if (code === 'timeout' && filesDeadline - Date.now() < MIN_FILE_MS) {
              stop = 'time';
              // A first file that takes all the time is done, as a timeout,
              // so the next call goes past it.
              if (done > 0) break;
              skip('timeout', id);
              done++;
              lastDone = id;
              break;
            }
            // The statement is wrong, or needs more memory than a reader may
            // use: the next file would say the same.
            if (code === 'memory' || (code === 'sql' && STATEMENT.test(words))) {
              return {
                kind: 'bad-sql',
                message: `${words} (file ${id}). Fix the statement and call again.`,
              };
            }
            if (code === 'sql') firstError ??= words;
            skip(
              code === 'sql'
                ? NO_SUCH.test(words)
                  ? 'no-such-table'
                  : 'error'
                : code === 'timeout'
                  ? 'timeout'
                  : code === 'missing'
                    ? 'no-database'
                    : 'too-large',
              id,
            );
            done++;
            lastDone = id;
            continue;
          }
          // `bytes` is always what the collected table costs at its full
          // width, nulls and column names included (rowBytes). A file's
          // whole cost is known before any of its rows is taken: its new
          // columns in every row so far, and its own rows at the width the
          // table will have. One check: past the cap, the call stops before
          // this file (a first file alone past it is skipped as too large).
          const fresh = new Map<string, { name: string; slot: number }>();
          let nameBytes = 0;
          for (const c of got.columns) {
            const key = nameKey(c);
            if ((FILE_SQL_FILE_COLUMNS as readonly string[]).includes(key)) {
              return {
                kind: 'bad-sql',
                message: `The statement returns a column named ${c}, and file_sql adds that column to every row. Rename it with AS and call again.`,
              };
            }
            if (!at.has(key) && !fresh.has(key)) {
              fresh.set(key, { name: c, slot: columns.length + fresh.size });
              nameBytes += 16 + Buffer.byteLength(c);
            }
          }
          const width = columns.length + fresh.size;
          const name = typeof row.data?.filename === 'string' ? row.data.filename : row.title;
          const index = got.columns.map((c) => at.get(nameKey(c)) ?? fresh.get(nameKey(c))!.slot);
          // The slots a row of this file fills: its nulls are the rest.
          const filled = new Set(index).size;
          let cost = nameBytes + fresh.size * NULL_BYTES * rows.length;
          for (const r of got.rows) {
            cost += rowBytes([id, name, ...r]) + NULL_BYTES * (width - 2 - filled);
          }
          if (bytes + cost > FILE_SQL_COLLECT_BYTES_MAX) {
            if (rows.length > 0) {
              stop = 'bytes';
              break;
            }
            // Alone past the cap: done, as too large, so the call goes on.
            skip('too-large', id);
            done++;
            lastDone = id;
            continue;
          }
          bytes += cost;
          for (const [key, c] of fresh) {
            at.set(key, c.slot);
            columns.push(c.name);
          }
          for (const r of got.rows) {
            const out: unknown[] = new Array(width).fill(null);
            out[0] = id;
            out[1] = name;
            r.forEach((v, i) => (out[index[i]!] = v));
            rows.push(out);
          }
          read++;
          if (got.truncated) {
            cutFile = id;
            stop = 'rows';
          }
        }
      }
    }
    done++;
    lastDone = id;
    if (stop || rows.length >= rowCap) break;
  }
  // A column first seen in a later file: null in the rows before it (counted
  // in `bytes` when that file came).
  for (const r of rows) while (r.length < columns.length) r.push(null);

  const left = listed.items.length + listed.left - done;
  if (!stop && left > 0) stop = rows.length >= rowCap ? 'rows' : 'files';
  // Where the next call starts: the last file done, else where this one began.
  const after = stop && left > 0 ? (lastDone ?? ask.after) : undefined;

  let outColumns = columns;
  let outRows = rows;
  let outerCut = false;
  if (outer) {
    try {
      const got = await runReadOnlySql({ results: { columns, rows } }, ask.thenSql!, {
        cap: answerCap,
        limitMs: Math.max(MIN_FILE_MS, deadline - Date.now()),
      });
      outColumns = got.columns;
      outRows = got.rows;
      outerCut = got.truncated;
    } catch (err) {
      if (err instanceof TableSqlError && err.code === 'busy') {
        return { kind: 'none', message: sqlWords(err) };
      }
      // Its time, or SQLite's limit of columns on the table results: neither
      // is a fault of then_sql's text.
      if (err instanceof TableSqlError && err.code === 'timeout') {
        return {
          kind: 'none',
          message:
            'then_sql ran out of the time of the call: read fewer files a call (call with after), or aggregate per file in sql.',
        };
      }
      if (/\btoo many columns\b/i.test(errorMessage(err))) {
        return {
          kind: 'bad-sql',
          message:
            'The files give more different columns than table results may hold: name the columns in sql instead of SELECT *.',
        };
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
  if (stop) hints.push(stopWords(stop, rowCap, outer));
  if (cutFile)
    hints.push(`File ${cutFile} had more rows than fit: the rest of its rows are left out.`);
  if (read === 0 && firstError) {
    hints.push(`No file gave rows. The first file that failed said: ${firstError}`);
  }
  if (stop && outer) {
    hints.push(`then_sql ran over the rows of the ${done} files done, not all of them.`);
  }
  if (outerCut) {
    hints.push(
      `The then_sql result was cut at ${answerCap} rows: aggregate more, or raise max_rows.`,
    );
  }
  if (after) {
    hints.push(`${left} files are left: call again with after = '${after}' to go on.`);
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
      ...(after ? { after } : {}),
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
