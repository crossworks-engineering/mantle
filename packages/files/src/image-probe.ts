/**
 * Header-only image sniffing — format + pixel dimensions without decoding.
 *
 * The embedded-image extractor has to decide "is this a real diagram or a
 * 16×16 bullet icon?" for every image it pulls out of a document, and it has
 * to decide it **before** the vision worker runs (that's the whole point of
 * the cost gate — see `embedded-images.ts`). Decoding hundreds of images just
 * to read two integers would defeat that, so we parse the handful of bytes at
 * the front of each container instead. Nothing here allocates beyond the
 * input buffer and nothing here can be slow.
 *
 * Covers the formats Office and PDF actually embed: PNG, JPEG, GIF, WebP, BMP
 * and SVG. Anything else returns `null` — the caller treats an unknown
 * container as "can't judge it", which the gate resolves conservatively (see
 * `passesGate`). We deliberately do NOT cover EMF/WMF: those are Windows
 * metafiles, browsers can't render them, and they're dropped upstream.
 *
 * SVG is the one non-binary entry, and the one whose "dimensions" are a
 * convention rather than a header field — see `probeSvg`.
 */

export type ProbedImage = {
  /** Canonical extension for the container we recognised. */
  ext: 'png' | 'jpg' | 'gif' | 'webp' | 'bmp' | 'svg';
  /** Pixel width, or undefined when the container is recognised but the
   *  dimensions sit behind a variant we don't parse (rare WebP shapes, an
   *  SVG with neither absolute dimensions nor a viewBox). */
  width?: number;
  height?: number;
};

const startsWith = (b: Buffer, sig: number[], at = 0): boolean => {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
};

/** PNG: 8-byte signature, then an IHDR chunk whose width/height are the two
 *  big-endian uint32s at offsets 16 and 20. IHDR is required by spec to be
 *  the first chunk, so the fixed offsets are safe. */
function probePng(b: Buffer): ProbedImage | null {
  if (!startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  if (b.length < 24) return { ext: 'png' };
  return { ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** JPEG: walk the marker segments until a Start-Of-Frame, which carries
 *  height then width as big-endian uint16s at +5 and +7. Skips the
 *  standalone markers (RSTn / SOI / EOI / TEM) that have no length field. */
function probeJpeg(b: Buffer): ProbedImage | null {
  if (!startsWith(b, [0xff, 0xd8])) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++; // resync on padding / corrupt run rather than bailing out
      continue;
    }
    const marker = b[i + 1]!;
    // Standalone markers carry no payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    // SOF0-3, SOF5-7, SOF9-11, SOF13-15 all share the same frame header
    // layout. 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC) are NOT frame headers.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { ext: 'jpg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (len < 2) return { ext: 'jpg' }; // malformed length — stop walking
    i += 2 + len;
  }
  return { ext: 'jpg' };
}

/** GIF: 'GIF87a' / 'GIF89a', then logical screen width/height as
 *  little-endian uint16s at 6 and 8. */
function probeGif(b: Buffer): ProbedImage | null {
  if (!startsWith(b, [0x47, 0x49, 0x46, 0x38])) return null;
  if (b.length < 10) return { ext: 'gif' };
  return { ext: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

/** WebP: a RIFF container whose payload is one of three chunk types, each
 *  storing dimensions differently. VP8X (extended) is checked first because
 *  an animated/alpha file uses it as the canvas authority. */
function probeWebp(b: Buffer): ProbedImage | null {
  if (!startsWith(b, [0x52, 0x49, 0x46, 0x46])) return null; // 'RIFF'
  if (!startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return null; // 'WEBP'
  const fourcc = b.subarray(12, 16).toString('latin1');
  if (fourcc === 'VP8X' && b.length >= 30) {
    // Canvas size is stored minus one, as two 24-bit little-endian ints.
    const w = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1;
    const h = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1;
    return { ext: 'webp', width: w, height: h };
  }
  if (fourcc === 'VP8 ' && b.length >= 30) {
    // Lossy: 14-bit dimensions follow the 3-byte start code at offset 23.
    return {
      ext: 'webp',
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    };
  }
  if (fourcc === 'VP8L' && b.length >= 25) {
    // Lossless: 14-bit width then 14-bit height, packed across 4 bytes
    // after the 0x2f signature byte, each stored minus one.
    const bits = b.readUInt32LE(21);
    return {
      ext: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return { ext: 'webp' };
}

/** BMP: 'BM', then width/height as signed little-endian int32s at 18 and 22.
 *  Height is negative for top-down bitmaps, so take the magnitude. */
function probeBmp(b: Buffer): ProbedImage | null {
  if (!startsWith(b, [0x42, 0x4d])) return null;
  if (b.length < 26) return { ext: 'bmp' };
  return { ext: 'bmp', width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
}

/** Leading noise permitted before an SVG's root element: a BOM (escaped, not
 *  literal — an invisible U+FEFF in source is a lint error and a debugging
 *  trap), whitespace, the XML declaration, a DOCTYPE, and comments. */
const SVG_PROLOGUE = /^(?:\uFEFF|\s|<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->)*/;

/** One length attribute, in user units. Percentages and physical units
 *  (`mm`, `pt`) return undefined so the viewBox is consulted instead. */
function svgLength(tag: string, name: string): number | undefined {
  const m =
    new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag) ??
    new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag);
  if (!m) return undefined;
  const n = /^\s*([0-9]*\.?[0-9]+)\s*(?:px)?\s*$/i.exec(m[1]!);
  return n ? Math.round(parseFloat(n[1]!)) : undefined;
}

/**
 * SVG: a text format, so there is no magic number — we look for the root
 * element after any prologue. Requiring `<svg>` to be the FIRST element
 * (rather than merely present) keeps an HTML page with an inline icon from
 * being mistaken for an image.
 *
 * Dimensions come from `width`/`height` when they're absolute, else from the
 * `viewBox`, which is what most authoring tools emit. Both absent — a
 * fluid-sized SVG — leaves them undefined, and the caller falls back to size.
 */
function probeSvg(b: Buffer): ProbedImage | null {
  // The root element lives at the front; never stringify a whole document.
  const head = b.subarray(0, 4096).toString('utf8');
  const body = head.slice(SVG_PROLOGUE.exec(head)?.[0].length ?? 0);
  if (!/^<svg[\s>]/i.test(body)) return null;
  const tag = /<svg\b[^>]*>/i.exec(body)?.[0] ?? '';

  let width = svgLength(tag, 'width');
  let height = svgLength(tag, 'height');
  if (width == null || height == null) {
    const vb =
      /\bviewBox\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bviewBox\s*=\s*'([^']*)'/i.exec(tag)?.[1];
    const parts = vb
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts?.length === 4 && parts.every((n) => Number.isFinite(n))) {
      width ??= Math.round(parts[2]!);
      height ??= Math.round(parts[3]!);
    }
  }
  return { ext: 'svg', ...(width != null ? { width } : {}), ...(height != null ? { height } : {}) };
}

/**
 * Identify an image container and read its dimensions from the header.
 * Returns `null` for anything we don't recognise — notably EMF/WMF and TIFF —
 * so the caller can decide what "unknown" should mean rather than having a
 * guess baked in here.
 */
export function sniffImage(bytes: Buffer): ProbedImage | null {
  if (bytes.length < 4) return null;
  return (
    probePng(bytes) ??
    probeJpeg(bytes) ??
    probeGif(bytes) ??
    probeWebp(bytes) ??
    probeBmp(bytes) ??
    probeSvg(bytes) ??
    null
  );
}
