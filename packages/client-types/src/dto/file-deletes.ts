/**
 * A file delete's answers (F4 fix rounds 2 and 3; docs/actors.md, "F4 fix
 * round 3", the bulk delete's contract): what jackdaw reads back from
 * DELETE /api/files/files (bulk) and DELETE /api/files/files/:id?cascade=1.
 *
 * No name or id of an item the caller's scope does not read is ever in an
 * answer: such an item is a count (`hiddenDrawings`, `kept`, `keptTotal`)
 * or the `not_found` of an id no row has.
 */

/** What a file produced, by user-facing bucket (the has_derived preview and
 *  the confirmed cascade's reap). Counts every derived item, ones the
 *  caller does not read included. */
export type FileDerivedCounts = {
  images: number;
  tables: number;
  pages: number;
  notes: number;
  other: number;
  total: number;
};

/**
 * Why one id of a bulk delete was not deleted:
 *  - `not_found`: no file has the id, or one the caller's scope does not
 *    read (one answer: the two are never told apart);
 *  - `forbidden`: the caller reads the file but may not delete it (deleting
 *    is for a Moderator of its workspace);
 *  - `in_drawing`: a drawing places it on its canvas;
 *  - `attachment`: an email attachment (delete it from the email).
 */
export type FileDeleteRefusalReason = 'not_found' | 'forbidden' | 'in_drawing' | 'attachment';

/** One id a bulk delete did not delete, and why (never a silent skip). */
export type BulkDeleteRefusal = {
  fileId: string;
  reason: FileDeleteRefusalReason;
  /** On `in_drawing`: the drawings placing it that the caller reads. */
  drawings?: Array<{ id: string; title: string }>;
  /** On `in_drawing`: how many more place it that the caller does not read,
   *  when any. */
  hiddenDrawings?: number;
};

/** DELETE /api/files/files `{ ids }` (no cascade): 200. */
export type BulkDeleteFilesResponse = {
  deleted: number;
  /** Files not deleted because ingest derived items from them: confirm,
   *  then send these ids again with `cascade: true`. */
  hasDerived: Array<{ fileId: string; derived: FileDerivedCounts }>;
  refused: BulkDeleteRefusal[];
};

/** DELETE /api/files/files `{ ids, cascade: true }`: 200. */
export type BulkDeleteCascadeResponse = {
  deleted: number;
  /** Always empty on a cascade. */
  hasDerived: [];
  /** Derived items reaped, over every file. */
  reapedTotal: number;
  /** Derived items kept because the caller may not delete them (in a
   *  workspace it does not manage, or one it does not read): left in place,
   *  over every file (F4 fix round 3). */
  keptTotal: number;
  refused: BulkDeleteRefusal[];
};

/** DELETE /api/files/files/:id?cascade=1: 200 once the file is deleted. */
export type FileCascadeDeleteResponse = {
  ok: true;
  reaped: FileDerivedCounts;
  /** Derived items the reap could not delete (audit-visible). */
  skipped: number;
  /** Derived items kept because the caller may not delete them: a count,
   *  never a name (F4 fix round 3). */
  kept: number;
};
