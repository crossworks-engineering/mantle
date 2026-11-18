/**
 * A file's compact status, for the icon badge in Files (docs/files.md,
 * "Status and processing"): was its content read into the brain, is a read
 * in the queue now, and the state of its database. Derived live, from what
 * the file row and the queue already say: no new state to keep in step.
 *
 *  - `ingest` comes from the one rule of a file's read (extractionOf):
 *    indexed is `done`, partial `partial`, failed `failed`, not read yet
 *    `waiting`; a file kept to its name or with nothing to read is `none`.
 *  - `job` is an extract job in the queue for the file now (ONE read for a
 *    whole list: extractJobsFor in @mantle/db). A file read before can
 *    have one too: it is being read again.
 *  - `db` is the state of the file's own database, for a file that has a
 *    Data view (withDataView); absent for every other file.
 *
 * The same shape is `FileStatus` in @mantle/client-types (dto/file-status),
 * the contract the client reads.
 *
 * Pure, with no imports but types: the lists, the tree and the tests share it.
 */
import type { ExtractionState } from './extraction-status';
import type { DataFileState } from './file-db-list';

export type FileIngest = 'done' | 'partial' | 'waiting' | 'failed' | 'none';
export type FileJob = 'queued' | 'running';

export type FileStatus = {
  ingest: FileIngest;
  job?: FileJob;
  db?: DataFileState;
  /** RESERVED (part P5): read by an older extractor than the current one.
   *  Never set today: no extractor version is kept per file. */
  stale?: boolean;
};

/** The ingest word of an extraction state. */
export function ingestOf(state: ExtractionState): FileIngest {
  switch (state) {
    case 'indexed':
      return 'done';
    case 'partial':
      return 'partial';
    case 'failed':
      return 'failed';
    case 'pending':
      return 'waiting';
    case 'skipped':
    case 'name_only':
      return 'none';
  }
}

/** A file's status from its extraction state, its job and its database. */
export function fileStatusOf(args: {
  extraction: ExtractionState;
  job?: FileJob;
  db?: DataFileState;
}): FileStatus {
  return {
    ingest: ingestOf(args.extraction),
    ...(args.job ? { job: args.job } : {}),
    ...(args.db ? { db: args.db } : {}),
  };
}
