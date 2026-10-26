/**
 * The image check's crops, embedded in a `pid` canvas when it is saved
 * (present_create, present_update), so a click on a checked guess can show
 * what the model judged.
 *
 * Why embedded: the canvas frame loads nothing (its CSP: `connect-src
 * 'none'`, `img-src data: blob:`; it may load only /canvas-runtime/,
 * /fonts/ and /Inter/), so a crop cannot be fetched from the asset path. It
 * travels inside the canvas, in its own assets block next to the data
 * block (`readCanvasAssets`, not the data: the agent never reads or writes
 * the pictures, only each check's `crops`, file ids).
 *
 * Safe by construction:
 *  - Rights: each crop is read by its file id in the caller's own scope
 *    (`readFileById`, a `nodes` read under row level security, as every
 *    tool's read): a file the caller cannot read is not embedded, so a
 *    canvas never carries a picture its author could not open.
 *  - Only PNG, JPEG and WebP files are decoded, then re-encoded as a small
 *    JPEG (`embeddableJpeg`): no SVG, no markup, nothing executable; the
 *    frame's runtime shows only a base64 image data URL.
 *  - Size: each crop at most CROP_MAX_BYTES, all of them at most
 *    CROPS_MAX_BYTES and CROPS_MAX, well under the 1 MB canvas cap. What
 *    does not fit is said, and the guess shows its words without a picture.
 *
 * A shared canvas (a public link) carries its crops like any other content
 * of the canvas.
 */
import { embeddableJpeg, readFileById } from '@mantle/files';
import { isUuid } from '@mantle/std';
import type { CanvasAssets } from '@mantle/diagram-templates';

/** One crop, as JPEG bytes. */
export const CROP_MAX_BYTES = 90_000;
/** All crops of one canvas, as JPEG bytes (base64 adds a third). */
export const CROPS_MAX_BYTES = 480_000;
/** Crops embedded per canvas. */
export const CROPS_MAX = 24;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every crop file id the checks in pid data name (one drawing or a set:
 *  a connector's and a valve's `check.crops`, a line's `checks[].crops`),
 *  in order, each once. Only uuids are file ids here. */
export function cropIdsOf(data: unknown): string[] {
  const out: string[] = [];
  const take = (check: unknown) => {
    if (!isObj(check) || !Array.isArray(check.crops)) return;
    for (const id of check.crops)
      if (typeof id === 'string' && isUuid(id) && !out.includes(id.toLowerCase()))
        out.push(id.toLowerCase());
  };
  const drawing = (d: unknown) => {
    if (!isObj(d)) return;
    for (const o of Array.isArray(d.offpage) ? d.offpage : []) if (isObj(o)) take(o.check);
    for (const l of Array.isArray(d.lines) ? d.lines : []) {
      if (!isObj(l)) continue;
      for (const c of Array.isArray(l.checks) ? l.checks : []) take(c);
      for (const it of Array.isArray(l.inline) ? l.inline : []) if (isObj(it)) take(it.check);
    }
  };
  if (isObj(data) && Array.isArray(data.pages)) {
    for (const p of data.pages) if (isObj(p)) drawing(p.data);
  } else drawing(data);
  return out;
}

export type CropRead = (fileId: string) => Promise<{ bytes: Buffer; mimeType: string } | null>;

/** The caller's own read of a file's bytes (scoped, as every tool read). */
export function scopedCropRead(ownerId: string): CropRead {
  return async (fileId) => {
    const f = await readFileById({ ownerId, fileId }).catch(() => null);
    if (!f) return null;
    return { bytes: f.bytes, mimeType: f.row.mimeType ?? 'application/octet-stream' };
  };
}

/**
 * The crops to embed for this data, and a note on any left out. `null`
 * assets: the data names no crop (the canvas gets no assets block).
 */
export async function embedCheckCrops(
  data: unknown,
  read: CropRead,
): Promise<{ assets: CanvasAssets | null; notes: string[] }> {
  const ids = cropIdsOf(data);
  if (!ids.length) return { assets: null, notes: [] };
  const crops: Record<string, string> = {};
  let total = 0;
  const missing: string[] = [];
  const over: string[] = [];
  for (const id of ids) {
    if (Object.keys(crops).length >= CROPS_MAX) {
      over.push(id);
      continue;
    }
    const file = await read(id);
    if (!file) {
      missing.push(id);
      continue;
    }
    const jpeg = await embeddableJpeg(file.bytes, file.mimeType, { maxBytes: CROP_MAX_BYTES });
    if (!jpeg) {
      missing.push(id);
      continue;
    }
    if (total + jpeg.byteLength > CROPS_MAX_BYTES) {
      over.push(id);
      continue;
    }
    total += jpeg.byteLength;
    crops[id] = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  }
  const notes: string[] = [];
  if (missing.length)
    notes.push(
      `${missing.length} crop${missing.length === 1 ? '' : 's'} named by a check could not be read as a picture you may open (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', ...' : ''}): those guesses show their question and answer without the picture.`,
    );
  if (over.length)
    notes.push(
      `${over.length} crop${over.length === 1 ? '' : 's'} did not fit the canvas's picture budget (${CROPS_MAX} crops, about ${Math.round(CROPS_MAX_BYTES / 1000)} KB): those guesses show their words without the picture; the crops stay in the drawing table's Checks tab.`,
    );
  return { assets: Object.keys(crops).length ? { crops } : null, notes };
}
