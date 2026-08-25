import type { NeatConfig } from '@firecms/neat';

/**
 * The Neat background — an animated WebGL gradient behind a whole surface,
 * generated in Settings → Appearance and stored on the brain's preferences
 * row. This module is the spec contract and the parameter derivation; it lives
 * HERE (published as @crossworks/share-ui) because two renderers consume it —
 * the jackdaw owner app (login screen, content area) and this repo's
 * server-rendered /s share surface — and the two must never disagree about
 * what a saved spec looks like.
 *
 * We store a SPEC, never colours: `{ v, seed, tone, speed }`. Every colour is
 * derived from the LIVE theme tokens at paint time, so one saved background
 * follows all ~40 colour themes and light/dark mode by construction — a
 * stored hex would break silently on most themes, exactly like a hardcoded
 * class would. The seed drives a deterministic PRNG for every other Neat
 * parameter, so "the background I saved" is reproducible from four numbers,
 * and "Generate" is just a re-roll of the seed.
 *
 * The derived colours are washes: each brand colour is pulled most of the way
 * into `--background` before it reaches the shader. That is the legibility
 * guarantee — the gradient reads as a tint of the page surface, never a
 * poster fighting the text sitting on it.
 */

export type NeatTone = 'auto' | 'darker' | 'lighter';

export type NeatBackgroundSpec = {
  v: 1;
  /** Seeds the PRNG that derives every Neat parameter. */
  seed: number;
  /** Push the wash below the page surface ('darker'), above it ('lighter'),
   *  or follow the mode — dark mode darkens, light mode lightens ('auto'). */
  tone: NeatTone;
  /** Animation speed, 0 (still) to {@link NEAT_SPEED_MAX}. */
  speed: number;
};

export const NEAT_SPEED_MAX = 6;
export const NEAT_DEFAULT_SPEED = 2;

/** Storage cap, mirrored by the server route — the canonical encoding of a
 *  valid spec is ~60 chars, so this is a garbage guard, not a limit. */
export const NEAT_BACKGROUND_MAX = 200;

const TONES: readonly NeatTone[] = ['auto', 'darker', 'lighter'];

/** Canonical wire encoding — fixed key order so equal specs compare equal as
 *  strings (the UI's dirty check and the renderer's effect key rely on it). */
export function encodeNeatSpec(spec: NeatBackgroundSpec): string {
  return JSON.stringify({ v: 1, seed: spec.seed, tone: spec.tone, speed: spec.speed });
}

/** Parse + shape-check a stored value. Garbage ⇒ null, never a throw — the
 *  same lenient contract every appearance preference follows on read. */
export function decodeNeatSpec(raw: unknown): NeatBackgroundSpec | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > NEAT_BACKGROUND_MAX) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.seed !== 'number' || !Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff)
    return null;
  if (typeof o.tone !== 'string' || !(TONES as readonly string[]).includes(o.tone)) return null;
  if (typeof o.speed !== 'number' || !Number.isFinite(o.speed) || o.speed < 0) return null;
  return {
    v: 1,
    seed: o.seed,
    tone: o.tone as NeatTone,
    speed: Math.min(o.speed, NEAT_SPEED_MAX),
  };
}

export function randomNeatSpec(
  prev?: Pick<NeatBackgroundSpec, 'tone' | 'speed'>,
): NeatBackgroundSpec {
  return {
    v: 1,
    seed: Math.floor(Math.random() * 0xffffffff),
    tone: prev?.tone ?? 'auto',
    speed: prev?.speed ?? NEAT_DEFAULT_SPEED,
  };
}

/** The tokens the shader needs, resolved to literal hex — WebGL cannot read
 *  `var()`, same constraint as the DiceBear ramp in theme-ramp.ts. */
export type NeatThemeTokens = {
  background: string;
  primary: string;
  accent: string;
  secondary: string;
};

/** Deterministic PRNG (mulberry32) — same seed, same background, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string): [number, number, number] | null {
  const t = hex.trim();
  // Shorthand #rgb MUST parse: the compiled stylesheets minify hex custom
  // properties (#ffffff → #fff, #eeeeee → #eee), so this is what
  // getComputedStyle actually returns on deployed builds. Rejecting it made
  // mixHex silently return the RAW brand colour — no wash, a saturated
  // poster instead of a tint — on exactly the themes whose tokens shorten,
  // and only in production (dev CSS is unminified). Light modes were hit
  // hardest because near-white grounds (#ffffff/#eeeeee) all shorten.
  const short = /^#?([0-9a-f]{3})$/i.exec(t)?.[1];
  if (short) {
    const c = (i: number) => parseInt(short.charAt(i) + short.charAt(i), 16);
    return [c(0), c(1), c(2)];
  }
  const digits = /^#?([0-9a-f]{6})$/i.exec(t)?.[1];
  if (!digits) return null;
  const n = parseInt(digits, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** `amount` of `into` mixed over `from` — 0 keeps `from`, 1 lands on `into`. */
function mixHex(from: string, into: string, amount: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(into);
  if (!a || !b) return from;
  return rgbToHex([
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ]);
}

/** Nudge toward black (factor < 1) or white (factor > 1). */
function shadeHex(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  if (factor <= 1) return rgbToHex([rgb[0] * factor, rgb[1] * factor, rgb[2] * factor]);
  const up = factor - 1;
  return rgbToHex([
    rgb[0] + (255 - rgb[0]) * up,
    rgb[1] + (255 - rgb[1]) * up,
    rgb[2] + (255 - rgb[2]) * up,
  ]);
}

/** Canonical #rrggbb for any hex this module can parse; unparseable values
 *  pass through untouched. EVERY colour handed to the shader goes through
 *  this: Neat's own parser is `parseInt(hex, 16)` on whatever it gets, so a
 *  shorthand `#fff` reads as the 24-bit int 0x000fff — rgb(0, 15, 255), an
 *  electric blue poster where the page ground should be. That is precisely
 *  what deployed light themes produced, because minified stylesheets shorten
 *  near-white tokens to #fff/#eee. */
function normalizeHex(hex: string): string {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex(rgb) : hex;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Spec + live tokens + mode → the full Neat config (minus `ref`/`resolution`,
 * which are the renderer's business). Pure and deterministic, so the settings
 * preview and the real surface can never disagree about what a saved spec
 * looks like.
 */
export function neatConfigFromSpec(
  spec: NeatBackgroundSpec,
  tokens: NeatThemeTokens,
  mode: 'light' | 'dark',
): NeatConfig {
  const rnd = mulberry32(spec.seed);
  const range = (lo: number, hi: number) => lo + rnd() * (hi - lo);
  const darker = spec.tone === 'darker' || (spec.tone === 'auto' && mode === 'dark');

  // Tokens arrive as whatever getComputedStyle returns — on deployed builds
  // that includes minifier shorthand. Normalized ONCE here, so both our wash
  // math and the raw pass-throughs below hand the shader canonical hex.
  const background = normalizeHex(tokens.background);
  const primary = normalizeHex(tokens.primary);
  const accent = normalizeHex(tokens.accent);
  const secondary = normalizeHex(tokens.secondary);

  // A wash: pull the brand colour part-way into the page background, then
  // nudge the result off the surface in the chosen direction. Enough colour
  // to read as a real gradient, close enough to the surface that content
  // sitting on it never fights it.
  const wash = (hex: string, towardBg: number) =>
    shadeHex(mixHex(hex, background, towardBg), darker ? 0.88 : 1.08);

  return {
    colors: [
      { color: background, enabled: true, influence: round2(range(0.3, 0.6)) },
      {
        color: wash(primary, round2(range(0.25, 0.5))),
        enabled: true,
        influence: round2(range(0.5, 0.9)),
      },
      {
        color: wash(accent, round2(range(0.25, 0.55))),
        enabled: true,
        influence: round2(range(0.45, 0.85)),
      },
      {
        color: wash(secondary, round2(range(0.35, 0.6))),
        enabled: true,
        influence: round2(range(0.35, 0.75)),
      },
      { color: background, enabled: true, influence: round2(range(0.25, 0.55)) },
    ],
    speed: spec.speed,
    horizontalPressure: round1(range(2, 5)),
    verticalPressure: round1(range(2, 5)),
    waveFrequencyX: round1(range(2, 6)),
    waveFrequencyY: round1(range(2, 6)),
    waveAmplitude: round1(range(3, 7)),
    // Keep the shader's own light play gentle: strong shadows/highlights are
    // exactly what would carve text-hostile contrast into the surface.
    shadows: round1(range(0, darker ? 3 : 1.5)),
    highlights: round1(range(0, darker ? 1.5 : 3)),
    colorBrightness: darker ? 0.95 : 1,
    colorSaturation: round1(range(-1, 2.5)),
    colorBlending: round1(range(5, 9)),
    grainScale: 2,
    grainIntensity: round2(range(0.02, 0.1)),
    grainSpeed: 0.3,
    wireframe: false,
    backgroundColor: background,
    backgroundAlpha: 1,
  };
}
