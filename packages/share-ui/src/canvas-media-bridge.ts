/**
 * The host half of a canvas's `mantle.media` (task a265178d): what
 * CanvasSandbox does with a `{v:1, kind:'media', n, id, file}` message from
 * its frame, and where it gets the bytes. Pure but for the fetch it is
 * handed, so every check is tested without a browser
 * (canvas-media-bridge.test.ts).
 *
 * The frame is hostile. Its message is taken only from the proven document
 * with its nonce (acceptsDataMessage, as a data call), and only for a file
 * id the canvas DECLARED (the `assets` its frame ticket returned: the saved
 * `meta.assets`; on an open link, the link's list `meta.linkAssets`). The
 * bytes come through the host's own credential from a route that checks
 * the reader again: the owner side's file route (the viewer's own read
 * right), the open link's asset route (a file of the canvas's own
 * workspace that the saver may edit, decision 7 and task 71285cd1). Any miss is one answer, CANVAS_MEDIA_NO_ACCESS. Only
 * an allowed type (CANVAS_MEDIA_MIMES) of at most CANVAS_MEDIA_MAX_BYTES is
 * handed over, as an ArrayBuffer the frame turns into a blob: URL.
 */
import {
  CANVAS_MEDIA_CALL_TIMEOUT_MS,
  CANVAS_MEDIA_MAX_BYTES,
  CANVAS_MEDIA_NO_ACCESS,
  canvasMediaMime,
  isCanvasAssetId,
} from '@mantle/content-core/canvas-media';

/** Where the bytes of a declared file come from, by file id. */
export type CanvasMediaSource = (fileId: string) => string;

/**
 * The owner side's media source for a canvas API base: the brain's own file
 * route (`/api/files/files/<id>?raw=1`, the viewer's read right), next to
 * `/api/presents/<id>` (relative on a one-origin box, absolute on a split
 * client). Null for a base of another shape: no media.
 */
export function ownerCanvasMediaSource(apiBase: string): CanvasMediaSource | null {
  const m = /^(.*)\/api\/presents\/[^/?#]+$/.exec(apiBase);
  if (!m) return null;
  const root = m[1]!;
  return (fileId) => `${root}/api/files/files/${encodeURIComponent(fileId)}?raw=1`;
}

/** The declared ids a frame-ticket answer carries (`assets`), lower case;
 *  anything that is not a list of uuids reads as none. */
export function readTicketAssets(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const v of raw) if (isCanvasAssetId(v)) out.add(v.toLowerCase());
  return out;
}

export type CanvasMediaFetched =
  { ok: true; mime: string; bytes: ArrayBuffer } | { ok: false; error: string };

const TOO_LARGE = `this file is over ${CANVAS_MEDIA_MAX_BYTES / (1024 * 1024)} MB`;

/** The body, read to at most `max` bytes; null when it is longer (the read
 *  is stopped there, never buffered whole). */
async function readCapped(res: Response, max: number): Promise<ArrayBuffer | null> {
  if (!res.body) {
    const all = await res.arrayBuffer();
    return all.byteLength > max ? null : all;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer;
}

/**
 * Fetch one declared file for the frame: the bytes and their type, or the
 * words the frame hears. A route's refusal (404, 403, 401) is "no access",
 * whatever it was; the size and the type are looked at only after the route
 * said yes, so they tell nothing about a file the reader may not have.
 */
export async function fetchCanvasMedia(
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
): Promise<CanvasMediaFetched> {
  let res: Response;
  try {
    res = await fetcher(url, { signal: AbortSignal.timeout(CANVAS_MEDIA_CALL_TIMEOUT_MS) });
  } catch {
    return { ok: false, error: 'the file could not be reached' };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 429) return { ok: false, error: 'too many files asked for: wait a moment' };
    return { ok: false, error: CANVAS_MEDIA_NO_ACCESS };
  }
  const mime = canvasMediaMime(res.headers.get('content-type'));
  if (!mime) {
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      error: 'a canvas plays mp3 or ogg sound and shows png, jpeg or webp pictures only',
    };
  }
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > CANVAS_MEDIA_MAX_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, error: TOO_LARGE };
  }
  try {
    const bytes = await readCapped(res, CANVAS_MEDIA_MAX_BYTES);
    if (!bytes) return { ok: false, error: TOO_LARGE };
    return { ok: true, mime, bytes };
  } catch {
    return { ok: false, error: 'the file could not be read' };
  }
}
