/**
 * The file databases a caller may read, in every folder: what the "Data files"
 * view in Files and `file_list` with `data` list. A member sees the files they
 * may open by hand, each with the state of its database.
 *
 * Rights are the two checks of every reader of a file's rows (file-data.ts):
 * the rows are read in the caller's scope, then fileDataRefusals. A row it
 * refuses is left out, as file_sql would say no to it.
 *
 * The state comes from one read of the `.file-dbs` folder (listFileDbFolder),
 * not one look per file. Only a `.none` is opened, for its word. XML is listed
 * only when it has a name: most XML is no Microsoft Project plan, and a plan
 * that has not been built yet looks the same as any other XML.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { fileDataExt, fileDataListKeys, fileDataRefusals, tableFileFilter } from './file-data';
import {
  fileSha256Of,
  filesRootMounted,
  isFileSha256,
  listFileDbFolder,
  readFileDbNone,
  type FileDbNoneWord,
} from './file-dbs';

/** The state of a file's database: built, a word for why there are no rows,
 *  or not built yet (just uploaded, or waiting for the rebuild). */
export type DataFileState = 'ready' | FileDbNoneWord | 'not-built';

/** One file that has, or will have, a database. */
export type DataFileRow = {
  id: string;
  parentPath: string;
  filename: string;
  extension: string;
  sizeBytes: number;
  updatedAt: string;
  database: {
    state: DataFileState;
    /** The database's size on disk, when it is built. */
    bytes: number | null;
  };
};

/** The most rows one list returns. */
export const DATA_FILES_MAX = 1000;

/**
 * Every table-type file the caller may read, by folder then name, with the
 * state of its database. `truncated` says the list stopped at the cap.
 */
export async function listDataFiles(
  ownerId: string,
  opts: { limit?: number } = {},
): Promise<{ files: DataFileRow[]; truncated: boolean }> {
  // With no mount every file would read as not built: that is no answer.
  if (!(await filesRootMounted())) {
    throw new Error('listDataFiles: the files root is not mounted in this process');
  }
  const limit = Math.min(DATA_FILES_MAX, Math.max(1, opts.limit ?? DATA_FILES_MAX));
  const rows = await db
    .select({
      id: nodes.id,
      path: sql<string>`${nodes.path}::text`,
      title: nodes.title,
      updatedAt: nodes.updatedAt,
      sizeBytes: sql<string | null>`${nodes.data}->>'size_bytes'`,
      data: fileDataListKeys(),
    })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), tableFileFilter({ xml: true })))
    .orderBy(asc(nodes.path), asc(nodes.title))
    .limit(limit + 1);
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);

  const refused = await fileDataRefusals(ownerId, page);
  const { names } = await listFileDbFolder();
  const onDisk = new Map<string, { sqlite: number | null; none: boolean }>();
  for (const n of names) {
    const key = `${n.fileId}.${n.sha16}`;
    const seen = onDisk.get(key) ?? { sqlite: null, none: false };
    if (n.name.endsWith('.sqlite')) seen.sqlite = n.bytes;
    else if (n.name.endsWith('.none')) seen.none = true;
    onDisk.set(key, seen);
  }

  const files: DataFileRow[] = [];
  for (const row of page) {
    if (refused.has(row.id)) continue;
    const sha = fileSha256Of(row);
    const disk = isFileSha256(sha) ? onDisk.get(`${row.id}.${sha.slice(0, 16)}`) : undefined;
    const ext = fileDataExt(row);
    if (ext === 'xml' && !disk) continue;
    let state: DataFileState = 'not-built';
    if (disk?.sqlite != null) state = 'ready';
    else if (disk?.none) state = (await readFileDbNone(row.id, sha)) ?? 'not-built';
    const filename = (row.data as { filename?: unknown } | null)?.filename;
    files.push({
      id: row.id,
      parentPath: row.path,
      filename: typeof filename === 'string' ? filename : row.title,
      extension: ext,
      sizeBytes: Number(row.sizeBytes ?? 0),
      updatedAt: row.updatedAt.toISOString(),
      database: { state, bytes: state === 'ready' ? (disk?.sqlite ?? null) : null },
    });
  }
  return { files, truncated };
}
