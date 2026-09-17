import { EXCALIDRAW_ENGINE, getDrawSnapshot, setDrawSvg } from '@mantle/content';
import { buildInternalRenderCookie } from '@/lib/auth';
import { renderDrawSvg, DrawRendererUnavailableError } from '@/lib/render-draw-svg';
import { renderDrawPng, type DrawPng } from '@/lib/render-draw-png';

/**
 * Read a draw's SVG snapshot, rendering it first if the cache is empty or was
 * drawn by a different Excalidraw version.
 *
 * `draws.scene_svg` is a cache, not a source of truth. The editor fills it at
 * commit and that stays the fast path, covering essentially every drawing a
 * human makes; this exists for the cases nothing did — a drawing authored by
 * an agent, a snapshot invalidated by an upstream upgrade, an export that
 * failed client-side.
 *
 * NOT for anonymous callers. Rendering spawns a browser, so the public share
 * route deliberately serves the cache only and shows its placeholder on a
 * miss; a shared drawing gets filled by the owner viewing it or by the
 * `draws:re-render` maintenance task, never by its audience.
 */

/** Chromium is the scarce resource. Two at a time is enough to keep an owner's
 *  list responsive without letting a re-render sweep starve PDF exports. */
const MAX_CONCURRENT = 2;
let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  // `while`, not `if`: a woken waiter must RE-CHECK. With `if`, a caller
  // arriving between the release and the waiter's resumption takes the slot
  // and the waiter takes it too, and the overshoot is sticky — every
  // subsequent release wakes another waiter straight back up to it.
  while (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Collapses concurrent misses on the SAME drawing into one render — opening a
 *  list and an export at once must not queue two identical browser sessions.
 *  Keyed by node id alone, which is safe because every caller passes through
 *  the owner-scoped getDrawSnapshot below before reaching here. */
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Drawings whose last render produced nothing, and when to stop skipping them.
 *
 * Without this a failing drawing re-renders on EVERY request, forever: nothing
 * is stored, so the snapshot stays missing, so the next request tries again —
 * a 20-50 second Chromium round trip each time. The oversized-snapshot case is
 * a guaranteed loop, since the sidecar keeps producing the same too-large SVG
 * that validation keeps rejecting. Memory-only and deliberately short: a
 * restart or a fixed drawing gets a fresh attempt without operator action.
 */
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const failedUntil = new Map<string, number>();

function inCooldown(id: string): boolean {
  const until = failedUntil.get(id);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    failedUntil.delete(id);
    return false;
  }
  return true;
}

function renderOnce(
  ownerId: string,
  id: string,
  expectedVersion: number,
  hasCachedSvg: boolean,
): Promise<string | null> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const p = withSlot(async () => {
    const { svg, partial } = await renderDrawSvg(id, buildInternalRenderCookie(ownerId));
    // A partial render (some scene images missing/hung) beats NOTHING, so it
    // may fill an empty cache — but it must never overwrite a snapshot that
    // still shows the images. Cooldown either way: the missing file won't
    // reappear within the window, so retrying per-request would loop Chromium.
    if (!svg || (partial && hasCachedSvg)) {
      failedUntil.set(id, Date.now() + FAILURE_COOLDOWN_MS);
      return null;
    }
    // Store through the content layer, which validates it and — critically —
    // does NOT notify the extractor. Filling a render cache is not a content
    // change, and a corpus re-render must never trigger an LLM pass per item.
    const stored = await setDrawSvg(ownerId, id, svg, EXCALIDRAW_ENGINE, expectedVersion);
    if (!stored) {
      // Either validation rejected it or a newer commit landed mid-render.
      // Returning null rather than the string matters: an unstored snapshot
      // must not be served, or the validator would be a storage-only check
      // while the bytes reached a browser anyway.
      failedUntil.set(id, Date.now() + FAILURE_COOLDOWN_MS);
      return null;
    }
    failedUntil.delete(id);
    return svg;
  }).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

/**
 * The snapshot, filling the cache on a miss. Returns null when the draw does
 * not exist, has an empty scene, or cannot be rendered right now.
 *
 * Every failure degrades rather than throwing: if the sidecar is down we serve
 * whatever is cached (a stale render beats no drawing) and fall back to the
 * caller's existing placeholder when there is nothing at all.
 */
export async function getDrawSvgOrRender(
  ownerId: string,
  id: string,
  opts: { force?: boolean } = {},
): Promise<string | null> {
  const snap = await getDrawSnapshot(ownerId, id);
  if (!snap) return null; // not a draw, or not this owner's
  if (!opts.force && snap.svg && snap.engine === EXCALIDRAW_ENGINE) return snap.svg;
  // An empty scene has no snapshot to produce. Answered from SQL, so it never
  // costs a browser session — and it is the most common "missing" case, since
  // every drawing starts empty.
  if (snap.isEmpty) return snap.svg;
  if (!opts.force && inCooldown(id)) return snap.svg;

  try {
    return (await renderOnce(ownerId, id, snap.version, snap.svg != null)) ?? snap.svg;
  } catch (err) {
    if (!(err instanceof DrawRendererUnavailableError)) {
      console.error(`[draw-snapshot] render failed for ${id}:`, err);
    }
    failedUntil.set(id, Date.now() + FAILURE_COOLDOWN_MS);
    return snap.svg;
  }
}

/**
 * The snapshot as a PNG, for the one consumer that can't take SVG: Word.
 *
 * Warm-then-raster, the same order the PDF export uses — the raster is a
 * screenshot of the committed snapshot, so the snapshot has to exist first,
 * and a drawing no browser ever committed still exports. Null means there is
 * no picture (nothing committed, an empty scene, or the sidecar is down), and
 * the caller degrades to its placeholder.
 *
 * Shares the Chromium semaphore with the SVG path, and deliberately caches
 * nothing: a raster is a transient export artefact, not a second copy of the
 * snapshot to keep in step with the first. Exports are hand-initiated and
 * rare, so a repeatedly-failing drawing costs a session per export rather than
 * per request — no cooldown needed here.
 */
export async function getDrawPngOrRender(ownerId: string, id: string): Promise<DrawPng | null> {
  const svg = await getDrawSvgOrRender(ownerId, id);
  if (!svg) return null;
  try {
    return await withSlot(() => renderDrawPng(id, buildInternalRenderCookie(ownerId)));
  } catch (err) {
    if (!(err instanceof DrawRendererUnavailableError)) {
      console.error(`[draw-snapshot] raster failed for ${id}:`, err);
    }
    return null;
  }
}
