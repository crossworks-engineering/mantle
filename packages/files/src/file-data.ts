/**
 * May this caller read a file's rows? One answer for file_sql, the tracer,
 * circuit_verify and the overview, so a flip counts at once for all of them.
 * Removing a file's names only tidies the disk: this is the wall.
 *
 * Always after the row read in the caller's scope (fileDataRow): a caller who
 * cannot read the row never gets here, and is told nothing about the file.
 *
 * The refusals, in order:
 *  - not a table type (a drive-synced file has no `data.filename`, so the title
 *    gives the extension);
 *  - no valid sha256: nothing can name a database;
 *  - below Admin, an email attachment, or an item made from one, by the same
 *    rule search and the lists use (emailAttachmentIds). A drive-synced file is
 *    not one. So too for an API key with no Search area, on any login: it does
 *    not reach email (access matrix M4), and the tracer's list names no id for
 *    keyEmailGuard to check;
 *  - private: effectively `metadata`, by privateFileIds' system step.
 *
 * That step throws inside a scope's open transaction. No product path dispatches
 * a tool in one (a turn and an app run take a short transaction per query), and
 * reading the chain in place would miss a folder the scope cannot read. So it
 * stays a fault: closed, no rows, and no words that hide it.
 */
import { and, asc, eq, or, sql } from 'drizzle-orm';
import {
  adminOrSystemScope,
  currentCaller,
  db,
  isSnapshotCopy,
  nodes,
  type Node,
} from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { emailAttachmentIds } from './email-attachments';
import { FILE_DB_EXTS, fileDbNameExists, fileDbSqlitePath, isFileSha256 } from './file-dbs';
import { privateFileIds } from './indexing';
import { extOf } from './slug';

/** A file row's fields the read of its rows needs. */
export type FileDataRow = Pick<Node, 'id' | 'path' | 'title' | 'data'>;

export type FileDataRefusal = {
  code: 'not-table-type' | 'no-sha' | 'email-attachment' | 'private';
  message: string;
};

const dataOf = (row: Pick<FileDataRow, 'data'>) => (row.data ?? {}) as Record<string, unknown>;

/** The extension a file's database follows: `data.filename`, or the title on a
 *  row that has none (a drive-synced file, an attachment). */
export function fileDataExt(row: Pick<FileDataRow, 'title' | 'data'>): string {
  const { filename } = dataOf(row);
  return extOf(typeof filename === 'string' ? filename : row.title);
}

/** The file row, read in the caller's scope. */
export async function fileDataRow(ownerId: string, fileId: string): Promise<FileDataRow | null> {
  const [row] = await fileDataRows(ownerId, [fileId]);
  return row ?? null;
}

/**
 * The file rows of these ids, read in the caller's scope, in one query (an id
 * that is not a uuid, or that the caller cannot read, has no row). One read for
 * file_sql over a list of files and for one file. `full` reads the whole of
 * `data`; a list reads the keys a refusal and a name need (fileDataListKeys).
 */
export async function fileDataRows(
  ownerId: string,
  fileIds: readonly string[],
  opts: { full?: boolean } = { full: true },
): Promise<FileDataRow[]> {
  const ids = [...new Set(fileIds.filter((id) => UUID_RE.test(id)))];
  if (ids.length === 0) return [];
  return db
    .select({
      id: nodes.id,
      path: nodes.path,
      title: nodes.title,
      data: opts.full ? nodes.data : fileDataListKeys(),
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        ids.length === 1
          ? eq(nodes.id, ids[0]!)
          : // The ids go as ONE text parameter, whatever their number.
            sql`${nodes.id} = any(string_to_array(${ids.join(',')}, ',')::uuid[])`,
      ),
    )
    .limit(ids.length);
}

/**
 * The file rows in a folder (or in it and its sub-folders, `below`), read in
 * the caller's scope, by id, after `after`, at most `limit`: file_sql over a
 * folder. A file the caller cannot read is not here, as in every list.
 * `total` is the count of rows after `after`, so the caller can say how many
 * are left.
 */
export async function fileDataRowsIn(
  ownerId: string,
  folder: string,
  opts: { below: boolean; after?: string; limit: number },
): Promise<(FileDataRow & { total: number })[]> {
  return db
    .select({
      id: nodes.id,
      path: nodes.path,
      title: nodes.title,
      data: fileDataListKeys(),
      total: sql<number>`(count(*) over ())::int`,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        opts.below ? sql`${nodes.path} <@ ${folder}::ltree` : sql`${nodes.path} = ${folder}::ltree`,
        opts.after && UUID_RE.test(opts.after) ? sql`${nodes.id} > ${opts.after}::uuid` : undefined,
      ),
    )
    .orderBy(asc(nodes.id))
    .limit(opts.limit);
}

/**
 * The keys of `data` this file's refusal and names read, for a list of file
 * rows: a list never selects the whole of `data`, as a drawing's answers can
 * add 256 KB to its row.
 */
export const fileDataListKeys = () =>
  sql<FileDataRow['data']>`jsonb_strip_nulls(jsonb_build_object(
    'filename', ${nodes.data}->'filename',
    'sha256', ${nodes.data}->'sha256',
    'indexing', ${nodes.data}->'indexing',
    'snapshot_of', ${nodes.data}->'snapshot_of'))`;

/**
 * Whether Files shows a file's Data view, so the client holds no list of
 * its own: this kind of file has a Data view, and the view itself gives the
 * answer or the refusal. A table type, by the name the extract reads it
 * from (fileDataExt), with a valid sha256; an XML only with a name at these
 * bytes, as most XML is no plan; a PDF only with a database, as most PDFs
 * are documents. file_sql's other refusals (private, an email attachment,
 * a quiet copy) are not asked here: the view asks file_sql, and it gives
 * them.
 */
export async function withDataView<T extends { id: string; filename: string; sha256: unknown }>(
  rows: readonly T[],
): Promise<(T & { dataView: boolean })[]> {
  const viewOf = async (row: T): Promise<boolean> => {
    const ext = extOf(row.filename);
    if (!FILE_DB_EXTS.has(ext)) return false;
    if (!isFileSha256(row.sha256)) return false;
    if (ext === 'pdf') return (await fileDbSqlitePath(row.id, row.sha256)) !== null;
    if (ext === 'xml') return fileDbNameExists(row.id, row.sha256);
    return true;
  };
  return Promise.all(rows.map(async (row) => ({ ...row, dataView: await viewOf(row) })));
}

/** A Table that names this file, as the caller's scope reads it. */
export async function tableNamingFile(ownerId: string, fileId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'table'),
        sql`${nodes.data}->>'sourceFileId' = ${fileId}`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** A row the extractor never reads, so it never gets a database: a quiet copy
 *  (a read-only snapshot copy). A row of another owner (not_brain_owner) never
 *  comes back from fileDataRow. */
export function extractorRefusesFile(row: Pick<FileDataRow, 'data'>): boolean {
  return isSnapshotCopy(row);
}

/**
 * The file rows that earn a database, by their own fields: a table type, by the
 * name the extract reads it from, and no quiet copy. One filter for the rebuild
 * and the integrity screen. XML is taken only when asked: most XML is no plan, so
 * the screen's count of files with no name leaves it out. A PDF is taken only
 * when asked too, and then by id or all of them: most PDFs are documents, which
 * get no name. The list of data files asks for the ids that have a database, so
 * every other PDF row costs it nothing; the person-run PDF rebuild asks for all.
 * The caller adds the owner (an extract reads only the brain's own rows,
 * not_brain_owner).
 */
export function tableFileFilter(opts: { xml: boolean; pdf?: 'all' | readonly string[] }) {
  const exts = [...FILE_DB_EXTS]
    .filter((ext) => ext !== 'pdf' && (opts.xml || ext !== 'xml'))
    .join('|');
  const name = sql`lower(coalesce(${nodes.data}->>'filename', ${nodes.title}))`;
  const tableType = sql`${name} ~ ${`\\.(${exts})$`}`;
  const isPdf = sql`${name} ~ ${'\\.pdf$'}`;
  // The ids go as ONE text parameter, whatever their number.
  const ids = opts.pdf && opts.pdf !== 'all' ? opts.pdf.filter((id) => UUID_RE.test(id)) : [];
  const pdf =
    opts.pdf === 'all'
      ? isPdf
      : ids.length > 0
        ? and(isPdf, sql`${nodes.id} = any(string_to_array(${ids.join(',')}, ',')::uuid[])`)
        : undefined;
  return and(
    eq(nodes.type, 'file'),
    pdf ? or(tableType, pdf) : tableType,
    sql`coalesce(${nodes.data}->>'snapshot_of', '') = ''`,
  );
}

const NOT_TABLE_TYPE = (title: string): FileDataRefusal => ({
  code: 'not-table-type',
  message: `${title} has no database: only ${[...FILE_DB_EXTS].join(', ')} files have one. Read it with file_read.`,
});
const NO_SHA: FileDataRefusal = {
  code: 'no-sha',
  message: 'This file has no checksum on its row, so it has no database. Upload it again.',
};
const EMAIL_ATTACHMENT: FileDataRefusal = {
  code: 'email-attachment',
  message: 'This file is an email attachment: only an Admin user may read its rows.',
};
const KEY_EMAIL_ATTACHMENT: FileDataRefusal = {
  code: 'email-attachment',
  message: 'This file is an email attachment: this key reaches email only with the Search area.',
};
const PRIVATE: FileDataRefusal = {
  code: 'private',
  message: 'This file is set to stay out of the brain. Set its indexing to full to read it.',
};

/** Whether the caller is an API key limited to areas that leave out Search. */
function keyWithoutSearch(): boolean {
  const caller = currentCaller();
  const areas = caller?.facts?.keyAreas;
  return caller?.via === 'key' && Array.isArray(areas) && !areas.includes('search');
}

/**
 * Why each of these rows may not be read, by id: a row with no entry may be.
 * All rows in one step, so a tracer over many drawings pays for one.
 */
export async function fileDataRefusals(
  ownerId: string,
  rows: readonly FileDataRow[],
): Promise<Map<string, FileDataRefusal>> {
  const out = new Map<string, FileDataRefusal>();
  for (const row of rows) {
    if (!FILE_DB_EXTS.has(fileDataExt(row))) out.set(row.id, NOT_TABLE_TYPE(row.title));
    else if (!isFileSha256(dataOf(row).sha256)) out.set(row.id, NO_SHA);
  }
  const left = () => rows.filter((row) => !out.has(row.id));
  const keyCut = keyWithoutSearch();
  if (left().length > 0 && (keyCut || !(await adminOrSystemScope()))) {
    const attachments = await emailAttachmentIds(
      ownerId,
      left().map((row) => row.id),
    );
    for (const id of attachments) out.set(id, keyCut ? KEY_EMAIL_ATTACHMENT : EMAIL_ATTACHMENT);
  }
  for (const id of await privateFileIds(ownerId, left())) out.set(id, PRIVATE);
  return out;
}

/** Why this row may not be read, or null when it may. */
export async function fileDataRefusal(
  ownerId: string,
  row: FileDataRow,
): Promise<FileDataRefusal | null> {
  return (await fileDataRefusals(ownerId, [row])).get(row.id) ?? null;
}
