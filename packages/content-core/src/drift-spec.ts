/**
 * The stored form of the animated background (Drift), and the ONE codec for
 * it. The brain validates with it (projectNeatBackground), the /s reader and
 * the owner app decode with it (@mantle/share-ui/drift re-exports it), so a
 * spec the brain keeps is exactly a spec every renderer paints.
 *
 * It lives here, not in share-ui, because the brain's read projections are in
 * this package and share-ui depends on it, never the other way round. Pure
 * data and zero DOM: the engine and the theme maths stay in share-ui.
 *
 * Version 2 of the Neat spec. v1 (`{v:1, seed, tone, speed}`, everything a
 * brain stored before Drift, and the fresh-install default) still decodes,
 * upgraded to the silk style, the closest look. Encoding is always v2.
 *
 * Kept compact (short keys, fixed order) so the canonical encoding of the
 * largest valid spec stays well under the 200-char storage cap, and equal
 * specs compare equal as strings.
 */

/** Push the wash below the page surface ('darker'), above it ('lighter'), or
 *  follow the mode: dark mode darkens, light mode lightens ('auto'). */
export type DriftTone = 'auto' | 'darker' | 'lighter';

/** Which tokens feed the palette: the three brand roles, or the five chart
 *  colours (more hues, more variety, still per-theme). */
export type DriftPaletteSource = 'brand' | 'chart';

/**
 * The shape family. Each is its own fragment shader in the engine.
 *
 *  - `mesh`   soft colour fields drifting past each other. The calmest; the
 *             safest behind dense content.
 *  - `silk`   a lit, folded sheet: the Neat look, with real specular depth.
 *  - `aurora` curtains of light with a hard foot and a long soft tail.
 *  - `dunes`  stacked horizon layers, each casting a soft shadow on the one
 *             behind it. Rotate it for diagonal or vertical strata.
 *  - `marble` recursive domain warp: liquid, smoke, agate.
 */
export type DriftStyle = 'mesh' | 'silk' | 'aurora' | 'dunes' | 'marble';

export const DRIFT_STYLES: readonly DriftStyle[] = ['mesh', 'silk', 'aurora', 'dunes', 'marble'];
export const DRIFT_TONES: readonly DriftTone[] = ['auto', 'darker', 'lighter'];
export const DRIFT_PALETTES: readonly DriftPaletteSource[] = ['brand', 'chart'];

export type DriftSpec = {
  v: 2;
  seed: number;
  tone: DriftTone;
  /** 0 (still) to {@link DRIFT_SPEED_MAX}, the same range as the Neat spec. */
  speed: number;
  style: DriftStyle;
  pal: DriftPaletteSource;
  /** How far the colours stray from the page surface, 0 to 1. */
  str: number;
  scale: number;
  warp: number;
  soft: number;
  light: number;
  grain: number;
  angle: number;
};

export const DRIFT_SPEED_MAX = 6;
/** Storage cap, shared with the brain's PUT route and read projection. */
export const DRIFT_SPEC_MAX = 200;

export const DRIFT_SPEC_DEFAULTS: Omit<DriftSpec, 'seed'> = {
  v: 2,
  tone: 'auto',
  speed: 2,
  style: 'mesh',
  pal: 'brand',
  str: 0.55,
  scale: 1,
  warp: 0.5,
  soft: 0.6,
  light: 0.5,
  grain: 0.12,
  angle: 0,
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? round2(Math.min(hi, Math.max(lo, v))) : fallback;

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  (list as readonly unknown[]).includes(v) ? (v as T) : fallback;

function normalize(o: Partial<DriftSpec> & { seed: number }): DriftSpec {
  const d = DRIFT_SPEC_DEFAULTS;
  return {
    v: 2,
    seed: o.seed >>> 0,
    tone: oneOf(DRIFT_TONES, o.tone, d.tone),
    speed: num(o.speed, 0, DRIFT_SPEED_MAX, d.speed),
    style: oneOf(DRIFT_STYLES, o.style, d.style),
    pal: oneOf(DRIFT_PALETTES, o.pal, d.pal),
    str: num(o.str, 0, 1, d.str),
    scale: num(o.scale, 0.25, 4, d.scale),
    warp: num(o.warp, 0, 1, d.warp),
    soft: num(o.soft, 0, 1, d.soft),
    light: num(o.light, 0, 1, d.light),
    grain: num(o.grain, 0, 1, d.grain),
    angle: Math.round(num(o.angle, -180, 180, d.angle)),
  };
}

/** Canonical wire encoding: always v2, fixed key order, rounded numbers. */
export function encodeDriftSpec(spec: DriftSpec): string {
  const s = normalize(spec);
  return JSON.stringify({
    v: 2,
    seed: s.seed,
    tone: s.tone,
    speed: s.speed,
    style: s.style,
    pal: s.pal,
    str: s.str,
    scale: s.scale,
    warp: s.warp,
    soft: s.soft,
    light: s.light,
    grain: s.grain,
    angle: s.angle,
  });
}

/**
 * Parse and shape-check a stored value. Garbage reads as null (off), never a
 * throw. Accepts v2, and v1 (the Neat spec) upgraded to the silk style.
 * Out-of-range numbers clamp rather than reject, so a spec saved by a newer
 * client with a wider range still paints; an unknown version is off.
 */
export function decodeDriftSpec(raw: unknown): DriftSpec | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length === 0 || t.length > DRIFT_SPEC_MAX) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.seed !== 'number' || !Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff)
    return null;
  if (o.v === 1) {
    if (!(DRIFT_TONES as readonly unknown[]).includes(o.tone)) return null;
    if (typeof o.speed !== 'number' || !Number.isFinite(o.speed) || o.speed < 0) return null;
    return normalize({ seed: o.seed, tone: o.tone as DriftTone, speed: o.speed, style: 'silk' });
  }
  if (o.v !== 2) return null;
  return normalize(o as Partial<DriftSpec> & { seed: number });
}

/** A fresh seed over the given look (the generator's "Generate"). */
export function randomDriftSpec(prev?: Partial<DriftSpec>): DriftSpec {
  return normalize({
    ...DRIFT_SPEC_DEFAULTS,
    ...prev,
    seed: Math.floor(Math.random() * 0xffffffff),
  });
}
