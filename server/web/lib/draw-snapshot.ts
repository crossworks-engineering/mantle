import { EXCALIDRAW_ENGINE, getDrawSnapshot, setDrawSvg } from '@mantle/content';
import { buildInternalRenderCookie } from '@/lib/auth';
import { renderDrawSvg, DrawRendererUnavailableError } from '@/lib/render-draw-svg';

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
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Collapses concurrent misses on the SAME drawing into one render — opening a
 *  list and an export at once must not queue two identical browser sessions. */
const inFlight = new Map<string, Promise<string | null>>();

function renderOnce(ownerId: string, id: string): Promise<string | null> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const p = withSlot(async () => {
    const svg = await renderDrawSvg(id, buildInternalRenderCookie(ownerId));
    // Store through the content layer, which validates it and — critically —
    // does NOT notify the extractor. Filling a render cache is not a content
    // change, and a corpus re-render must never trigger an LLM pass per item.
    if (svg) await setDrawSvg(ownerId, id, svg, EXCALIDRAW_ENGINE);
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
export async function getDrawSvgOrRender(ownerId: string, id: string): Promise<string | null> {
  const snap = await getDrawSnapshot(ownerId, id);
  if (!snap) return null; // not a draw, or not this owner's
  if (snap.svg && snap.engine === EXCALIDRAW_ENGINE) return snap.svg;

  try {
    return (await renderOnce(ownerId, id)) ?? snap.svg;
  } catch (err) {
    if (!(err instanceof DrawRendererUnavailableError)) {
      console.error(`[draw-snapshot] render failed for ${id}:`, err);
    }
    return snap.svg;
  }
}
