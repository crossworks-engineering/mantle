/**
 * The canvas data store's contract (DWG phase 7a): what a Present canvas may
 * keep through `mantle.data`, shared by the frame's helper (share-ui
 * canvas-frame-html), the host that forwards its calls (share-ui
 * canvas-sandbox), the brain's route and the content layer. Pure: no server
 * or browser dependency.
 *
 * A canvas runs sandboxed, with no network, no cookies and no storage. It
 * asks its PARENT page over postMessage; the parent forwards each call to
 * the brain as the signed-in user, and binds the canvas: a message names
 * neither a canvas nor a login. So everything a message carries is hostile
 * until these checks pass, on the host and again on the brain.
 *
 * Two buckets, on the canvas's own item rights:
 *  - `shared`: every reader of the canvas reads it; only a user with Write on
 *    the canvas writes it (the right a source save asks).
 *  - `mine`: every reader writes their own entries only. A plain reader reads
 *    their own; a user with Write on the canvas (its owner too) reads
 *    everyone's.
 */

export const CANVAS_DATA_BUCKETS = ['shared', 'mine'] as const;
export type CanvasDataBucket = (typeof CANVAS_DATA_BUCKETS)[number];

/** One value, as its JSON text, in UTF-8 bytes. */
export const CANVAS_DATA_VALUE_MAX_BYTES = 64 * 1024;
/** All values of one canvas, both buckets, every login. */
export const CANVAS_DATA_CANVAS_MAX_BYTES = 1024 * 1024;
/** Entries of one canvas, both buckets, every login. */
export const CANVAS_DATA_CANVAS_MAX_KEYS = 1000;
/** One login's `mine` entries on one canvas: no single reader fills the
 *  canvas's budget for everyone else. */
export const CANVAS_DATA_MINE_MAX_BYTES = 256 * 1024;
export const CANVAS_DATA_MINE_MAX_KEYS = 200;

/** A key: 1 to 128 characters, a letter or digit first, then letters,
 *  digits and `_ - . : /`. Plain enough to show, log and put in a URL. */
export const CANVAS_DATA_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

/** The operations a canvas may ask for. */
export const CANVAS_DATA_OPS = ['get', 'set', 'delete', 'list', 'info'] as const;
export type CanvasDataOp = (typeof CANVAS_DATA_OPS)[number];

/** One stored entry as the brain answers it. `by` is the login that owns a
 *  `mine` entry (or last wrote a `shared` one); a name only where the reader
 *  may see who it is. */
export type CanvasDataEntry = {
  key: string;
  value: unknown;
  updatedAt: string;
  by?: { id: string; name: string | null };
};

/** What the store says about the reader of this canvas. */
export type CanvasDataInfo = {
  /** The reader may write the `shared` bucket (Write on the canvas). */
  canWriteShared: boolean;
  /** The reader may list everyone's `mine` entries (Write on the canvas). */
  readsEveryone: boolean;
  /** The reader's own login id: their `mine` entries carry it in `by`. */
  me: string | null;
  /** The canvas is a read-only copy: nothing is written. */
  readOnly: boolean;
};

export function isCanvasDataBucket(v: unknown): v is CanvasDataBucket {
  return typeof v === 'string' && (CANVAS_DATA_BUCKETS as readonly string[]).includes(v);
}

export function isCanvasDataKey(v: unknown): v is string {
  return typeof v === 'string' && CANVAS_DATA_KEY_RE.test(v);
}

export function isCanvasDataOp(v: unknown): v is CanvasDataOp {
  return typeof v === 'string' && (CANVAS_DATA_OPS as readonly string[]).includes(v);
}

/** UTF-8 byte length of a string, without a Buffer or a TextEncoder (both
 *  sides run it). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/**
 * A value's JSON text, checked: JSON only (what JSON.parse gives back), at
 * most CANVAS_DATA_VALUE_MAX_BYTES. `json` is the text a caller sent; the
 * answer is the parsed value and the canonical text the store keeps (its
 * size is what the caps count).
 */
export function readCanvasDataJson(
  json: unknown,
): { ok: true; value: unknown; text: string; bytes: number } | { ok: false; error: string } {
  if (typeof json !== 'string') return { ok: false, error: 'value must be JSON' };
  // A cheap first bound: a string is never fewer bytes than characters.
  if (json.length > CANVAS_DATA_VALUE_MAX_BYTES) return { ok: false, error: tooBig() };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: 'value must be JSON' };
  }
  return canvasDataValue(value);
}

/** A parsed value, checked as readCanvasDataJson checks its text. */
export function canvasDataValue(
  value: unknown,
): { ok: true; value: unknown; text: string; bytes: number } | { ok: false; error: string } {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return { ok: false, error: 'value must be JSON' };
  }
  if (text === undefined) return { ok: false, error: 'value must be JSON' };
  const bytes = utf8Bytes(text);
  if (bytes > CANVAS_DATA_VALUE_MAX_BYTES) return { ok: false, error: tooBig() };
  return { ok: true, value: JSON.parse(text) as unknown, text, bytes };
}

function tooBig(): string {
  return `value is over ${CANVAS_DATA_VALUE_MAX_BYTES / 1024} KB`;
}

/** The refusal when a write would pass a cap, the same words everywhere. */
export const CANVAS_DATA_FULL_ERROR =
  `the canvas's data is full: ${CANVAS_DATA_CANVAS_MAX_BYTES / 1024 / 1024} MB and ` +
  `${CANVAS_DATA_CANVAS_MAX_KEYS} entries per canvas, ` +
  `${CANVAS_DATA_MINE_MAX_BYTES / 1024} KB and ${CANVAS_DATA_MINE_MAX_KEYS} entries of your own`;
