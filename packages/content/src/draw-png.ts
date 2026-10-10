/**
 * A drawing's committed SVG snapshot (`draws.scene_svg`) rendered to a PNG,
 * for agents that can see images. The text an agent reads (`scene_text`)
 * keeps labels and `A -> B` relations but loses positions, colours, ticks,
 * switches and layout; a picture of the same drawing keeps all of it.
 *
 * Nothing is re-rendered from the scene, so an uncommitted draft can never
 * reach a picture, and the picture is what /s, the list preview and export
 * show. The snapshot is user data, so it passes two independent layers:
 *
 *  1. svg-sanitize.ts parses it as XML and rebuilds it from an allowlist,
 *     with every link that is not `#id` or an inline raster picture gone;
 *  2. the renderer (draw-png-render.ts) is resvg as WebAssembly in a worker
 *     thread: no file system, no network, a hard timeout, and fonts read
 *     from bytes with their unpacked size checked first.
 *
 * Callers own access: hand this only an SVG the reader may see, with the
 * images they may not see already taken out (draw-reader.ts).
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- loads the local ambient type for the untyped wawoff2 module
/// <reference path="./wawoff2.d.ts" />
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { RenderJob, RenderResult } from './draw-png-render';
import { sanitizeSceneSvg, type SvgRegion } from './svg-sanitize';
import { SCENE_SVG_MAX_BYTES } from './scene-svg';

/** The long edge of a rendered picture, in pixels. Big enough to read a
 *  whiteboard's small print, small enough to stay well under every vision
 *  model's image limits (the providers scale larger images down anyway). */
export const DRAW_PNG_LONG_EDGE = 2000;

/** A render that takes longer is stopped (its thread terminated). */
export const DRAW_PNG_TIMEOUT_MS = 20_000;
/** Renders at once, and renders allowed to wait for a slot. Past both, a
 *  request is refused at once rather than queued without bound. */
const MAX_CONCURRENT = 2;
const MAX_WAITING = 6;

/** A part of the scene, as fractions of its width and height (0 to 1, from
 *  the top-left corner). `{ x: 0.5, y: 0, width: 0.5, height: 0.5 }` is the
 *  top-right quarter. Rendered at the full long edge, so it zooms in. */
export type DrawRegion = SvgRegion;

export type DrawPng = {
  png: Buffer;
  width: number;
  height: number;
  /** The scene's own size (its viewBox), before any region. */
  sceneWidth: number;
  sceneHeight: number;
};

/** Whether a region is a usable part of the scene. */
export function validRegion(r: DrawRegion): boolean {
  const ok = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
  return (
    ok(r.x) &&
    ok(r.y) &&
    ok(r.width) &&
    ok(r.height) &&
    r.width > 0 &&
    r.height > 0 &&
    r.x + r.width <= 1.000001 &&
    r.y + r.height <= 1.000001
  );
}

const require = createRequire(import.meta.url);
let wasmModule: Promise<WebAssembly.Module> | null = null;
let fallbackFont: Promise<Uint8Array> | null = null;

/** The resvg WebAssembly, compiled once per process and handed to each
 *  worker (a compiled module crosses threads without recompiling). */
function resvgWasm(): Promise<WebAssembly.Module> {
  wasmModule ??= readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')).then((b) =>
    WebAssembly.compile(b),
  );
  return wasmModule;
}

/** Nunito Sans (OFL, licence beside it): drawn for any glyph the snapshot's
 *  own fonts do not carry, and for snapshots made before fonts were inlined.
 *  The WebAssembly renderer has no system fonts to fall back on. */
function bundledFallbackFont(): Promise<Uint8Array> {
  fallbackFont ??= (async () => {
    const { decompress } = await import('wawoff2');
    const woff2 = await readFile(new URL('../assets/fonts/nunito-sans.woff2', import.meta.url));
    return decompress(woff2);
  })();
  return fallbackFont;
}

let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT && waiting.length >= MAX_WAITING) {
    throw new Error('the picture renderer is busy; try again in a moment');
  }
  while (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Run one job in its own worker thread, ended at the deadline. */
async function renderInWorker(job: RenderJob, timeoutMs: number): Promise<RenderResult> {
  const wasm = await resvgWasm();
  return new Promise<RenderResult>((resolve, reject) => {
    const worker = new Worker(new URL('./draw-png-render.ts', import.meta.url), {
      workerData: { kind: 'mantle-draw-png', job, wasm },
      // This caps the JS heap ONLY. resvg and the font decoder run in
      // WebAssembly memory, which it does not cap; that is bounded by the
      // inputs instead: the long edge (the output canvas), the sanitizer's
      // pixel budget for inline pictures and its element caps, and the font
      // size checks made before unpacking (draw-png-render.ts).
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`the picture took longer than ${timeoutMs / 1000} s`))),
      timeoutMs,
    );
    worker.once('message', (m: { ok: true; result: RenderResult } | { ok: false; error: string }) =>
      finish(() => (m.ok ? resolve(m.result) : reject(new Error(m.error)))),
    );
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) =>
      finish(() => reject(new Error(`the picture renderer stopped (exit ${code})`))),
    );
  });
}

/**
 * Render a committed snapshot to a PNG on white: the whole scene, or one
 * region of it, with the long edge at `DRAW_PNG_LONG_EDGE`. Throws when the
 * snapshot is refused (not well-formed, a DOCTYPE, no size, too large), when
 * the renderer is busy, or past the timeout.
 */
export async function renderDrawSvgPng(
  svg: string,
  opts: {
    region?: DrawRegion;
    longEdge?: number;
    timeoutMs?: number;
    /** Scene file ids whose image the reader may see; absent = all. */
    keepImagesOf?: ReadonlySet<string>;
  } = {},
): Promise<DrawPng> {
  // The snapshot's own cap (a stored one is under it already; a caller that
  // hands anything else in gets the same bound).
  if (Buffer.byteLength(svg, 'utf8') > SCENE_SVG_MAX_BYTES) {
    throw new Error('the snapshot is too large to draw');
  }
  // The slot first: a busy renderer refuses before any parsing.
  return withSlot(async () => {
    const clean = sanitizeSceneSvg(svg, {
      ...(opts.region ? { region: opts.region } : {}),
      ...(opts.keepImagesOf ? { keepImagesOf: opts.keepImagesOf } : {}),
    });
    const [, , sw, sh] = clean.sceneBox;
    const w = opts.region ? opts.region.width * sw : sw;
    const h = opts.region ? opts.region.height * sh : sh;
    const job: RenderJob = {
      svg: clean.svg,
      fonts: clean.fonts,
      fallbackFont: await bundledFallbackFont(),
      longEdge: opts.longEdge ?? DRAW_PNG_LONG_EDGE,
      landscape: w >= h,
    };
    const out = await renderInWorker(job, opts.timeoutMs ?? DRAW_PNG_TIMEOUT_MS);
    return {
      png: Buffer.from(out.png.buffer, out.png.byteOffset, out.png.byteLength),
      width: out.width,
      height: out.height,
      sceneWidth: sw,
      sceneHeight: sh,
    };
  });
}

// ─── cache ────────────────────────────────────────────────────────────────
// The caller picks the key (draw_get: a hash of the SVG the reader gets,
// images already filtered, plus the region), and consults the cache only
// AFTER its own access check, so a hit never skips one. Memory only; a
// restart starts cold.
const CACHE_MAX_ENTRIES = 24;
const CACHE_MAX_BYTES = 48_000_000;
const cache = new Map<string, DrawPng>();
let cacheBytes = 0;

export function cachedDrawPng(key: string): DrawPng | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

export function cacheDrawPng(key: string, png: DrawPng): void {
  if (png.png.length > CACHE_MAX_BYTES / 4) return;
  const old = cache.get(key);
  if (old) {
    cache.delete(key);
    cacheBytes -= old.png.length;
  }
  cache.set(key, png);
  cacheBytes += png.png.length;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= cache.get(oldest)!.png.length;
    cache.delete(oldest);
  }
}
