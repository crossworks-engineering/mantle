/**
 * A file's status and its processing, as Files shows them (docs/files.md,
 * "Status and processing"):
 *
 *  - `FileStatus`: the compact status on every file row of
 *    GET /api/files/files (a folder, Recent, by read state), on the one
 *    file of GET /api/files/files/:id, and on a file's TreeItem
 *    (GET /api/tree/files...). What the corner badge of a file's icon draws.
 *  - `FileProcessing`: GET /api/files/files/:id/processing and the
 *    `file_processing` tool. What the Details panel draws: size, pages, was
 *    it embedded, the counts, the database, the queue, the last error, and
 *    where its content went (the items made from it).
 *
 * Both are derived live from the file row, the queue and the file's
 * database on disk; nothing new is stored.
 */
import type { DataFileState, FileDatabaseReadBy } from './file-databases';

/** Was the file's content read into the brain:
 *  - `done`: read, in search (facts and mentions where the reader makes them);
 *  - `partial`: read in part (a scan's first pages: `FileProcessing.extraction.pages`);
 *  - `waiting`: not read yet (queued, retrying, or about to be queued);
 *  - `failed`: the read failed (`FileProcessing.error` says why);
 *  - `none`: not read on purpose: kept to its name, or nothing to read. */
export type FileIngest = 'done' | 'partial' | 'waiting' | 'failed' | 'none';

/** An extract job for the file in the queue now: waiting (`queued`) or
 *  being read (`running`). A file read before can have one: it is being
 *  read again. */
export type FileJob = 'queued' | 'running';

export type FileStatus = {
  ingest: FileIngest;
  /** Absent when no job for the file is in the queue. */
  job?: FileJob;
  /** The file's own database (its Data view): `ready`, a word for why it
   *  has no rows (`too-large`, `no-rows`, `unreadable`: unreadable is the
   *  failed one), or `not-built` yet. Absent for a file that has no Data
   *  view. */
  db?: DataFileState;
  /** RESERVED (part P5, not filled yet): true when the file was read by an
   *  older extractor than the box's current one, so a re-read would give
   *  more. Absent today: the brain keeps no extractor version per file. */
  stale?: boolean;
};

/** The read state of the file, as FileRow.extraction (the brain's
 *  extraction-status rule). */
export type FileProcessingExtraction = {
  state: 'indexed' | 'partial' | 'failed' | 'skipped' | 'pending' | 'name_only';
  reason?: string;
  hint?: string;
  pages?: { read: number; total: number };
};

/** One item made from the file (its `data.sourceFileId`): an extracted
 *  image (`file`), an auto Table (`table`), a page or a note from
 *  page_from_file / note_from_file. Only items the caller reads. */
export type FileDerivedItem = {
  id: string;
  /** The node type: 'file' | 'table' | 'page' | 'note' (another type is
   *  possible, shown as is). */
  kind: string;
  title: string;
  /** Where it lives: the ltree path of its folder or parent. */
  path: string;
};

export type FileProcessing = {
  file: {
    id: string;
    filename: string;
    extension: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string | null;
    /** Its folder (ltree path). */
    parentPath: string;
    createdAt: string;
    updatedAt: string;
  };
  status: FileStatus;
  extraction: FileProcessingExtraction;
  /** When the last read ended (ISO); null when it has not been read. */
  readAt: string | null;
  /** The mode of the last read: 'full', 'metadata' (name only) or 'local'
   *  (read on the box with no model); null before the first read. */
  readMode: 'full' | 'metadata' | 'local' | null;
  /** The pages of the file when the brain knows them (a scan's count);
   *  null otherwise. */
  pages: number | null;
  /** Characters of text read from the file into the brain. */
  textChars: number;
  /** A summary of the file was written. */
  summarized: boolean;
  /** The file's own vector is there: it is found by meaning in search. */
  embedded: boolean;
  /** Text chunks of the file in search. */
  chunks: number;
  /** Facts taken from the file. */
  facts: number;
  /** Entity mentions found in the file. */
  mentions: number;
  /** The file's database, for a file with a Data view; null otherwise.
   *  `readBy`: the pipeline and version that built it (null before stamps
   *  or when not built). */
  database: {
    state: DataFileState;
    bytes: number | null;
    readBy: FileDatabaseReadBy | null;
  } | null;
  /** An extract job in the queue now, or null. */
  job: FileJob | null;
  /** RESERVED (part P5): as FileStatus.stale; null while the brain keeps no
   *  extractor version per file (always null today). */
  stale: boolean | null;
  /** Why the read failed or was skipped (the extractor's word and a
   *  sentence for a person); null when nothing went wrong. */
  error: { reason: string; hint: string | null } | null;
  /** Images found in the file and kept as their own files, when the reader
   *  counted them; null otherwise. */
  images: { kept: number; found: number } | null;
  /** Where the content went: the items made from the file, by kind then
   *  title, at most FILE_DERIVED_MAX. `truncated`: there are more. */
  derived: { items: FileDerivedItem[]; truncated: boolean };
};

/** The most derived items one processing answer lists. */
export const FILE_DERIVED_MAX = 200;
