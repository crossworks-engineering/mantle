/**
 * The one error a document read throws when the DOCUMENT is the problem
 * because of its size or shape, not because it is corrupt: a decompression
 * bomb, a sheet that spans millions of empty cells, embedded media past the
 * reader's budget, a read that ran out of time or memory in its worker.
 *
 * The extractor turns it into a terminal skip (`document_too_large`) with the
 * message as the hint, so the file is not retried on every restart and the
 * owner can see why its text is missing. A malformed or encrypted file keeps
 * throwing a plain error, as before.
 *
 * Kept free of imports so the parse worker (./isolate-worker.ts) and the
 * main thread share it.
 */

export type DocumentLimitReason =
  /** The read did not finish within its time limit. */
  | 'timeout'
  /** The read needed more memory than a document read may use. */
  | 'memory'
  /** The read's worker stopped without an answer. */
  | 'stopped'
  /** A reader's own safety limit (anydoc's `resourceLimit`). */
  | 'reader_limit'
  /** A size checked before reading: a zip part, a sheet's cell count. */
  | 'too_large';

export class DocumentLimitError extends Error {
  readonly reason: DocumentLimitReason;
  constructor(reason: DocumentLimitReason, message: string) {
    super(message);
    this.name = 'DocumentLimitError';
    this.reason = reason;
  }
}

/** True for a {@link DocumentLimitError}, also one rebuilt from a worker's
 *  message or loaded twice under different module instances. */
export function isDocumentLimitError(err: unknown): err is DocumentLimitError {
  return (
    err instanceof DocumentLimitError ||
    (err instanceof Error &&
      err.name === 'DocumentLimitError' &&
      typeof (err as { reason?: unknown }).reason === 'string')
  );
}
