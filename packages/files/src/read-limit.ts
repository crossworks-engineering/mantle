/**
 * The error a document reader throws when the DOCUMENT is past a size check
 * it can make cheaply before (or while) reading: a zip part that inflates
 * past its cap, a legacy sheet laid out past its cell budget, anydoc's own
 * resource limit. The parser service (server/parser) answers it as
 * `too_large`; the brain sees that code from the parser client.
 *
 * These checks are the cheap, early refusals. They are not the safety
 * guarantee: every reader runs only inside the parser container, whose OS
 * memory limit and per-job time limit stop whatever a check does not.
 *
 * Kept free of imports so any reader can throw it.
 */
export class DocumentTooLargeError extends Error {
  readonly code = 'too_large' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DocumentTooLargeError';
  }
}

/** True for a {@link DocumentTooLargeError}, also one loaded twice. */
export function isDocumentTooLarge(err: unknown): err is DocumentTooLargeError {
  return (
    err instanceof DocumentTooLargeError ||
    (err instanceof Error &&
      err.name === 'DocumentTooLargeError' &&
      (err as { code?: unknown }).code === 'too_large')
  );
}
