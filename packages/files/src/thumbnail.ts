/**
 * Image thumbnails — the cached, resized derivative behind `?thumb=1`.
 *
 * A file grid that shows real previews needs small images, not the originals:
 * a folder of 40 phone photos is ~200 MB of JPEG, and handing that to a grid
 * of <img> tags makes "browse my gallery" a bandwidth incident. This module
 * renders a bounded-size JPEG per image and caches it on disk, so each photo
 * pays the decode ONCE per content-version.
 *
 * Engine: `@napi-rs/canvas`, which packages/files already carries for PDF
 * rasterization — decode via loadImage, draw scaled, encode JPEG. No new
 * dependency, no system packages. HEIC goes through the existing
 * `heic-convert` transcode first (same path the vision pipeline uses), so
 * iPhone photos thumbnail like everything else.
 *
 * Cache layout: `<filesRoot>/../file-thumbs/<sha256>.<maxDim>.jpg` — a
 * SIBLING of the files root, the same pattern as forum-uploads' quarantine,
 * deliberately outside the watched `files` tree so the disk-sync watcher
 * never mistakes a derivative for a user file. Keyed by CONTENT hash: an
 * overwritten file gets a new sha and therefore a fresh thumbnail; the stale
 * derivative is unlinked best-effort by the delete path and swept by age for
 * everything that slips through (an orphaned thumb is a few KB, not a
 * correctness problem).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { filesRoot } from './paths';
import { transcodeImageForVision } from './transcode';

/** Bound the source we are willing to DECODE. A decode allocates
 *  width×height×4 bytes regardless of file size, so both dimensions are
 *  capped: bytes here, pixels after the header probe. */
export const THUMB_SOURCE_MAX_BYTES = 40 * 1024 * 1024;
/** Longest edge of the derivative. One size keeps the cache simple; 512 is
 *  crisp on a 2x grid tile of ~256 css px. */
export const THUMB_MAX_DIM = 512;
/** Only raster formats the canvas can decode. SVG scales losslessly in the
 *  browser and gif animation would be flattened — both are served raw by the
 *  route instead of thumbnailed here. */
const THUMBABLE_MIME_RE = /^image\/(png|jpe?g|webp|avif|bmp|heic|heif)$/i;

export function isThumbable(mimeType: string): boolean {
  return THUMBABLE_MIME_RE.test(mimeType.split(';')[0]!.trim());
}

export function thumbsRoot(): string {
  return path.resolve(filesRoot(), '..', 'file-thumbs');
}

function thumbPath(sha256: string, maxDim: number, dir = thumbsRoot()): string {
  return path.join(dir, `${sha256}.${maxDim}.jpg`);
}

/** A marker for a content hash that could not be thumbnailed (too big, or
 *  the decode failed). Same prefix as the cache file, so deleteThumbnailsFor
 *  removes it too. It stops a repeat request from loading the source again. */
function failPath(sha256: string, maxDim: number, dir = thumbsRoot()): string {
  return path.join(dir, `${sha256}.${maxDim}.fail`);
}

/** How long a failure marker holds before a render is tried again. */
const FAIL_TTL_MS = 24 * 60 * 60 * 1000;

async function recentFailure(file: string): Promise<boolean> {
  try {
    return Date.now() - (await fs.stat(file)).mtimeMs < FAIL_TTL_MS;
  } catch {
    return false;
  }
}

async function markFailure(file: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '');
  } catch {
    /* best effort: the next request just tries again */
  }
}

/** Renders in progress, by cache file: parallel requests for one image share
 *  one decode instead of each loading the source. */
const inflight = new Map<string, Promise<Buffer | null>>();

/**
 * Return the cached thumbnail for a content hash, rendering it on miss.
 * `null` means "no thumbnail possible" (unsupported format, decode failure,
 * oversized source) — the caller falls back to the type icon, never errors.
 */
export async function thumbnailFor(args: {
  sha256: string;
  mimeType: string;
  /** Loads the ORIGINAL bytes; called only on cache miss. */
  loadBytes: () => Promise<Buffer | null>;
  /** The source's size when the caller knows it: an oversized source is
   *  refused BEFORE loadBytes reads it into memory. */
  sizeBytes?: number | null;
  maxDim?: number;
  /** Where the derivative is cached; default the brain's shared cache. A
   *  member's private file passes its own space's folder (audit S9), so the
   *  thumbnail never sits in the shared cache and goes with the file. */
  cacheDir?: string;
}): Promise<Buffer | null> {
  if (!isThumbable(args.mimeType)) return null;
  if (args.sizeBytes != null && args.sizeBytes > THUMB_SOURCE_MAX_BYTES) return null;
  const dim = args.maxDim ?? THUMB_MAX_DIM;
  const file = thumbPath(args.sha256, dim, args.cacheDir);
  try {
    return await fs.readFile(file);
  } catch {
    /* miss — render below */
  }
  const failed = failPath(args.sha256, dim, args.cacheDir);
  if (await recentFailure(failed)) return null;
  const running = inflight.get(file);
  if (running) return running;
  const render = renderThumbnail(args.loadBytes, args.mimeType, dim, file, failed);
  inflight.set(file, render);
  try {
    return await render;
  } finally {
    inflight.delete(file);
  }
}

async function renderThumbnail(
  loadBytes: () => Promise<Buffer | null>,
  mimeType: string,
  dim: number,
  file: string,
  failed: string,
): Promise<Buffer | null> {
  const original = await loadBytes();
  if (!original || original.byteLength === 0) return null;
  if (original.byteLength > THUMB_SOURCE_MAX_BYTES) {
    await markFailure(failed);
    return null;
  }
  try {
    // HEIC/HEIF → JPEG first (canvas can't decode them); pass-through for
    // everything else. Reuses the vision pipeline's transcode + its caps.
    const { bytes } = await transcodeImageForVision(original, mimeType, null);
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(bytes);
    const w = img.width;
    const h = img.height;
    if (!w || !h) return null;
    const scale = Math.min(1, dim / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = createCanvas(tw, th);
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha — composite transparent PNGs onto white rather than
    // letting the encoder pick black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tw, th);
    ctx.drawImage(img, 0, 0, tw, th);
    const jpeg = canvas.toBuffer('image/jpeg', 82);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename so a concurrent request never reads a half-written
    // cache file. Collisions are benign (same content ⇒ same output).
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, jpeg);
    await fs.rename(tmp, file).catch(async () => {
      await fs.unlink(tmp).catch(() => {});
    });
    return jpeg;
  } catch (err) {
    console.warn('[files] thumbnail render failed:', err instanceof Error ? err.message : err);
    await markFailure(failed);
    return null;
  }
}

/** Best-effort removal of a content hash's derivatives (any dimension).
 *  Called by the file delete path; failure is logged, never thrown. */
export async function deleteThumbnailsFor(sha256: string | null): Promise<void> {
  if (!sha256) return;
  try {
    const entries = await fs.readdir(thumbsRoot());
    await Promise.all(
      entries
        .filter((e) => e.startsWith(`${sha256}.`))
        .map((e) => fs.unlink(path.join(thumbsRoot(), e)).catch(() => {})),
    );
  } catch {
    /* thumbs dir may not exist yet */
  }
}
