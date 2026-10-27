/**
 * Image decoding: the parser service's image jobs (server/parser, routes
 * POST /image/thumbnail and POST /image/vision). Decoding an image allocates
 * width x height x 4 bytes whatever the file's size, so a small file with a
 * huge header is a bomb; it is decoded here, in the parser container, never
 * in the brain. The brain asks through the parser client
 * (./thumbnail.ts, ./transcode.ts).
 *
 * `heic-convert` is libheif compiled to WASM (with the HEVC decoder), so it
 * decodes real iPhone HEIC with no native or system dependency.
 * `@napi-rs/canvas` decodes and encodes the rest.
 */
import { DocumentTooLargeError } from './read-limit';
import { sniffImage } from './image-probe';

/** Pixels an image may have to be decoded: 100 MP is a 10,000 x 10,000
 *  photo, far past any camera's, and 400 MB as RGBA. Read from the header
 *  before decoding, so a lying header is refused cheaply; the container's
 *  memory limit stops a decoder this does not. */
export const MAX_DECODE_PIXELS = 100_000_000;

function assertDecodable(bytes: Buffer): void {
  const probed = sniffImage(bytes);
  if (probed?.width && probed.height && probed.width * probed.height > MAX_DECODE_PIXELS) {
    throw new DocumentTooLargeError(
      `the image is ${probed.width} x ${probed.height} pixels, past the ${MAX_DECODE_PIXELS.toLocaleString('en-US')}-pixel limit`,
    );
  }
}

/** HEIC/HEIF → JPEG. Throws when the bytes cannot be decoded. */
export async function heicToJpeg(bytes: Buffer): Promise<Buffer> {
  const convert = (await import('heic-convert')).default;
  return Buffer.from(await convert({ buffer: bytes, format: 'JPEG', quality: 0.9 }));
}

/** A JPEG of at most `maxDim` on the long edge (never upscaled), composited
 *  on white. HEIC/HEIF are converted first. Throws when the image cannot be
 *  decoded. */
export async function thumbnailJpeg(bytes: Buffer, heic: boolean, maxDim: number): Promise<Buffer> {
  const source = heic ? await heicToJpeg(bytes) : bytes;
  assertDecodable(source);
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(source);
  const w = img.width;
  const h = img.height;
  if (!w || !h) throw new Error('the image has no size');
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = createCanvas(tw, th);
  const ctx = canvas.getContext('2d');
  // JPEG has no alpha: composite transparent PNGs onto white rather than
  // letting the encoder pick black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, tw, th);
  ctx.drawImage(img, 0, 0, tw, th);
  return canvas.toBuffer('image/jpeg', 82);
}
