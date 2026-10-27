/**
 * The one error a document read throws when the DOCUMENT is the problem
 * because of its size or shape, not because it is corrupt: a decompression
 * bomb, a sheet that spans millions of empty cells, embedded media past the
 * reader's budget, a read that ran out of time or memory in its worker.
 *
 * The extractor turns it into a terminal skip (`document_too_large`) with the
 * message as the hint, so the file is not retried on every restart and the
 * owner can see why its text is missing. A malformed or encrypted file keeps
 * throwing a plain error, as before. A read that could not run or finish for
 * a reason that is not the document's throws a
 * {@link DocumentReadRetryableError} instead (below), which is retried.
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

/**
 * A read that did not happen, or did not finish, for a reason that is not
 * the document's: every read slot busy past the wait deadline, the wait
 * queue full, or a first time-out (a loaded box can be slow once; the same
 * bytes timing out twice is the document, see ./isolate.ts). Never a
 * terminal skip: the extractor lets the job fail so it is retried, and a
 * chat turn answers that the file could not be read just now.
 */
export class DocumentReadRetryableError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'DocumentReadRetryableError';
  }
}

/** True for a {@link DocumentReadRetryableError}, also one loaded twice. */
export function isRetryableReadError(err: unknown): err is DocumentReadRetryableError {
  return (
    err instanceof DocumentReadRetryableError ||
    (err instanceof Error &&
      err.name === 'DocumentReadRetryableError' &&
      (err as { retryable?: unknown }).retryable === true)
  );
}
