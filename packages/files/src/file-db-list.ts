/**
 * The file databases a caller may read, in every folder (or under one): what
 * the "Data files" view in Files and `file_list` with `data` list. A member sees
 * the files they may open by hand, each with the state of its database.
 *
 * Rights are the two checks of every reader of a file's rows (file-data.ts):
 * the rows are read in the caller's scope, then fileDataRefusals. A row it
 * refuses is left out, as file_sql would say no to it. The HTTP route adds its
 * own email rule for a key (withoutMail), as its other lists do: on HTTP a key's
 * areas are not in the caller's facts.
 *
 * The state is read for the listed rows only: one look per row at its two
 * names, a few at a time, and a `.none` is opened for its word. XML is listed
 * only when it has a name: most XML is no Microsoft Project plan, and a plan
 * that has not been built yet looks the same as any other XML.
 */
import { promises as fs } from 'node:fs';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { fileDataExt, fileDataListKeys, fileDataRefusals, tableFileFilter } from './file-data';
import {
  fileDbPaths,
  fileSha256Of,
  filesRootMounted,
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
export const DATA_FILES_MAX = 2000;

/** A folder path a list may be limited to: ltree labels. */
export const DATA_FILES_UNDER = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,30}$/;

/** How many rows are looked at on disk at once. */
const DISK_BATCH = 32;

/** A row's state on disk: its database, its word, or neither. */
async function stateOf(
  id: string,
  sha: unknown,
): Promise<{ state: DataFileState; bytes: number | null; named: boolean }> {
  const names = fileDbPaths(id, sha);
  if (!names) return { state: 'not-built', bytes: null, named: false };
  const built = await fs.stat(names.sqlite).catch(() => null);
  if (built?.isFile()) return { state: 'ready', bytes: built.size, named: true };
  const word = await readFileDbNone(id, sha);
  return word
    ? { state: word, bytes: null, named: true }
    : { state: 'not-built', bytes: null, named: false };
}

/**
 * Every table-type file the caller may read, by folder then name, with the
 * state of its database. `under` limits it to a folder and its sub-folders.
 * `truncated` says the list stopped at the cap.
 */
export async function listDataFiles(
  ownerId: string,
  opts: { limit?: number; under?: string } = {},
): Promise<{ files: DataFileRow[]; truncated: boolean }> {
  // With no mount every file would read as not built: that is no answer.
  if (!(await filesRootMounted())) {
    throw new Error('listDataFiles: the files root is not mounted in this process');
  }
  if (opts.under !== undefined && !DATA_FILES_UNDER.test(opts.under)) {
    throw new Error('listDataFiles: `under` is not a folder path');
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
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        tableFileFilter({ xml: true }),
        opts.under ? sql`${nodes.path} <@ ${opts.under}::ltree` : undefined,
      ),
    )
    .orderBy(asc(nodes.path), asc(nodes.title))
    .limit(limit + 1);
  const truncated = rows.length > limit;
  const refused = await fileDataRefusals(ownerId, rows.slice(0, limit));
  const page = rows.slice(0, limit).filter((row) => !refused.has(row.id));

  const files: DataFileRow[] = [];
  for (let i = 0; i < page.length; i += DISK_BATCH) {
    const batch = page.slice(i, i + DISK_BATCH);
    const states = await Promise.all(batch.map((row) => stateOf(row.id, fileSha256Of(row))));
    batch.forEach((row, j) => {
      const { state, bytes, named } = states[j]!;
      const ext = fileDataExt(row);
      if (ext === 'xml' && !named) return;
      const filename = (row.data as { filename?: unknown } | null)?.filename;
      files.push({
        id: row.id,
        parentPath: row.path,
        filename: typeof filename === 'string' ? filename : row.title,
        extension: ext,
        sizeBytes: Number(row.sizeBytes ?? 0),
        updatedAt: row.updatedAt.toISOString(),
        database: { state, bytes },
      });
    });
  }
  return { files, truncated };
}
