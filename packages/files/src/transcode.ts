/**
 * Image transcoding for the vision pipeline.
 *
 * The vision providers (OpenAI, Anthropic, Google, …) can't read HEIC/HEIF —
 * the iPhone default capture format — so a photo in that format would either
 * be rejected by the API or skipped entirely. We transcode HEIC/HEIF → JPEG
 * before handing bytes to a vision adapter; everything else passes through
 * untouched.
 *
 * The decode itself is the parser service's (`heic-convert`, libheif as
 * WASM, in ./image-read.ts): this module only decides and asks.
 */

import { extOf } from './slug';

const HEIC_MIME_RE = /image\/(heic|heif)/i;

/** True when the bytes look like HEIC/HEIF, by MIME type or filename. */
export function isHeic(mimeType?: string | null, filename?: string | null): boolean {
  if (mimeType && HEIC_MIME_RE.test(mimeType)) return true;
  if (filename) {
    const ext = extOf(filename);
    if (ext === 'heic' || ext === 'heif') return true;
  }
  return false;
}

/**
 * If the bytes are HEIC/HEIF, transcode to JPEG; otherwise return them
 * unchanged.
 *
 * The decode runs in the parser service (./image-read.ts), never in this
 * process: only HEIC bytes are sent, everything else returns at once. A
 * retryable parser failure (busy, restarting, the first timeout or crash)
 * is THROWN: sending the HEIC on to a vision model would pay for a call
 * that cannot read it. The extractor's job fails and is retried; a chat
 * turn says to try again. A verdict on the image (corrupt, unsupported,
 * the second failure) returns the original bytes, and the vision call's
 * own failure is handled upstream.
 */
export async function transcodeImageForVision(
  bytes: Buffer,
  mimeType: string,
  filename?: string | null,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (!isHeic(mimeType, filename)) return { bytes, mimeType };
  const { isParserError, parserImageForVision } = await import('./parser-client');
  try {
    return await parserImageForVision(bytes, mimeType.match(/heif/i) ? 'image/heif' : 'image/heic');
  } catch (err) {
    if (isParserError(err) && err.retryable) throw err;
    console.warn(
      '[files] HEIC to JPEG transcode failed; passing original bytes through:',
      err instanceof Error ? err.message : err,
    );
    return { bytes, mimeType };
  }
}
