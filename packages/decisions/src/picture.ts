/**
 * Pictures in a decision's state (docs/decisions.md, "Pictures"). A model
 * whose profile says `pictures` (Jev) reads an `image_url` part in the state:
 * a PNG or JPEG as a data URL, within DECISION_PICTURE_LIMITS. This module
 * makes such a part from a picture's bytes (shrunk in the parser when it is
 * larger than the limits, never decoded in this process), and sizes a
 * request that holds parts: a picture counts at its token cost, not at the
 * length of its base64 (a page picture is about 1.4 million characters of
 * base64 and about 5,000 tokens).
 */
import { DECISION_PICTURE_LIMITS } from '@mantle/client-types/decision-models';
import { sniffImage } from '@mantle/files/image-probe';

/** A picture in a decision's state, as OpenRouter's decisions endpoint takes
 *  it. */
export type DecisionPicturePart = { type: 'image_url'; image_url: { url: string } };

/** Pixels a token, for the estimate: a 1,108 x 1,568 page picture with
 *  about 3,000 characters of text was 5,429 to 6,820 input tokens on Jev
 *  1.14 (the scan bench, 2026-11-19): the picture about 5,000, 1 token for
 *  about 350 pixels. 300 counts high, as the text estimate does. */
export const PICTURE_PIXELS_PER_TOKEN = 300;

/** The token cost of a picture of `width` x `height` pixels (an estimate
 *  that counts high). */
export function pictureTokens(width: number, height: number): number {
  return Math.ceil((Math.max(1, width) * Math.max(1, height)) / PICTURE_PIXELS_PER_TOKEN);
}

/** What stands in a picture's place when a request's text is measured. */
const STANDIN = '[picture]';

/** Why a picture may not be sent, or null: a PNG or JPEG within the limits. */
export function pictureRefusal(probed: {
  ext?: string;
  width?: number;
  height?: number;
  bytes: number;
}): string | null {
  const L = DECISION_PICTURE_LIMITS;
  if (probed.ext !== 'png' && probed.ext !== 'jpg') return 'a picture is not a PNG or JPEG';
  const { width: w, height: h } = probed;
  if (!w || !h) return 'a picture has no size in its header';
  if (probed.bytes > L.maxBytes) return 'a picture is over 16 MiB';
  if (Math.min(w, h) < L.minSide || w * h < L.minPixels) {
    return `a picture of ${w} x ${h} is under ${L.minSide} pixels a side`;
  }
  if (Math.max(w, h) > L.maxSide || w * h > L.maxPixels) {
    return `a picture of ${w} x ${h} is over ${L.maxSide} pixels a side`;
  }
  return null;
}

const DATA_URL = /^data:image\/(png|jpeg);base64,/;

function isPicturePart(v: unknown): v is DecisionPicturePart {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = v as { type?: unknown; image_url?: unknown };
  return (
    p.type === 'image_url' &&
    !!p.image_url &&
    typeof (p.image_url as { url?: unknown }).url === 'string'
  );
}

/** One picture of a state, measured from its own header (no decode). */
export type StatePicture = {
  width?: number;
  height?: number;
  ext?: string;
  bytes: number;
  refusal: string | null;
};

/** The header of a picture part: its size and type, and why it may not be
 *  sent. A URL that is no PNG or JPEG data URL is refused (the endpoint
 *  takes only those). */
export function measurePicture(part: DecisionPicturePart): StatePicture {
  const url = part.image_url.url;
  const m = DATA_URL.exec(url);
  if (!m) return { bytes: 0, refusal: 'a picture is not a PNG or JPEG data URL' };
  const buf = Buffer.from(url.slice(m[0].length), 'base64');
  const probed = sniffImage(buf);
  const out = {
    ...(probed?.width ? { width: probed.width } : {}),
    ...(probed?.height ? { height: probed.height } : {}),
    ...(probed?.ext ? { ext: probed.ext } : {}),
    bytes: buf.length,
  };
  return { ...out, refusal: pictureRefusal(out) };
}

/**
 * A state's pictures, and the state with each picture as a short stand-in
 * (for measuring its text). Walks arrays and plain objects; a state with no
 * picture comes back as it is.
 */
export function statePictures(state: unknown): { pictures: StatePicture[]; text: unknown } {
  const pictures: StatePicture[] = [];
  const walk = (v: unknown): unknown => {
    if (isPicturePart(v)) {
      pictures.push(measurePicture(v));
      return STANDIN;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  const text = walk(state);
  return { pictures, text: pictures.length > 0 ? text : state };
}

/** The parser's shrink: a JPEG of at most `maxDim` on its long edge, or null
 *  when it cannot decode the picture. Swapped in a test. */
export type ShrinkFn = (bytes: Buffer, mimeType: string, maxDim: number) => Promise<Buffer | null>;

const parserShrink: ShrinkFn = async (bytes, mimeType, maxDim) => {
  const { parserThumbnail } = await import('@mantle/files');
  return parserThumbnail(bytes, mimeType, maxDim);
};

/**
 * A picture as a part of a decision's state: as it is when it is a PNG or
 * JPEG within the limits; else shrunk by the parser to a JPEG of at most
 * 1,568 pixels on its long edge (a PNG or JPEG too large, or another type
 * the parser decodes). Null, with nothing sent anywhere else, when it is
 * under the smallest size or cannot be read. The decode is the parser's,
 * never this process's.
 */
export async function decisionPictureOf(
  bytes: Buffer,
  mimeType: string,
  shrink: ShrinkFn = parserShrink,
): Promise<{ part: DecisionPicturePart; width: number; height: number; tokens: number } | null> {
  const asPart = (b: Buffer, ext: 'png' | 'jpg') => ({
    type: 'image_url' as const,
    image_url: {
      url: `data:image/${ext === 'png' ? 'png' : 'jpeg'};base64,${b.toString('base64')}`,
    },
  });
  const done = (b: Buffer) => {
    const probed = sniffImage(b);
    const m = {
      ...(probed?.width ? { width: probed.width } : {}),
      ...(probed?.height ? { height: probed.height } : {}),
      ...(probed?.ext ? { ext: probed.ext } : {}),
      bytes: b.length,
    };
    if (pictureRefusal(m) || !m.width || !m.height) return null;
    return {
      part: asPart(b, m.ext as 'png' | 'jpg'),
      width: m.width,
      height: m.height,
      tokens: pictureTokens(m.width, m.height),
    };
  };
  if (bytes.length === 0) return null;
  const first = done(bytes);
  if (first) return first;
  // Too small a picture is not made larger: the model would read nothing
  // more, and the endpoint refuses it.
  const probed = sniffImage(bytes);
  if (
    probed?.width &&
    probed.height &&
    (Math.min(probed.width, probed.height) < DECISION_PICTURE_LIMITS.minSide ||
      probed.width * probed.height < DECISION_PICTURE_LIMITS.minPixels)
  ) {
    return null;
  }
  const shrunk = await shrink(bytes, mimeType, DECISION_PICTURE_LIMITS.maxSide);
  return shrunk && shrunk.length > 0 ? done(shrunk) : null;
}
