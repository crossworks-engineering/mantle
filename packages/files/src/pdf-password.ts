/**
 * Read a password-protected PDF's text layer. Financial statements typically
 * arrive encrypted (password = an ID/account fragment) but ARE digital
 * text-layer PDFs once unlocked — so opening them with pdfjs and pulling the
 * text covers the common case without rasterizing. The extractor calls this
 * with each vaulted password until one opens the document.
 *
 * pdfjs takes the password directly; it is opened through ./pdfjs.ts, the
 * one entry point with the package's limits, in a worker thread.
 *
 * Returns:
 *  - { ok: true, text }              — opened and got a text layer
 *  - { ok: false, reason: 'password' } — wrong/needed password (try another)
 *  - { ok: false, reason: 'no_text' }  — opened, but no extractable text
 *    (scanned-and-encrypted — would need render+OCR with the password, a
 *    later enhancement)
 *  - { ok: false, reason: 'error' }    — corrupt / unreadable
 */

import { errorMessage } from '@mantle/std';

export type PdfPasswordResult =
  | { ok: true; text: string; numPages: number }
  | { ok: false; reason: 'password' | 'no_text' | 'error'; message?: string };

const DEFAULT_MAX_PAGES = 15;

/** The text layer with this password, read in a worker thread
 *  (./isolate.ts). A read stopped by a limit is an `error`. */
export async function extractPdfTextWithPassword(
  bytes: Buffer,
  password: string,
  opts?: { maxPages?: number },
): Promise<PdfPasswordResult> {
  const maxPages = Math.max(1, opts?.maxPages ?? DEFAULT_MAX_PAGES);
  const { runIsolated } = await import('./isolate');
  return runIsolated('pdfTextWithPassword', [bytes, password, maxPages]).catch(
    (err: unknown): PdfPasswordResult => ({
      ok: false,
      reason: 'error',
      message: errorMessage(err),
    }),
  );
}

/** {@link extractPdfTextWithPassword} on the calling thread: the parse
 *  worker's job. */
export async function extractPdfTextWithPasswordInProcess(
  bytes: Buffer,
  password: string,
  maxPages: number,
): Promise<PdfPasswordResult> {
  const { openPdf } = await import('./pdfjs');
  // pdfjs 6 moved destroy() off PDFDocumentProxy onto the loading task, so the
  // task is what must be held and torn down — it owns the worker. Declared out
  // here so the `finally` reaches it on the failure path too: the wrong-password
  // case is this function's most common outcome, and it used to leak a worker
  // every time (the old doc.destroy() only ran on success).
  let loadingTask: Awaited<ReturnType<typeof openPdf>> | null = null;
  try {
    loadingTask = await openPdf(bytes, { password });
    const doc = await loadingTask.promise;
    const numPages = doc.numPages;
    const parts: string[] = [];
    const n = Math.min(numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      parts.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
    }
    const text = parts.join('\n').trim();
    if (!text) return { ok: false, reason: 'no_text' };
    return { ok: true, text, numPages };
  } catch (err) {
    // pdfjs throws a PasswordException (name) for wrong/missing passwords.
    const name = (err as { name?: string }).name ?? '';
    const message = (err as Error).message ?? String(err);
    if (/password/i.test(name) || /password/i.test(message)) {
      return { ok: false, reason: 'password', message };
    }
    return { ok: false, reason: 'error', message };
  } finally {
    await loadingTask?.destroy().catch(() => {});
  }
}
