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
 *    (`fileById`, then `openFileById`: `nodes` reads under row level
 *    security, as every tool's read): a file the caller cannot read is not
 *    embedded, so a canvas never carries a picture its author could not
 *    open. Here, in the tools layer, because it needs the caller's rights.
 *  - Bounded: the file's type and size are read from its row first; only a
 *    PNG, JPEG or WebP under CROP_LIMITS.sourceBytes is read, as a stream
 *    cut at that size, and a save tries at most CROP_LIMITS.reads files.
 *  - Only pictures: decoded, then re-encoded as a small JPEG
 *    (`embeddableJpeg`): no SVG, no markup, nothing executable; the frame's
 *    runtime shows only a base64 image data URL.
 *  - Sealed: each crop carries the server's seal of its file id and the
 *    sha256 of its bytes (`sealPayload`, the drawing check seal's key). Every
 *    save (@mantle/content honestCanvasSource) drops a crop whose seal does
 *    not hold, or that no surviving checked mark names: a canvas edit can
 *    remove a crop, never swap its picture.
 *  - Size: each crop at most CROP_LIMITS.bytes, all of them at most
 *    CROP_LIMITS.totalBytes and CROP_LIMITS.count, and never past the room
 *    the canvas's 1 MB cap leaves beside the drawing (`cropRoom`). What does
 *    not fit is said, and the guess shows its words without a picture.
 *
 * An update reuses the crops the canvas already carries for the ids still
 * named (their seals still hold), and reads only the new ones. So a canvas
 * can carry a picture its current author could not open: one an earlier
 * save embedded for another author (an update by an editor, a copy of the
 * canvas), kept because the mark that names it is still sealed. Rights
 * are checked when a picture is first read, never again.
 *
 * Only the crops of sealed marks are read (`embedSealedCheckCrops`: the
 * save's honest pass first): a mark the save would make unchecked never
 * has its picture decoded, nor takes the room of a sealed one.
 *
 * A shared canvas (a public link) carries its crops like any other content
 * of the canvas.
 */
import { createHash } from 'node:crypto';
import { drawingSealHolds } from '@mantle/content/drawing-seal';
import type { Readable } from 'node:stream';
import { embeddableJpeg, fileById, isEmbeddableImage, openFileById } from '@mantle/files';
import { CANVAS_MAX_BYTES } from '@mantle/content-core/canvas';
import {
  CROP_LIMITS,
  CROP_SEAL_PURPOSE,
  checkCropIds,
  cropSealPayload,
  honestImageChecks,
  type CanvasAssets,
  type CanvasCrop,
} from '@mantle/diagram-templates';
import { sealPayload } from './circuit-trace/check-seal';

/** Kept free beside the drawing and its crops, for what the save itself
 *  writes into the data block (the recounted `checks`). */
const ROOM_MARGIN = 4_000;
/** The assets block's own markup, and one crop entry's beside its URL:
 *  `"<file id>":{"src":"...","sig":"<64 hex>"},`. */
const BLOCK_COST = 80;
const ENTRY_COST = 140;

/** The bytes the assets block may take in a canvas whose source without
 *  it is `source`: the canvas cap less the drawing and a margin. */
export function cropRoom(source: string): number {
  return Math.max(0, CANVAS_MAX_BYTES - Buffer.byteLength(source, 'utf8') - ROOM_MARGIN);
}

export type CropFile = { bytes: Buffer; mimeType: string };
export type CropRead = (fileId: string) => Promise<CropFile | null>;

/** A stream's bytes, or null past `max` (the stream is stopped there). */
async function readCapped(stream: Readable, max: number): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let n = 0;
  try {
    for await (const chunk of stream) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      n += b.byteLength;
      if (n > max) {
        stream.destroy();
        return null;
      }
      parts.push(b);
    }
  } catch {
    return null;
  }
  return Buffer.concat(parts);
}

/** The caller's own read of a crop file (scoped, as every tool read): its
 *  type and size from the row first, then the bytes, cut at the limit. */
export function scopedCropRead(ownerId: string): CropRead {
  return async (fileId) => {
    const row = await fileById({ ownerId, fileId }).catch(() => null);
    if (!row || !isEmbeddableImage(row.mimeType ?? '')) return null;
    if (row.sizeBytes > CROP_LIMITS.sourceBytes) return null;
    const f = await openFileById({ ownerId, fileId }).catch(() => null);
    if (!f) return null;
    if (f.size > CROP_LIMITS.sourceBytes) {
      f.stream.destroy();
      return null;
    }
    const bytes = await readCapped(f.stream, CROP_LIMITS.sourceBytes);
    return bytes ? { bytes, mimeType: row.mimeType } : null;
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const some = (ids: string[]) => `${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', ...' : ''}`;

/**
 * The crops a save of this data may keep, embedded: the data passed
 * through the save's honest pass first (honestImageChecks with the
 * drawing seal), so only a sealed mark's crops are read
 * (`embedCheckCrops`). What present_create and present_update call.
 */
export function embedSealedCheckCrops(
  data: unknown,
  read: CropRead,
  opts: { room: number; have?: CanvasAssets | null },
): Promise<{ assets: CanvasAssets | null; notes: string[] }> {
  return embedCheckCrops(honestImageChecks(data, drawingSealHolds), read, opts);
}

/**
 * The crops to embed for this data, and a note on any left out. `null`
 * assets: the data names no crop that could be embedded (the canvas gets
 * no assets block). `room`: the bytes the assets block may take
 * (`cropRoom`); `have`: the crops the canvas carries now (an update).
 */
export async function embedCheckCrops(
  data: unknown,
  read: CropRead,
  opts: { room: number; have?: CanvasAssets | null },
): Promise<{ assets: CanvasAssets | null; notes: string[] }> {
  const ids = checkCropIds(data);
  if (!ids.length) return { assets: null, notes: [] };
  const crops: Record<string, CanvasCrop> = {};
  let raw = 0;
  let used = BLOCK_COST;
  let reads = 0;
  const missing: string[] = [];
  const over: string[] = [];
  const room: string[] = [];
  let unsealed = 0;
  const fits = (src: string, bytes: number): 'ok' | 'over' | 'room' => {
    if (raw + bytes > CROP_LIMITS.totalBytes) return 'over';
    if (used + src.length + ENTRY_COST > opts.room) return 'room';
    return 'ok';
  };
  for (const id of ids) {
    if (Object.keys(crops).length >= CROP_LIMITS.count) {
      over.push(id);
      continue;
    }
    const had = opts.have?.crops[id];
    let crop: CanvasCrop;
    let bytes: number;
    if (had) {
      crop = had;
      bytes = Math.floor(((had.src.length - had.src.indexOf(',') - 1) * 3) / 4);
    } else {
      if (reads >= CROP_LIMITS.reads) {
        over.push(id);
        continue;
      }
      reads += 1;
      const file = await read(id);
      const jpeg = file
        ? await embeddableJpeg(file.bytes, file.mimeType, {
            maxBytes: CROP_LIMITS.bytes,
            maxSourceBytes: CROP_LIMITS.sourceBytes,
          })
        : null;
      if (!jpeg) {
        missing.push(id);
        continue;
      }
      const sha = createHash('sha256').update(jpeg).digest('hex');
      const sig = sealPayload(CROP_SEAL_PURPOSE, cropSealPayload(id, sha));
      if (!sig) {
        unsealed += 1;
        continue;
      }
      crop = { src: `data:image/jpeg;base64,${jpeg.toString('base64')}`, sig };
      bytes = jpeg.byteLength;
    }
    const fit = fits(crop.src, bytes);
    if (fit !== 'ok') {
      (fit === 'over' ? over : room).push(id);
      continue;
    }
    raw += bytes;
    used += crop.src.length + ENTRY_COST;
    crops[id] = crop;
  }
  const notes: string[] = [];
  if (missing.length)
    notes.push(
      `${plural(missing.length, 'crop', 'crops')} named by a check could not be read as a picture you may open (${some(missing)}): those guesses show their question and answer without the picture.`,
    );
  if (over.length)
    notes.push(
      `${plural(over.length, 'crop', 'crops')} did not fit the canvas's picture budget (${CROP_LIMITS.count} crops, about ${Math.round(CROP_LIMITS.totalBytes / 1000)} KB): those guesses show their words without the picture; the crops stay in the drawing table's Checks tab.`,
    );
  if (room.length)
    notes.push(
      `${plural(room.length, 'crop', 'crops')} did not fit beside the drawing in the canvas's ${CANVAS_MAX_BYTES / 1_000_000} MB: those guesses show their words without the picture; the crops stay in the drawing table's Checks tab.`,
    );
  if (unsealed)
    notes.push(
      `${plural(unsealed, 'crop was', 'crops were')} not embedded: this brain has no master key to seal them with.`,
    );
  return { assets: Object.keys(crops).length ? { crops } : null, notes };
}
