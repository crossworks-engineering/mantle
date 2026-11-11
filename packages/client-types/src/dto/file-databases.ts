/**
 * A file's read-only database, as the Data view in Files reads it
 * (docs/file-ingestion.md, "File databases"). The same answer as the
 * `file_sql` tool, with a `kind`:
 *
 *  - POST /api/files/files/:id/database with no `sql`: `describe`;
 *  - with `sql`: `rows`;
 *  - a file with no database: `none`, and `reason` says why in words.
 *
 * GET /api/files/files?data=1 lists every file the caller may read that has,
 * or will have, a database, with its state.
 */

export type FileDatabaseTab = {
  name: string;
  /** The view to query, double-quoted, e.g. SELECT * FROM "Layers". */
  view: string;
  fts_table?: string;
  row_count: number;
  columns: { name: string; type: string }[];
};

export type FileDatabaseResponse =
  | {
      kind: 'describe';
      file_id: string;
      title: string;
      description?: string;
      tabs: FileDatabaseTab[];
      hint: string;
    }
  | {
      kind: 'rows';
      file_id: string;
      columns: string[];
      rows: unknown[][];
      row_count: number;
      duration_ms: number;
      truncated?: true;
      hint?: string;
    }
  | { kind: 'none'; file_id: string; reason: string };

/** Built; a word for why there are no rows; or not built yet. */
export type DataFileState = 'ready' | 'too-large' | 'no-rows' | 'unreadable' | 'not-built';

export type DataFileRow = {
  id: string;
  parentPath: string;
  filename: string;
  extension: string;
  sizeBytes: number;
  updatedAt: string;
  database: { state: DataFileState; bytes: number | null };
};

export type DataFilesResponse = { files: DataFileRow[]; truncated: boolean };
