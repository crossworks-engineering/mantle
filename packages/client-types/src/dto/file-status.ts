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
 *  - `partial`: read in part (rows, sheets, characters, pictures or pages left
 *    out: `FileProcessing.extraction.cuts`, its `hint` the sentence);
 *  - `waiting`: not read yet (queued, retrying, or about to be queued);
 *  - `failed`: the read failed (`FileProcessing.error` says why);
 *  - `none`: not read on purpose: kept to its name, or nothing to read. */
export type FileIngest = 'done' | 'partial' | 'waiting' | 'failed' | 'none';

/** An extract job for the file in the queue now: waiting its turn
 *  (`queued`), being read (`running`), or held until the model provider
 *  answers again or, for an Agent's run, the day cap of paid asks has room
 *  (`waiting`; FileProcessing.wait says why and when). A file read before
 *  can have one: it is being read again. */
export type FileJob = 'queued' | 'running' | 'waiting';

/** Why a file's job waits, and until when (FileProcessing.wait). The
 *  provider's "not now": `rate_limit` (too many calls now), `quota` (the
 *  account has no credit left), `overloaded` (busy). Nothing is dropped: the
 *  job is tried again by itself. */
export type FileJobWait = {
  for: 'provider' | 'day_cap';
  reason?: 'rate_limit' | 'quota' | 'overloaded';
  /** The Agent pipeline whose run waits, when it is a run. */
  run?: string;
  /** When it is tried again (ISO). */
  until: string;
  /** One sentence for a person. */
  hint: string;
};

export type FileStatus = {
  ingest: FileIngest;
  /** Absent when no job for the file is in the queue. */
  job?: FileJob;
  /** The file's own database (its Data view): `ready`, a word for why it
   *  has no rows (`too-large`, `no-rows`, `unreadable`: unreadable is the
   *  failed one), or `not-built` yet. Absent for a file that has no Data
   *  view. */
  db?: DataFileState;
  /** Sent only when true: the file was read by an older reader (or its
   *  database by an older pipeline version) than the box has now, so a
   *  reindex would read it better. Absent: current, or unknown (read before
   *  the stamps). */
  stale?: boolean;
  /** The name of the Reader pipeline that built the file's database.
   *  Absent when none did (no database, or built before the stamps). */
  pipeline?: string;
};

/** What read a file's text: the core reader of its type (the parser
 *  route: 'pdf-parse', 'mammoth', 'exceljs', 'utf8', ..., or 'image' for a
 *  picture read by vision) and its version then. FileRow.readBy. */
export type FileReadBy = { reader: string; v: number };

/** The Reader pipeline that built a file's database, and its version
 *  then. FileRow.pipelineRead. */
export type FilePipelineRead = { id: string; name: string; version: string };

/** The read state of the file, as FileRow.extraction (the brain's
 *  extraction-status rule). */
export type FileProcessingExtraction = {
  state: 'indexed' | 'partial' | 'failed' | 'skipped' | 'pending' | 'name_only';
  reason?: string;
  /** One sentence for a person (a `partial` file: what was left out, each
   *  cut in turn). The client shows it as is. */
  hint?: string;
  pages?: { read: number; total: number };
  /** Pictures left out: the pictures kept and found (`more`: at least). */
  pictures?: { kept: number; found: number; more?: true };
  /** Each kind of cut (docs/files.md, "Read in part"). A `partial` file
   *  has the cuts that made it so; an `indexed` file may carry details
   *  only (`pictures_small`, `pictures_tiny`: icons and small pictures the
   *  size gate skipped; `archive`, `archive_sealed`: an archive's contents,
   *  never read but on a person's "Extract contents", which also make its
   *  `reason` and `hint`), which are no reason for a partial badge. Each cut:
   *  its key (`sheet_rows`, `text_store`, `pictures_small`, `ocr_pages`,
   *  `pictures`, `page_pictures`, ...), the unit, how many were read of how many (`atLeast`: the total
   *  is a lower bound), the limit, and its own sentence. */
  cuts?: FileReadCut[];
};

/** One kind of cut of a file read in part (FileProcessingExtraction.cuts). */
export type FileReadCut = {
  key: string;
  what: string;
  read: number;
  total?: number;
  atLeast?: true;
  limit?: number;
  hint: string;
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
   *  (read on the box with no model); null before the first read. 'full'
   *  is the indexing mode (the content was read, not the name only), not
   *  that every page was: a scan read in part is `extraction.state`
   *  'partial' with `extraction.pages`. */
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
  /** Facts taken from the file that are true now (a replaced fact is not
   *  counted). */
  facts: number;
  /** Entity mentions found in the file; null when they are not counted for
   *  this caller (entity edges are read in an Admin scope only). */
  mentions: number | null;
  /** The file's database, for a file with a Data view; null otherwise.
   *  `readBy`: the pipeline and version that built it (null before stamps
   *  or when not built). `tables`: what it extracted, each tab and its
   *  rows; only when built and readable by the caller (as the Data view). */
  /** A PDF book (read by the book reader): how its pages were read, counted
   *  from its database (docs/ai-workers.md, "The Scan reader"): `text` (text
   *  layer), `ocr` (local OCR, a book read by an older reader), `blank`,
   *  `scanReader` (the Agent pdf-page-read's read of a scanned page),
   *  `vision` (its description of a figure), `unread` (marked for the Agent,
   *  with no text: not read yet, no Scan reader, or a read judged bad). Left
   *  out for any other file. */
  bookPages?: {
    text: number;
    ocr: number;
    blank: number;
    scanReader: number;
    vision: number;
    unread: number;
    /** There are unread pages and this brain has no Scan reader: that is
     *  why (an OpenRouter key and the Scan reader worker read them). */
    noScanReader?: true;
  };
  database: {
    state: DataFileState;
    bytes: number | null;
    readBy: FileDatabaseReadBy | null;
    tables?: Array<{ name: string; rows: number }>;
    /** A file of many tabs: the tabs left out of `tables`, how many, and
     *  the tab that lists them (file_sql with no `sql` says how to read
     *  one). */
    tablesListed?: { count: number; in: string };
  } | null;
  /** An extract job in the queue now, or null. */
  job: FileJob | null;
  /** Why the job waits (`job` is `waiting`); absent otherwise. */
  wait?: FileJobWait;
  /** true: read by an older reader or pipeline version than the box has
   *  now (FileStatus.stale); false: by the current ones; null: unknown (no
   *  stamp: read before the stamps, or not read). */
  stale: boolean | null;
  /** The core reader that read the text, its version then, and the
   *  version in force (`current` null: no longer a known reader). Null
   *  with no stamp. */
  readBy: { reader: string; version: number; current: number | null } | null;
  /** The Reader pipeline that built the database, its version then, and
   *  the installed one (`current` null: not installed now). Null with no
   *  stamp. */
  pipelineRead: { id: string; name: string; version: string; current: string | null } | null;
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

/** The most files one reindex call takes. */
export const FILE_REINDEX_MAX = 200;

/** POST /api/files/reindex: the files to read again, 1 to FILE_REINDEX_MAX. */
export type FileReindexBody = { ids: string[] };

/** Why a file of a reindex call was not queued:
 *  - `not-found`: no such file, or the caller cannot read it;
 *  - `not-allowed`: the caller reads it but may not change it;
 *  - `in-queue`: a read of it is already queued or running;
 *  - `busy`: the read queue is busy; nothing was queued, try again later;
 *  - `bytes-missing`: the file's bytes could not be read now (gone from
 *    disk and object store, or the store unreachable): nothing it has was
 *    dropped; try again when the store is back. */
export type FileReindexSkip = 'not-found' | 'not-allowed' | 'in-queue' | 'busy' | 'bytes-missing';

/** The answer of a reindex: every id sent is counted in `queued` or named
 *  once in `skipped`. `databases`: of the queued files, those whose
 *  database Reader run was queued too. */
export type FileReindexAnswer = {
  queued: number;
  databases: number;
  skipped: Array<{ id: string; reason: FileReindexSkip }>;
};

/** The lists of GET /api/files/stale (`state`): read by an older reader or
 *  pipeline (`stale`), not read (`failed`), read in part (`partial`). */
export type FileStaleState = 'stale' | 'failed' | 'partial';

/** The most rows one page of GET /api/files/stale gives. */
export const FILE_STALE_MAX = 200;

/** GET /api/files/stale: one page, newest first. `files` are the file rows
 *  of GET /api/files/files (the client's FileRow, with `status`); `next`
 *  is the cursor of the next page (null: the last); `total` counts every
 *  file in the state the caller reads. */
export type FileStaleAnswer<Row = { id: string; status: FileStatus }> = {
  files: Row[];
  next: string | null;
  total: number;
};

/**
 * An archive's "Extract contents" (docs/files.md, "Archives"): never on
 * upload, only on a person's ask. GET /api/files/files/:id/extract answers
 * this for any file the caller reads; POST to the same path asks for the
 * extraction and answers it with the `queued` state. The tool
 * `file_extract_archive` does the same (with `check: true`, the GET).
 */
export type ArchiveExtractStateName = 'queued' | 'running' | 'done' | 'failed';

/** Why one entry of the archive was not written: a path that climbs out
 *  (`traversal`) or starts at a root (`absolute`), a name that cannot be
 *  one (`bad-name`), a link, a device or FIFO, an encrypted entry, a
 *  compression method or entry type this box does not read (`method`,
 *  `unsupported`), past the entry cap (`too-large`), bytes that do not
 *  match the archive's word (`damaged`), or a write that failed
 *  (`not-written`). */
export type ArchiveEntryRefusal =
  | 'traversal'
  | 'absolute'
  | 'bad-name'
  | 'link'
  | 'device'
  | 'encrypted'
  | 'method'
  | 'unsupported'
  | 'too-large'
  | 'damaged'
  | 'not-written';

export type ArchiveExtractView = {
  state: ArchiveExtractStateName;
  /** The folder made beside the archive for its contents (null only for a
   *  request whose folder could not be made). */
  folder: { id: string; path: string | null } | null;
  /** When it was asked, started and finished (ISO). */
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** So far while running; in all when done. */
  files: number;
  folders: number;
  bytes: number;
  /** macOS and Windows folder files left out (`__MACOSX/`, `.DS_Store`, ...). */
  skipped: number;
  /** Files whose deeper folders went into their name (the tree holds
   *  three folder levels below Files). */
  flattened: number;
  /** The first 100 entries not written, each with its reason;
   *  `refusedCount` counts them all. */
  refused: { name: string; reason: ArchiveEntryRefusal }[];
  refusedCount: number;
  /** A failed extraction: why, in a sentence. */
  error?: string;
};

export type ArchiveExtractAnswer = {
  file: { id: string; name: string };
  /** Whether "Extract contents" applies: a ZIP, TAR or gzip by its name and
   *  its first bytes. `why` says it when not. */
  extractable: boolean;
  why?: string;
  /** The last extraction asked, or null when none was. */
  extract: ArchiveExtractView | null;
};
