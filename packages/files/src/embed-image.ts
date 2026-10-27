/**
 * A picture made small enough to embed in a document as a `data:` URL: a
 * JPEG no longer than `maxDim` on its long edge and no larger than
 * `maxBytes`, stepping the size and quality down until it fits. Used to put
 * the image check's crops into a Present canvas, which loads nothing from
 * the network (the frame's CSP allows `img-src data:` only).
 *
 * Engine: `@napi-rs/canvas`, as thumbnail.ts. Only PNG, JPEG and WebP are
 * decoded; anything else, a decode failure or a source past the caps is
 * null (the caller says the picture was not embedded). The pixel cap is
 * read from the picture's own header first (image-probe.ts sniffImage),
 * before anything is decoded: a small file that declares a huge picture (a
 * decompression bomb) is refused without allocating its pixels, as is one
 * whose header the probe cannot read.
 */
import { sniffImage } from './image-probe';

/** The containers the header probe must find: the decoder reads the bytes,
 *  not the stated type, so the bytes must be one of these. */
const HEADER_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'webp']);

/** Whether a picture's own header says it is a PNG, JPEG or WebP of at most
 *  `maxPixels` (both edges read, neither zero). */
export function headerWithinPixels(bytes: Buffer, maxPixels: number): boolean {
  const head = sniffImage(bytes);
  if (!head || !HEADER_EXTS.has(head.ext)) return false;
  const { width, height } = head;
  if (!width || !height) return false;
  return width * height <= maxPixels;
}

const EMBEDDABLE = /^image\/(png|jpe?g|webp)$/i;
/** Whether a file of this type is one `embeddableJpeg` decodes: a caller
 *  asks before it reads the bytes. */
export function isEmbeddableImage(mimeType: string): boolean {
  return EMBEDDABLE.test(mimeType.split(';')[0]!.trim());
}
/** A source past this many pixels is not decoded (a crop is at most about
 *  2000 x 2000): read from the header first, checked again after decode. */
const EMBED_SOURCE_MAX_PIXELS = 25_000_000;

/** The size steps tried, largest first: [long edge, JPEG quality]. */
const STEPS: readonly [number, number][] = [
  [960, 74],
  [800, 66],
  [640, 60],
  [480, 55],
];

export async function embeddableJpeg(
  bytes: Buffer,
  mimeType: string,
  /** `maxSourceBytes`: a larger source is not decoded (the caller's own
   *  limit, e.g. CROP_LIMITS.sourceBytes). */
  opts: { maxDim?: number; maxBytes: number; maxSourceBytes: number },
): Promise<Buffer | null> {
  if (!isEmbeddableImage(mimeType)) return null;
  if (!bytes.byteLength || bytes.byteLength > opts.maxSourceBytes) return null;
  // The size the header declares, before any pixel is decoded.
  if (!headerWithinPixels(bytes, EMBED_SOURCE_MAX_PIXELS)) return null;
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(bytes);
    const w = img.width;
    const h = img.height;
    if (!w || !h || w * h > EMBED_SOURCE_MAX_PIXELS) return null;
    for (const [dim, quality] of STEPS) {
      if (opts.maxDim && dim > opts.maxDim) continue;
      const scale = Math.min(1, dim / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      const canvas = createCanvas(tw, th);
      const ctx = canvas.getContext('2d');
      // JPEG has no alpha: a transparent crop goes onto white.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(img, 0, 0, tw, th);
      const out = canvas.toBuffer('image/jpeg', quality);
      if (out.byteLength <= opts.maxBytes) return out;
    }
    return null;
  } catch {
    return null;
  }
}
