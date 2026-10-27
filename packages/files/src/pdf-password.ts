/**
 * Read a password-protected PDF's text layer. Financial statements typically
 * arrive encrypted (password = an ID/account fragment) but ARE digital
 * text-layer PDFs once unlocked — so opening them with pdfjs and pulling the
 * text covers the common case without rasterizing. The extractor calls this
 * with each vaulted password until one opens the document.
 *
 * pdfjs is the tool here that takes a password; it is a direct dep, opened
 * through `openPdf` like every other pdfjs read in this package.
 *
 * Returns:
 *  - { ok: true, text }              — opened and got a text layer
 *  - { ok: false, reason: 'password' } — wrong/needed password (try another)
 *  - { ok: false, reason: 'no_text' }  — opened, but no extractable text
 *    (scanned-and-encrypted — would need render+OCR with the password, a
 *    later enhancement)
 *  - { ok: false, reason: 'error' }    — corrupt / unreadable
 */
import { openPdf } from './pdf-open';

export type PdfPasswordResult =
  | { ok: true; text: string; numPages: number }
  | { ok: false; reason: 'password' | 'no_text' | 'error'; message?: string };

const DEFAULT_MAX_PAGES = 15;

export async function extractPdfTextWithPassword(
  bytes: Buffer,
  password: string,
  opts?: { maxPages?: number },
): Promise<PdfPasswordResult> {
  const maxPages = Math.max(1, opts?.maxPages ?? DEFAULT_MAX_PAGES);
  // pdfjs 6 moved destroy() off PDFDocumentProxy onto the loading task, so the
  // task is what must be held and torn down: it owns the worker. The `finally`
  // below reaches it on the failure path too: the wrong-password case is this
  // function's most common outcome, and it used to leak a worker every time
  // (the old doc.destroy() only ran on success).
  let loadingTask: Awaited<ReturnType<typeof openPdf>>['task'];
  try {
    ({ task: loadingTask } = await openPdf(bytes, { password, useSystemFonts: true }));
  } catch (err) {
    return { ok: false, reason: 'error', message: `pdfjs load failed: ${(err as Error).message}` };
  }
  try {
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
    await loadingTask.destroy().catch(() => {});
  }
}
