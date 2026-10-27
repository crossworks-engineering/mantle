/**
 * The picture readers: a document's embedded images, by format, in reading
 * order, gated and capped. The parser service's picture read (server/parser,
 * route POST /images); the brain asks for it through the parser client
 * (`extractEmbeddedImages` in ./embedded-images.ts, which also holds the
 * gate, the naming and the reasons document order matters).
 *
 * Runs only inside the parser container. Zip-based formats are inflated
 * once under the caps first (./zip-guard.ts); the container's memory limit
 * and the job's time limit stop what a cap does not.
 */

import {
  gateAndCap,
  MAX_EMBEDDED_IMAGES_PER_DOC,
  type EmbeddedImage,
  type ExtractEmbeddedImagesResult,
} from './embedded-images';
import type { DwfRenderFn } from './dwf';
import { ANYDOC_EXTS, LEGACY_SHEET_EXTS, ODF_EXTS } from './slug';
import { assertZipWithinLimits } from './zip-guard';

/** Pictures from anydoc's document model: the formats it reads, less
 *  OpenDocument, whose zip is read directly (./ooxml-media.ts). The legacy
 *  sheets are not among them: anydoc's sheet reader carries no pictures, so a
 *  binary `.xls` gives none (Tika's /unpack did; docs/file-ingestion.md). */
const ANYDOC_IMAGE_EXTS = new Set<string>([...ANYDOC_EXTS].filter((ext) => !ODF_EXTS.has(ext)));

const ZIP_IMAGE_EXTS = new Set(['docx', 'pptx', 'xlsx', 'xlsm', 'epub', 'vsdx', ...ODF_EXTS]);

function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32BE(0) === 0x504b0304;
}

/** Format dispatch. Each branch returns candidates in document order with a
 *  provisional ordinal; gating and renumbering happen in `gateAndCap`. */
async function extractRaw(
  bytes: Buffer,
  ext: string,
  opts: { maxImages: number; render?: DwfRenderFn; dpi?: number },
): Promise<EmbeddedImage[]> {
  if (ext === 'docx') return (await import('./docx')).extractDocxImages(bytes);
  if (ext === 'pdf') return (await import('./pdf')).extractPdfImages(bytes);
  if (ext === 'pptx' || ext === 'xlsx' || ext === 'xlsm') {
    return (await import('./ooxml-media')).extractOoxmlImages(bytes, ext);
  }
  if (ODF_EXTS.has(ext)) return (await import('./ooxml-media')).extractOdfImages(bytes);
  // An .xlsx under a legacy sheet name is read as what it is.
  if (LEGACY_SHEET_EXTS.has(ext)) {
    const { isOoxmlWorkbook } = await import('./legacy-sheet');
    if (isOoxmlWorkbook(bytes))
      return (await import('./ooxml-media')).extractOoxmlImages(bytes, 'xlsx');
    return [];
  }
  // DWF plot sets: one raster per published sheet, marked essential (the
  // format guarantees content-ness). The cap is forwarded so the renderer
  // never draws sheets the gate would discard.
  if (ext === 'dwf') {
    return (await import('./dwf')).extractDwfImages(bytes, {
      maxSheets: opts.maxImages,
      ...(opts.render ? { render: opts.render } : {}),
      ...(opts.dpi ? { dpi: opts.dpi } : {}),
    });
  }
  if (ANYDOC_IMAGE_EXTS.has(ext)) return (await import('./anydoc')).anydocImages(bytes, ext);
  if (ext === 'vsdx') return (await import('./vsdx')).vsdxImages(bytes);
  return [];
}

/**
 * Every embedded image of a document, in reading order, gated and capped.
 * Returns an empty result for a format with no picture reader; throws on a
 * document its reader cannot open (and a DocumentTooLargeError past a cap).
 */
export async function readEmbeddedImages(
  bytes: Buffer,
  ext: string,
  opts?: { maxImages?: number; render?: DwfRenderFn; dpi?: number },
): Promise<ExtractEmbeddedImagesResult> {
  const cap = Math.max(0, opts?.maxImages ?? MAX_EMBEDDED_IMAGES_PER_DOC);
  const lower = ext.toLowerCase();
  if (ZIP_IMAGE_EXTS.has(lower) && isZip(bytes)) await assertZipWithinLimits(bytes);
  const raw = await extractRaw(bytes, lower, {
    maxImages: cap,
    ...(opts?.render ? { render: opts.render } : {}),
    ...(opts?.dpi ? { dpi: opts.dpi } : {}),
  });
  return gateAndCap(raw, cap);
}
