/**
 * Image transcoding for the vision pipeline.
 *
 * The vision providers (OpenAI, Anthropic, Google, …) can't read HEIC/HEIF —
 * the iPhone default capture format — so a photo in that format would either
 * be rejected by the API or skipped entirely. We transcode HEIC/HEIF → JPEG
 * before handing bytes to a vision adapter; everything else passes through
 * untouched.
 *
 * `heic-convert` is libheif compiled to WASM (with the HEVC decoder), so it
 * decodes real iPhone HEIC without any native/system dependency — important
 * for the self-hosted VPS deploy where "works on my Mac, breaks in prod" is
 * the failure we're avoiding.
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
 * unchanged. Best-effort: on any decode failure returns the ORIGINAL bytes so
 * the caller degrades exactly as it would have (the vision call may then fail,
 * which is handled upstream).
 *
 * `heic-convert` (libheif WASM) is lazy-imported so the decoder only loads
 * when a HEIC actually arrives — no startup cost for the common JPEG/PNG case.
 */
export async function transcodeImageForVision(
  bytes: Buffer,
  mimeType: string,
  filename?: string | null,
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (!isHeic(mimeType, filename)) return { bytes, mimeType };
  try {
    const convert = (await import('heic-convert')).default;
    const out = await convert({ buffer: bytes, format: 'JPEG', quality: 0.9 });
    return { bytes: Buffer.from(out), mimeType: 'image/jpeg' };
  } catch (err) {
    console.warn(
      '[files] HEIC→JPEG transcode failed; passing original bytes through:',
      err instanceof Error ? err.message : err,
    );
    return { bytes, mimeType };
  }
}
