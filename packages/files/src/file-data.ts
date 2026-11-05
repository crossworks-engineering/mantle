/**
 * May this caller read a file's rows? One answer for file_sql and, later, the
 * tracer, circuit_verify and the overview, so a flip counts at once for all of
 * them. Removing a file's names only tidies the disk: this is the wall.
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
 *    not one;
 *  - private: effectively `metadata`, by privateFileIds' system step.
 *
 * That step throws inside a scope's open transaction. No product path dispatches
 * a tool in one (a turn and an app run take a short transaction per query), and
 * reading the chain in place would miss a folder the scope cannot read. So there
 * the file is refused in plain words: closed, and no throw.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  adminOrSystemScope,
  db,
  inOpenTransaction,
  isSnapshotCopy,
  isSystemScope,
  nodes,
  type Node,
} from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { emailAttachmentIds } from './email-attachments';
import { FILE_DB_EXTS, isFileSha256 } from './file-dbs';
import { ownIndexingMode, privateFileIds } from './indexing';
import { extOf } from './slug';

/** A file row's fields the read of its rows needs. */
export type FileDataRow = Pick<Node, 'id' | 'path' | 'title' | 'data'>;

export type FileDataRefusal = {
  code: 'not-table-type' | 'no-sha' | 'email-attachment' | 'private' | 'in-transaction';
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
  if (!UUID_RE.test(fileId)) return null;
  const [row] = await db
    .select({ id: nodes.id, path: nodes.path, title: nodes.title, data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.id, fileId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'file')))
    .limit(1);
  return row ?? null;
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
const PRIVATE: FileDataRefusal = {
  code: 'private',
  message: 'This file is set to stay out of the brain. Set its indexing to full to read it.',
};
const IN_TRANSACTION: FileDataRefusal = {
  code: 'in-transaction',
  message:
    "This file's indexing cannot be checked inside an open transaction: call again outside it.",
};

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
  if (left().length > 0 && !(await adminOrSystemScope())) {
    const attachments = await emailAttachmentIds(
      ownerId,
      left().map((row) => row.id),
    );
    for (const id of attachments) out.set(id, EMAIL_ATTACHMENT);
  }
  // A row's own flag needs no chain, so it answers in any scope.
  const needsChain = (row: FileDataRow) =>
    ownIndexingMode(row.data as Record<string, unknown> | null) === null;
  if (!isSystemScope() && inOpenTransaction()) {
    for (const row of left()) {
      if (needsChain(row)) out.set(row.id, IN_TRANSACTION);
    }
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
