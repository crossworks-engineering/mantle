/**
 * Embedded images → standalone image buffers, dispatched by extension.
 *
 * A diagram in a Word doc, a screenshot in a PDF manual, a chart pasted into
 * a spreadsheet: every text parser we have throws these away, because their
 * job is "what does this document *say*". Some answers can't be said — a
 * screenshot of a settings screen has to be *shown*. This module is the one
 * place that pulls those pictures back out, so the extractor can save them as
 * real image files the assistant can show inline in chat and in Pages.
 *
 * Mirrors `parseDocumentBytes` (./parse.ts) deliberately — same three-tier
 * shape, same never-throws-on-the-long-tail posture, same lazy imports so a
 * format's heavy dep only loads when that format actually shows up:
 *
 *   1. In-process, no network — docx (via mammoth's parsed AST), pptx/xlsx/
 *      ODF (they're zips; read the media parts), pdf (via pdfjs).
 *   2. Apache Tika `/unpack/all` for the legacy binaries no in-process parser
 *      handles: .doc / .ppt / .xls / .rtf / .vsd. Never-throws → [].
 *   3. `[]` for anything else.
 *
 * ## Document order is the product requirement, not a nicety
 *
 * A manual's screenshots are only useful *in sequence* — "step 7" has to be
 * the seventh image. Zip entry names (`image1.png`, `image2.png`) are NOT
 * document order: Word numbers media parts by when they were first embedded,
 * so an image inserted later but positioned earlier sorts wrong, and a reused
 * image appears once in `word/media/` but many times in the text. Every
 * extractor here therefore walks the *document body* and resolves each
 * reference to its part, rather than listing the media folder. `ordinal` is
 * 1-based reading order and is what the caller sorts and names by.
 *
 * ## The cost gate lives here, and it runs before any LLM does
 *
 * A 60-slide deck carries 100+ images — logos, bullets, icons, one per
 * slide. Feeding those to the vision worker would be one LLM call each: the
 * runaway-spend failure mode the repo's cost-safety rule exists to prevent.
 * So extraction is deliberately split from enrichment. Pulling bytes out is
 * free and always happens; `passesGate` then drops the decoration using only
 * cheap, deterministic signals (container, pixel dimensions, byte size,
 * duplicate content). Only survivors are worth a vision call, and the caller
 * caps how many of those it will pay for. Nothing in this file calls an LLM.
 */

import { createHash } from 'node:crypto';
import { sniffImage } from './image-probe';
import { extOf, slugifyFolder, TIKA_EXTS } from './slug';

/** Where the image sits in its source document. Which field is populated
 *  depends on what the format can tell us: PDFs know pages, decks know
 *  slides, workbooks know sheets, and a Word document knows none of the
 *  three (its position is the ordinal alone). */
export type EmbeddedImageLocation = {
  page?: number;
  slide?: number;
  sheet?: string;
};

export type EmbeddedImage = {
  bytes: Buffer;
  /** Container extension, from sniffing the bytes — never trusted from the
   *  part name, which lies often enough to matter (a `.png` part holding
   *  JPEG bytes is common in decks built by conversion tools). */
  ext: string;
  /** 1-based position in reading order across the whole document. */
  ordinal: number;
  width?: number;
  height?: number;
  location?: EmbeddedImageLocation;
  /** Author-written alternative text (Word/PowerPoint "Alt Text" → the
   *  `descr` attribute). The best title source when it isn't boilerplate. */
  altText?: string;
  /** A caption paragraph immediately following the image ("Figure 4: …"). */
  caption?: string;
  /** Nearest preceding heading — the workhorse for step-by-step manuals,
   *  where it yields things like "Step 3 — Add a new APN". */
  heading?: string;
  /** sha256 of `bytes`, computed once here because both the intra-document
   *  dedupe and the caller's cross-document dedupe want it. */
  sha256: string;
  /** The FORMAT guarantees this is a real content raster, not decoration —
   *  e.g. a DWF sheet thumbnail: exactly one per published sheet, and the
   *  only raster the drawing has. The decoration heuristics (dimension and
   *  no-dimensions size floors) don't apply; renderability, the absolute
   *  byte floor and dedupe still do. Set it only where the format itself
   *  proves content-ness — never from within a generic media scan. */
  essential?: boolean;
  /** Which tier produced the bytes, for formats with more than one (DWF:
   *  a sidecar vector render vs the container's small preview). Persisted
   *  onto the image node so "which drawings are still on the low-res tier"
   *  is a query, and an upgrade pass has a safe predicate. */
  provenance?: 'sidecar_render' | 'embedded_thumbnail';
};

/** Minimum edge length, in pixels, for an image to be worth keeping. Bullets,
 *  icons, rule lines and logos all sit well under this; a screenshot or a
 *  diagram sits well over it. */
export const MIN_IMAGE_DIMENSION = 200;

/** Absolute floor on encoded size — drops empty and degenerate parts only.
 *
 *  Deliberately LOW, and please leave it that way: encoded size is a bad
 *  proxy for "is this a real picture". Flat art compresses extremely well,
 *  so a genuine 600×260 line diagram lands around 2 KB and a clean UI
 *  screenshot (large areas of flat colour) is not much heavier. An earlier
 *  8 KB floor here rejected both — i.e. it threw away precisely the diagrams
 *  and screenshots this feature exists to keep. Pixel dimensions do the real
 *  filtering; this only catches the 200-byte stub. */
export const MIN_IMAGE_BYTES = 1_024;

/** Fallback floor for images whose container we recognise but whose
 *  dimensions we couldn't read. With no pixel count to judge, size is the
 *  only signal left, so it has to be stricter than the absolute floor. */
export const MIN_IMAGE_BYTES_WITHOUT_DIMENSIONS = 16_384;

/** Ceiling on images kept per source document, applied AFTER gating so it
 *  bounds *real* images rather than being spent on icons. Mirrors
 *  MAX_AUTO_TABLE_TABLES (20) in intent: bound the fan-out, log the excess,
 *  never silently truncate. */
export const MAX_EMBEDDED_IMAGES_PER_DOC = 30;

/** Containers we drop on sight. EMF/WMF/EMZ/WMZ are Windows metafiles: no
 *  browser renders them, so storing one produces a file node that can never
 *  be shown — worse than not having it. Office often embeds an EMF *fallback*
 *  beside a modern raster of the same picture, so dropping these usually
 *  loses nothing. (Jason's call, 2026-07-30.) */
export const SKIPPED_IMAGE_EXTS = new Set(['emf', 'wmf', 'emz', 'wmz']);

/** Why an image was dropped — surfaced on the trace so "this manual produced
 *  no images" is always explainable rather than mysterious. */
export type GateRejection =
  'metafile' | 'unrenderable' | 'too_small' | 'too_few_bytes' | 'duplicate';

export type GateResult = { keep: true } | { keep: false; reason: GateRejection };

/**
 * Decide whether an extracted image is worth keeping, using only cheap
 * deterministic signals. Deliberately conservative about *containers*: if we
 * can't identify the bytes as something a browser will render, we drop them,
 * because the entire point of this feature is showing the picture to someone.
 *
 * `seenHashes` carries the sha256s already kept for this document, so the
 * logo repeated on all sixty slides collapses to a single node.
 */
export function passesGate(
  img: { bytes: Buffer; ext: string; sha256: string; essential?: boolean },
  seenHashes: Set<string>,
): GateResult {
  if (SKIPPED_IMAGE_EXTS.has(img.ext)) return { keep: false, reason: 'metafile' };
  if (img.bytes.length < MIN_IMAGE_BYTES) return { keep: false, reason: 'too_few_bytes' };
  if (seenHashes.has(img.sha256)) return { keep: false, reason: 'duplicate' };

  const probed = sniffImage(img.bytes);
  // Unknown container — EMF/WMF that slipped the extension check, TIFF, or
  // something we simply can't identify. If a browser won't render it, storing
  // it produces a node that can never be shown.
  //
  // SVG IS accepted. It's the one image type that can carry script, but every
  // surface that displays a stored file already defends against exactly that:
  // `safeDownloadHeaders` (@mantle/web-ui/lib/safe-download) serves SVG bytes
  // under a `sandbox`ed, `default-src 'none'` CSP so even direct navigation to
  // the raw URL renders it inert, and both display paths embed via `<img>`
  // (Pages through the asset route, chat through a `data:` artifact), where
  // SVG scripts never execute regardless. Rejecting it here would only lose
  // the crispest diagrams — vector is the BEST case for a technical figure.
  if (!probed) return { keep: false, reason: 'unrenderable' };

  // An `essential` image (see the EmbeddedImage field) is content by the
  // format's own guarantee — a DWF sheet thumbnail is 262×170 and would fail
  // the dimension floor below, yet it is the only raster the sheet has.
  if (img.essential) return { keep: true };

  // Dimensions are the real filter — icons, bullets and rule lines all fail
  // here while a diagram or screenshot passes comfortably.
  if (probed.width != null && probed.height != null) {
    return probed.width < MIN_IMAGE_DIMENSION || probed.height < MIN_IMAGE_DIMENSION
      ? { keep: false, reason: 'too_small' }
      : { keep: true };
  }
  // Recognised container, unreadable dimensions (an exotic WebP shape, a
  // truncated header, a fluid SVG with no viewBox). Judge on size alone
  // rather than dropping it. Rare in practice — almost every SVG carries a
  // viewBox, so vector diagrams are filtered on their real proportions.
  return img.bytes.length < MIN_IMAGE_BYTES_WITHOUT_DIMENSIONS
    ? { keep: false, reason: 'too_few_bytes' }
    : { keep: true };
}

/** sha256 + sniffed container + dimensions for a raw buffer. Centralised so
 *  every format extractor reports the same shape and none of them has to
 *  trust the part name it found the bytes under. */
export function describeImageBytes(bytes: Buffer, fallbackExt: string) {
  const probed = sniffImage(bytes);
  return {
    ext: probed?.ext ?? fallbackExt.toLowerCase(),
    width: probed?.width,
    height: probed?.height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export type ExtractEmbeddedImagesResult = {
  /** Kept images, in document order, already gated and capped. */
  images: EmbeddedImage[];
  /** How many candidates each rejection reason accounted for, plus how many
   *  were dropped by the per-document cap. Written to the trace so a doc that
   *  yields nothing says *why*. */
  rejected: Partial<Record<GateRejection | 'over_cap', number>>;
  /** Total candidates seen before gating. */
  candidates: number;
};

/**
 * Pull every embedded image out of a document, in reading order, gated and
 * capped. Never throws for a format we merely don't support — that's an empty
 * result, not an error — but DOES propagate a parser throwing on input it
 * claims to handle, so the caller can tell "no images" from "couldn't read
 * it" the same way `parseDocumentBytes` does.
 */
export async function extractEmbeddedImages(
  bytes: Buffer,
  ext: string,
  opts?: { maxImages?: number },
): Promise<ExtractEmbeddedImagesResult> {
  const cap = Math.max(0, opts?.maxImages ?? MAX_EMBEDDED_IMAGES_PER_DOC);
  const raw = await extractRaw(bytes, ext.toLowerCase(), { maxImages: cap });

  const seen = new Set<string>();
  const rejected: ExtractEmbeddedImagesResult['rejected'] = {};
  const kept: EmbeddedImage[] = [];

  for (const img of raw) {
    const verdict = passesGate(img, seen);
    if (!verdict.keep) {
      rejected[verdict.reason] = (rejected[verdict.reason] ?? 0) + 1;
      continue;
    }
    if (kept.length >= cap) {
      rejected.over_cap = (rejected.over_cap ?? 0) + 1;
      continue;
    }
    seen.add(img.sha256);
    // Renumber so ordinals are dense over what we KEPT. A user reading
    // "image 3 of 8" in a citation should be able to count to it.
    kept.push({ ...img, ordinal: kept.length + 1 });
  }

  return { images: kept, rejected, candidates: raw.length };
}

// ─── naming ───────────────────────────────────────────────────────────

/**
 * Alt-text and shape-name values that carry no information.
 *
 * Office populates the shape name for every picture whether the author cared
 * or not ("Picture 3", "Content Placeholder 2"), and conversion tools leave
 * the source filename behind ("image1.png"). Treating those as a title would
 * be worse than having none: the node would *look* named while telling the
 * reader nothing, and the better sources further down the cascade would never
 * get a chance.
 */
function isUninformative(value: string): boolean {
  const v = value.trim();
  if (v.length < 3) return true;
  if (/^image\d*\.\w+$/i.test(v)) return true; // leftover filename
  if (/^\d+$/.test(v)) return true;
  return /^(picture|image|graphic|graphik|shape|rectangle|oval|ellipse|line|arrow|content placeholder|placeholder|object|group|freeform|text ?box|screenshot|screen ?clip)\s*\d*$/i.test(
    v,
  );
}

/** " (p12)" / " (slide 3)" / " (Setup)" — the smallest thing that tells two
 *  otherwise identically-named images apart, and genuinely useful on its own
 *  ("show me the diagram on page 12"). */
function locationSuffix(location?: EmbeddedImageLocation): string {
  if (location?.page != null) return ` (p${location.page})`;
  if (location?.slide != null) return ` (slide ${location.slide})`;
  if (location?.sheet) return ` (${location.sheet})`;
  return '';
}

const MAX_TITLE_LENGTH = 180;

function clamp(s: string, max = MAX_TITLE_LENGTH): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Human-facing titles for a document's extracted images.
 *
 * Runs the naming cascade — author's alt text, then the caption beneath the
 * picture, then the heading it sits under, then a positional fallback — and
 * guarantees the results are distinct, because "Step 3 — Add a new APN"
 * repeated four times is no more useful than "image1.png" repeated four
 * times. Deterministic and free: nothing here calls a model. A vision-derived
 * title, when the caller pays for one anyway, is strictly better than the
 * positional fallback and should override it — but never at the cost of an
 * extra call just to name something.
 *
 * Titles are prefixed with the source document because a file node is read
 * far from its folder — in search results, in a chat citation, in a Page's
 * alt text — where "Step 3" alone has lost its subject.
 */
export function buildImageTitles(images: EmbeddedImage[], sourceTitle: string): string[] {
  const source = clamp(sourceTitle.replace(/\.[a-z0-9]{1,6}$/i, ''), 60);
  const used = new Map<string, number>();

  return images.map((img) => {
    const authored = [img.altText, img.caption, img.heading].find(
      (v): v is string => typeof v === 'string' && v.trim().length > 0 && !isUninformative(v),
    );
    const descriptor = authored ?? `image ${img.ordinal}`;
    const base = clamp(`${source} — ${descriptor}${locationSuffix(img.location)}`);

    // Same heading covering several pictures, or the same caption reused:
    // disambiguate positionally rather than shipping duplicates.
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : clamp(`${base} #${seen + 1}`);
  });
}

/**
 * The per-document slug that names BOTH the extracted-images folder and every
 * image filename inside it — the extractor's one source of identity for a
 * document's pictures.
 *
 * The extension is part of the slug, not stripped from it. A drawing ingested
 * as both `90-10-01.dwg` and `90-10-01.dxf` (cross-format twins are routine in
 * CAD hand-offs) used to slugify to the same folder AND the same image
 * filenames, so the second document's saves all collided with the first's and
 * every image was silently lost. `90-10-01-dwg` vs `90-10-01-dxf` can never
 * share a path.
 *
 * The extension is appended AFTER the stem is slugged (and capped), so a stem
 * long enough to hit `slugifyFolder`'s 64-char cap cannot truncate the
 * extension away and re-collide. Existing folders from older extractions keep
 * their names — the extractor's `sourceFileId` dedupe means an already
 * extracted document is never renamed, only new extractions use this scheme.
 */
export function buildSourceSlug(filename: string): string {
  const ext = extOf(filename);
  const stem = ext ? filename.slice(0, -(ext.length + 1)) : filename;
  const stemSlug = slugifyFolder(stem) ?? 'document';
  const extSlug = ext ? slugifyFolder(ext) : null;
  return extSlug ? `${stemSlug}-${extSlug}` : stemSlug;
}

/**
 * On-disk filename — mechanical, stable, and sortable, which is exactly what
 * the title is not.
 *
 * The leading zero-padded ordinal means a plain lexical listing of the folder
 * is reading order, so the sequence survives every surface that sorts by name
 * and never has to be reconstructed. Nothing derived from the *content* goes
 * in here: a caption reworded between two parses of the same document would
 * otherwise change the path and orphan the old bytes.
 */
export function buildImageFilename(img: EmbeddedImage, sourceSlug: string, ext = img.ext): string {
  const ordinal = String(img.ordinal).padStart(3, '0');
  const where =
    img.location?.page != null
      ? `-p${img.location.page}`
      : img.location?.slide != null
        ? `-slide${img.location.slide}`
        : img.location?.sheet
          ? `-${slugifyFolder(img.location.sheet) ?? 'sheet'}`
          : '';
  return `${ordinal}-${sourceSlug}${where}.${ext}`;
}

/** Format dispatch. Each branch returns candidates in document order with a
 *  provisional ordinal; gating and renumbering happen above. */
async function extractRaw(
  bytes: Buffer,
  ext: string,
  opts?: { maxImages?: number },
): Promise<EmbeddedImage[]> {
  if (ext === 'docx') return (await import('./docx')).extractDocxImages(bytes);
  if (ext === 'pdf') return (await import('./pdf')).extractPdfImages(bytes);
  if (ext === 'pptx' || ext === 'xlsx' || ext === 'xlsm') {
    return (await import('./ooxml-media')).extractOoxmlImages(bytes, ext);
  }
  if (ext === 'odt' || ext === 'ods' || ext === 'odp') {
    return (await import('./ooxml-media')).extractOdfImages(bytes);
  }
  // DWF plot sets: one raster per published sheet, marked essential (the
  // format guarantees content-ness; see extractDwfImages). The caller's cap
  // is forwarded so the sidecar never renders sheets the gate would discard.
  if (ext === 'dwf') {
    return (await import('./dwf')).extractDwfImages(bytes, { maxSheets: opts?.maxImages });
  }
  // DWG drawings: one essential model-space render from the sidecar; no
  // fallback tier inside the file (see extractDwgImages).
  if (ext === 'dwg') {
    return (await import('./dwg')).extractDwgImages(bytes);
  }
  // DXF drawings: same single render off the same sidecar exchange.
  if (ext === 'dxf') {
    return (await import('./dxf')).extractDxfImages(bytes);
  }
  // Tier 2 — the legacy binaries. `xlsb` is a zip but an undocumented binary
  // one, so it goes to Tika too rather than getting a bespoke reader.
  if (TIKA_EXTS.has(ext) || ext === 'xlsb') {
    return (await import('./tika')).unpackTikaImages(bytes, ext);
  }
  return [];
}
