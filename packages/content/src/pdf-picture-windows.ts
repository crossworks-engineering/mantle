/**
 * The pictures of a PDF read in page windows (task 8d40932a, G2;
 * docs/file-ingestion.md): a file past the size pdfjs opens
 * (`PDF_MAX_BYTES`, 256 MB), or the pages of a long one past those one read
 * scans (`MAX_PDF_PAGES_SCANNED`). Each window is cut by qpdf in the parser
 * (pdfWindows, ./pipeline-runner.ts) and read by the parser's picture job
 * with the cap left over; the reading order, each picture's page on the
 * original file and the sha256 dedupe hold across windows. A window past
 * the cap still counts what it leaves out (`over_cap`), so the file can say
 * "N of M pictures kept" (G4). A window that could not be cut or read is
 * counted (`windowsFailed`) and the next goes on. A busy parser throws: the
 * extract tries again. No model and no write here: the caller (the
 * extract's picture pass, server/api/src/agent/extract/images.ts) saves and
 * stamps.
 */
import { createHash } from 'node:crypto';
import { PIPELINE_WINDOW_DEFAULT, isParserError, parserImages } from '@mantle/files';
import type { ExtractEmbeddedImagesResult } from '@mantle/files/embedded-images';
import { pdfWindows } from './pipeline-runner';

/** A picture read of a whole PDF, with the windows it could not read. */
export type PdfPicturesRead = ExtractEmbeddedImagesResult & { windowsFailed: number };

/** Whether the picture pass reads this PDF in page windows: past the size
 *  pdfjs opens, or a first read that scanned fewer pages than the file has. */
export function picturesNeedWindows(
  bytes: number,
  maxBytes: number,
  whole: ExtractEmbeddedImagesResult | null,
): boolean {
  if (bytes > maxBytes || !whole) return true;
  return whole.pdf !== undefined && whole.pdf.pagesScanned < whole.pdf.pagesTotal;
}

/**
 * Read the pictures of `bytes` (a PDF) by page windows, after `whole` (the
 * one read of the first pages, or null for a file past the size pdfjs
 * opens), keeping at most `cap` in all.
 */
export async function picturesByWindows(
  bytes: Buffer,
  cap: number,
  whole: ExtractEmbeddedImagesResult | null,
  window: { pages: number; mb: number } = PIPELINE_WINDOW_DEFAULT,
): Promise<PdfPicturesRead> {
  const images = [...(whole?.images ?? [])];
  const rejected: ExtractEmbeddedImagesResult['rejected'] = { ...(whole?.rejected ?? {}) };
  let candidates = whole?.candidates ?? 0;
  let windowsFailed = 0;
  const seen = new Set(images.map((i) => i.sha256));
  const start = whole?.pdf ? whole.pdf.pagesScanned + 1 : 1;
  const sha = createHash('sha256').update(bytes).digest('hex');
  for await (const w of pdfWindows(bytes, sha, window, start)) {
    if (!w.part) {
      windowsFailed += 1;
      continue;
    }
    const { part } = w;
    let got: ExtractEmbeddedImagesResult;
    try {
      got = await parserImages(part.bytes, 'pdf', { maxImages: Math.max(0, cap - images.length) });
    } catch (err) {
      if (isParserError(err) && err.retryable) throw err;
      windowsFailed += 1;
      continue;
    }
    candidates += got.candidates;
    for (const [k, v] of Object.entries(got.rejected)) {
      const key = k as keyof ExtractEmbeddedImagesResult['rejected'];
      rejected[key] = (rejected[key] ?? 0) + (v ?? 0);
    }
    for (const img of got.images) {
      if (seen.has(img.sha256)) {
        rejected.duplicate = (rejected.duplicate ?? 0) + 1;
        continue;
      }
      if (images.length >= cap) {
        rejected.over_cap = (rejected.over_cap ?? 0) + 1;
        continue;
      }
      seen.add(img.sha256);
      // The page of the original file, and the order over every window.
      const page = img.location?.page;
      images.push({
        ...img,
        ordinal: images.length + 1,
        ...(page !== undefined
          ? { location: { ...img.location, page: page + part.pageFrom - 1 } }
          : {}),
      });
    }
  }
  return { images, rejected, candidates, windowsFailed };
}

/** The pictures a read left out: over the cap, past the parser's answer
 *  budget, and one at least for each window it could not read (its
 *  pictures are not known). 0: none. */
export function picturesLeftOutOf(read: PdfPicturesRead): number {
  const r = read.rejected as Record<string, number | undefined>;
  return (r.over_cap ?? 0) + (r.answer_budget ?? 0) + read.windowsFailed;
}
