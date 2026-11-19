/**
 * The pictures of a PDF read in page windows (task 8d40932a, G2;
 * docs/file-ingestion.md): a file past the size pdfjs opens
 * (`PDF_MAX_BYTES`, 256 MB), the pages of a long one past those one read
 * scans (`MAX_PDF_PAGES_SCANNED`), and a file whose one read left pictures
 * out (more than one job keeps, or past one answer's bytes).
 *
 * Every picture of every PDF is kept (Jason, 2026-11-19: "Yes, no cap").
 * Nothing is capped, the work is paced: each window is cut by qpdf in the
 * parser (pdfWindows, ./pipeline-runner.ts) and read by the parser's picture
 * job; a window whose answer left pictures out (`over_cap` past the job's
 * MAX_EMBEDDED_IMAGES_CEILING, or `answer_budget` past one answer's bytes)
 * is cut again in halves and each half read, down to one page. Each
 * picture goes to disk as it comes (SpooledPictures), so the brain holds one
 * window's answer at most; a kept picture's `bytes` is read from disk when
 * the caller asks for it (the save, one at a time). The reading order, each
 * picture's page on the original file and the sha256 dedupe hold across
 * windows.
 *
 * Only what truly cannot be read is left out, and counted: a window the
 * parser cannot cut or read (`windowsFailed`), and a single page whose
 * pictures pass one answer even alone (its rejections stay in `rejected`).
 * The file then says "N of M pictures kept" (G4). A busy parser throws: the
 * extract tries again. No model and no write here: the caller (the
 * extract's picture pass, server/api/src/agent/extract/images.ts) saves and
 * stamps.
 */
import { createHash } from 'node:crypto';
import {
  MAX_EMBEDDED_IMAGES_CEILING,
  PIPELINE_WINDOW_DEFAULT,
  parserImages,
  parserPdfSplit,
} from '@mantle/files';
import type { EmbeddedImage, ExtractEmbeddedImagesResult } from '@mantle/files/embedded-images';
import { SpooledPictures } from './picture-spool';
import { isWindowLost, pdfWindows, windowJob, type PdfWindowPart } from './pipeline-runner';

/** A picture read of a whole PDF, with the windows it could not read, and
 *  whether a count past the cap was cut short (then what it left out is a
 *  floor). `spool`: where the kept pictures' bytes are, when they were read
 *  by windows; the caller drops it once it saved them. */
export type PdfPicturesRead = ExtractEmbeddedImagesResult & {
  windowsFailed: number;
  countCut?: boolean;
  spool?: SpooledPictures;
};

/** The rejections that leave a picture out (the others are no picture:
 *  an icon, a duplicate, a metafile). */
const LEFT_OUT = ['over_cap', 'answer_budget'] as const;

function leftOutOf(r: ExtractEmbeddedImagesResult['rejected']): number {
  const x = r as Record<string, number | undefined>;
  return LEFT_OUT.reduce((n, k) => n + (x[k] ?? 0), 0);
}

/** Whether the picture pass reads this PDF in page windows: past the size
 *  pdfjs opens, a first read that scanned fewer pages than the file has, or
 *  one that left pictures out (no cap: they are fetched by smaller cuts). */
export function picturesNeedWindows(
  bytes: number,
  maxBytes: number,
  whole: ExtractEmbeddedImagesResult | null,
): boolean {
  if (bytes > maxBytes || !whole) return true;
  if (leftOutOf(whole.rejected) > 0) return true;
  return whole.pdf !== undefined && whole.pdf.pagesScanned < whole.pdf.pagesTotal;
}

/** A kept picture whose bytes are on disk: read when asked for. */
function spooled(meta: Omit<EmbeddedImage, 'bytes'>, spool: SpooledPictures, name: string) {
  const img = { ...meta } as EmbeddedImage;
  Object.defineProperty(img, 'bytes', {
    enumerable: true,
    get: () => spool.get(name) ?? Buffer.alloc(0),
  });
  return img;
}

/**
 * Read every picture of `bytes` (a PDF) by page windows, after `whole` (the
 * one read of the first pages, or null for a file past the size pdfjs
 * opens). A `whole` that left pictures out is read again from page 1 by
 * windows. `perJob`: the pictures one parser job keeps (a pace, not a cap:
 * a window past it is cut again).
 */
export async function picturesByWindows(
  bytes: Buffer,
  perJob: number,
  whole: ExtractEmbeddedImagesResult | null,
  window: { pages: number; mb: number } = PIPELINE_WINDOW_DEFAULT,
  opts: { scanBook?: boolean } = {},
): Promise<PdfPicturesRead> {
  const jobMax = Math.max(1, Math.min(perJob, MAX_EMBEDDED_IMAGES_CEILING));
  const spool = new SpooledPictures();
  const images: EmbeddedImage[] = [];
  const rejected: ExtractEmbeddedImagesResult['rejected'] = {};
  let candidates = 0;
  let windowsFailed = 0;
  let countCut = false;
  const seen = new Set<string>();
  const sha = createHash('sha256').update(bytes).digest('hex');
  const keep = (img: EmbeddedImage, pageFrom: number) => {
    if (seen.has(img.sha256)) {
      rejected.duplicate = (rejected.duplicate ?? 0) + 1;
      return;
    }
    seen.add(img.sha256);
    const name = `${images.length + 1}`;
    spool.put(name, img.bytes);
    const page = img.location?.page;
    const { bytes: _bytes, ...meta } = img;
    images.push(
      spooled(
        {
          ...meta,
          ordinal: images.length + 1,
          ...(page !== undefined
            ? { location: { ...img.location, page: page + pageFrom - 1 } }
            : {}),
        },
        spool,
        name,
      ),
    );
  };
  const add = (got: ExtractEmbeddedImagesResult, pageFrom: number, final: boolean) => {
    candidates += got.candidates;
    if (got.pdf?.countCut) countCut = true;
    for (const [k, v] of Object.entries(got.rejected)) {
      // A part cut again counts its pictures there: its left-out count is
      // no loss unless it is final (one page).
      if (!final && (LEFT_OUT as readonly string[]).includes(k)) continue;
      const key = k as keyof ExtractEmbeddedImagesResult['rejected'];
      rejected[key] = (rejected[key] ?? 0) + (v ?? 0);
    }
    for (const img of got.images) keep(img, pageFrom);
  };

  const leftWhole = whole !== null && leftOutOf(whole.rejected) > 0;
  let start = 1;
  if (whole && !leftWhole) {
    add(whole, 1, true);
    start = whole.pdf ? whole.pdf.pagesScanned + 1 : 1;
  }
  const notScanOf = () => !opts.scanBook && images.length > 0;

  /** Read one part; a part that left pictures out is cut in halves. */
  const readPart = async (part: PdfWindowPart): Promise<void> => {
    const got = await windowJob(() =>
      parserImages(part.bytes, 'pdf', {
        maxImages: jobMax,
        // Once the file is known to hold pictures, a window of one picture a
        // page is no scan: its pictures are read (the scan rule of one read,
        // packages/files/src/pdf.ts, judges a whole file, not 50 pages of
        // it). Not for a book whose Reader pictures its scanned pages (G1).
        ...(notScanOf() ? { notScan: true } : {}),
      }),
    );
    if (isWindowLost(got)) {
      windowsFailed += 1;
      return;
    }
    const pages = part.pageTo - part.pageFrom + 1;
    if (leftOutOf(got.rejected) === 0 || pages === 1) {
      add(got, part.pageFrom, true);
      return;
    }
    // Too many or too large for one answer: two halves, each read alone.
    const half = Math.ceil(pages / 2);
    for (const [from, n] of [
      [part.pageFrom, half],
      [part.pageFrom + half, pages - half],
    ] as const) {
      const cut = await windowJob(() =>
        parserPdfSplit(bytes, { from, pages: n, mb: window.mb, sha256: sha }),
      );
      if (isWindowLost(cut)) {
        windowsFailed += 1;
        continue;
      }
      await readPart(cut);
      // qpdf may cut fewer pages than asked (the MB bound): the rest of the
      // half is read on.
      let next = cut.pageTo + 1;
      while (next < from + n) {
        const rest = await windowJob(() =>
          parserPdfSplit(bytes, { from: next, pages: from + n - next, mb: window.mb, sha256: sha }),
        );
        if (isWindowLost(rest)) {
          windowsFailed += 1;
          break;
        }
        await readPart(rest);
        next = rest.pageTo + 1;
      }
    }
  };

  for await (const w of pdfWindows(bytes, sha, window, start, whole?.pdf?.pagesTotal)) {
    if (!w.part) {
      windowsFailed += 1;
      continue;
    }
    await readPart(w.part);
  }
  return {
    images,
    rejected,
    candidates,
    windowsFailed,
    spool,
    ...(countCut ? { countCut } : {}),
  };
}

/** The pictures a read left out: past one answer even for one page, and
 *  one at least for each window it could not read (its pictures are not
 *  known). 0: none. */
export function picturesLeftOutOf(read: PdfPicturesRead): number {
  return leftOutOf(read.rejected) + read.windowsFailed;
}
