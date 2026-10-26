/**
 * A picture made small enough to embed in a document as a `data:` URL: a
 * JPEG no longer than `maxDim` on its long edge and no larger than
 * `maxBytes`, stepping the size and quality down until it fits. Used to put
 * the image check's crops into a Present canvas, which loads nothing from
 * the network (the frame's CSP allows `img-src data:` only).
 *
 * Engine: `@napi-rs/canvas`, as thumbnail.ts. Only PNG, JPEG and WebP are
 * decoded; anything else, a decode failure or a source past the caps is
 * null (the caller says the picture was not embedded).
 */
const EMBEDDABLE = /^image\/(png|jpe?g|webp)$/i;
/** A source this large is not decoded (a crop is far smaller). */
export const EMBED_SOURCE_MAX_BYTES = 12 * 1024 * 1024;
/** A source past this many pixels is not decoded (a crop is at most about
 *  2000 x 2000). */
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
  opts: { maxDim?: number; maxBytes: number },
): Promise<Buffer | null> {
  if (!EMBEDDABLE.test(mimeType.split(';')[0]!.trim())) return null;
  if (!bytes.byteLength || bytes.byteLength > EMBED_SOURCE_MAX_BYTES) return null;
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
