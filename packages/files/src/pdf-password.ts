/**
 * Read a password-protected PDF's text layer. Financial statements typically
 * arrive encrypted (password = an ID/account fragment) but ARE digital
 * text-layer PDFs once unlocked — so opening them with pdfjs and pulling the
 * text covers the common case without rasterizing. The extractor calls this
 * with each vaulted password until one opens the document.
 *
 * pdfjs is the only tool in the stack that takes a password (pdf-parse /
 * pdf-to-png-converter don't expose one), and it's already present via
 * pdf-to-png-converter — promoted to a direct dep here.
 *
 * Returns:
 *  - { ok: true, text }              — opened and got a text layer
 *  - { ok: false, reason: 'password' } — wrong/needed password (try another)
 *  - { ok: false, reason: 'no_text' }  — opened, but no extractable text
 *    (scanned-and-encrypted — would need render+OCR with the password, a
 *    later enhancement)
 *  - { ok: false, reason: 'error' }    — corrupt / unreadable
 */
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
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (err) {
    return { ok: false, reason: 'error', message: `pdfjs load failed: ${(err as Error).message}` };
  }
  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      password,
      useSystemFonts: true,
    }).promise;
    const parts: string[] = [];
    const n = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      parts.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
    }
    await doc.destroy().catch(() => {});
    const text = parts.join('\n').trim();
    if (!text) return { ok: false, reason: 'no_text' };
    return { ok: true, text, numPages: doc.numPages };
  } catch (err) {
    // pdfjs throws a PasswordException (name) for wrong/missing passwords.
    const name = (err as { name?: string }).name ?? '';
    const message = (err as Error).message ?? String(err);
    if (/password/i.test(name) || /password/i.test(message)) {
      return { ok: false, reason: 'password', message };
    }
    return { ok: false, reason: 'error', message };
  }
}
