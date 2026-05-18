/**
 * PDF text extraction. Thin wrapper around `pdf-parse`.
 *
 * Returns the embedded text layer. Scanned-image PDFs come back as ''
 * (no OCR — that's a separate problem for another day). Encrypted PDFs
 * and corrupt files throw; callers swallow the error and fall back to
 * the file's title so the extractor can still index *something*.
 *
 * Kept as a separate entry point (`@mantle/files/pdf`) so the heavy
 * `pdf-parse` dep is only loaded when a PDF actually shows up — the
 * rest of the files surface stays free of native bindings.
 */

import pdfParse from 'pdf-parse';

export async function parsePdf(buf: Buffer): Promise<string> {
  const result = await pdfParse(buf);
  return (result.text ?? '').trim();
}
