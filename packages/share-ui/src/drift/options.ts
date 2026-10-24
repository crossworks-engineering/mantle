/**
 * Drift's option contract — everything a caller can say about a background,
 * with the ranges and defaults in one place so the engine, the React shell,
 * a settings UI and a stored spec all clamp the same way.
 */

/** The shape family and its list live with the stored spec
 *  (@mantle/content-core/drift-spec); re-exported for engine callers. */
import { DRIFT_STYLES, type DriftStyle } from '@mantle/content-core/drift-spec';

export { DRIFT_STYLES, type DriftStyle };

/** The most colours a shader takes. More than this turns to mud anyway. */
export const DRIFT_MAX_COLORS = 6;

export type DriftColor = {
  /** Any CSS colour. */
  color: string;
  /** Territory this colour claims, 0–2. 0 hides it without removing it. */
  weight?: number;
};

export type DriftOptions = {
  style: DriftStyle;
  /** The ground everything sits on (and what the vignette fades into). */
  background: string;
  /** 1–6 colours, painted over the ground. */
  colors: ReadonlyArray<string | DriftColor>;
  /** Seeds every position and phase — same seed, same picture. */
  seed: number;
  /** Animation rate. 0 renders one still frame and never schedules another. */
  speed: number;
  /** Zoom. Above 1 shows more, smaller features; below 1 fewer, larger ones. */
  scale: number;
  /** Turbulence, 0–1: how far the shapes are pushed off their clean forms. */
  warp: number;
  /** Edge softness, 0–1: crisp bands at 0, fully melted at 1. */
  softness: number;
  /** Depth, 0–1: shading and highlights (silk, dunes, marble). */
  lighting: number;
  /** Chroma multiplier, 0–2, applied in OKLab so lightness never shifts. */
  saturation: number;
  /** Film grain, 0–1. Static — it never re-rolls per frame. */
  grain: number;
  /** Edge fade into the background, 0–1. */
  vignette: number;
  /** Rotation of the whole field, degrees. */
  angle: number;
  /** How much the field leans toward the pointer, 0–1. 0 adds no listener. */
  pointer: number;

  // ---- performance -----------------------------------------------------
  /**
   * Field resolution as a fraction of CSS pixels, 0.1–1; 0 picks the style's
   * own (see {@link DRIFT_STYLE_RESOLUTION}). The gradient is low-frequency by
   * nature, so it is computed small and filtered up; the dither and grain are
   * applied at full size afterwards.
   */
  resolution: number;
  /** Frame cap. Slow ambient motion reads smooth at 30. */
  maxFps: number;
  /** Device-pixel-ratio cap for the output canvas. The output is only a
   *  filter-up plus dither, so 1 is plenty even on retina. */
  maxDpr: number;
  /** Lower `resolution` automatically while frames run late. */
  adaptive: boolean;
  /** Honour prefers-reduced-motion by rendering a still frame. */
  respectReducedMotion: boolean;
  /** Fade the canvas in over this many ms once the first frame lands. */
  fadeIn: number;
};

/**
 * The lowest field resolution at which each style is indistinguishable from
 * full size, measured side by side. Mesh has no edges at all, so it can go
 * lowest; the styles with crisp seams (silk rims, marble veins, dune ridges)
 * start to staircase below ~0.3.
 */
export const DRIFT_STYLE_RESOLUTION: Record<DriftStyle, number> = {
  mesh: 0.2,
  aurora: 0.3,
  silk: 0.35,
  dunes: 0.35,
  marble: 0.35,
};

export const DRIFT_DEFAULTS: DriftOptions = {
  style: 'mesh',
  background: '#0b0d12',
  colors: ['#3b5bdb', '#7048e8', '#0ca678', '#f08c00'],
  seed: 1,
  speed: 1,
  scale: 1,
  warp: 0.5,
  softness: 0.6,
  lighting: 0.5,
  saturation: 1,
  grain: 0.15,
  vignette: 0,
  angle: 0,
  pointer: 0,
  resolution: 0,
  maxFps: 30,
  maxDpr: 1,
  adaptive: true,
  respectReducedMotion: true,
  fadeIn: 600,
};

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Defaults filled, every number clamped to its documented range. */
export function normalizeDriftOptions(input: Partial<DriftOptions>): DriftOptions {
  const d = DRIFT_DEFAULTS;
  const style = DRIFT_STYLES.includes(input.style as DriftStyle)
    ? (input.style as DriftStyle)
    : d.style;
  const colors = (input.colors ?? d.colors).slice(0, DRIFT_MAX_COLORS);
  return {
    style,
    background: typeof input.background === 'string' ? input.background : d.background,
    colors: colors.length > 0 ? colors : d.colors,
    seed: Math.floor(clamp(input.seed, 0, 0xffffffff, d.seed)),
    speed: clamp(input.speed, 0, 10, d.speed),
    scale: clamp(input.scale, 0.25, 4, d.scale),
    warp: clamp(input.warp, 0, 1, d.warp),
    softness: clamp(input.softness, 0, 1, d.softness),
    lighting: clamp(input.lighting, 0, 1, d.lighting),
    saturation: clamp(input.saturation, 0, 2, d.saturation),
    grain: clamp(input.grain, 0, 1, d.grain),
    vignette: clamp(input.vignette, 0, 1, d.vignette),
    angle: clamp(input.angle, -360, 360, d.angle),
    pointer: clamp(input.pointer, 0, 1, d.pointer),
    resolution: input.resolution === 0 ? 0 : clamp(input.resolution, 0.1, 1, d.resolution),
    maxFps: clamp(input.maxFps, 1, 240, d.maxFps),
    maxDpr: clamp(input.maxDpr, 0.5, 4, d.maxDpr),
    adaptive: typeof input.adaptive === 'boolean' ? input.adaptive : d.adaptive,
    respectReducedMotion:
      typeof input.respectReducedMotion === 'boolean'
        ? input.respectReducedMotion
        : d.respectReducedMotion,
    fadeIn: clamp(input.fadeIn, 0, 5000, d.fadeIn),
  };
}

/** Deterministic PRNG (mulberry32) — same seed, same background, forever. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
