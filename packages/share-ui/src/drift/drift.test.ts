import { describe, expect, it } from 'vitest';
import { oklabToRgb, parseHexOrRgb, rgbToOklab } from './color';
import { DRIFT_STYLE_RESOLUTION, normalizeDriftOptions } from './options';
import {
  DRIFT_SPEC_MAX,
  decodeDriftSpec,
  driftOptionsFromSpec,
  encodeDriftSpec,
  randomDriftSpec,
  type DriftSpec,
} from './spec';
import { driftPaletteFromTheme, type DriftThemeTokens } from './theme';

const TOKENS: DriftThemeTokens = {
  background: '#fff',
  primary: '#3b5bdb',
  accent: '#7048e8',
  secondary: '#0ca678',
  chart: ['#666ed1', '#d08300', '#2f9e44', '#e03131', '#1c7ed6'],
};

describe('color', () => {
  it('parses minified shorthand hex — what deployed stylesheets hand back', () => {
    expect(parseHexOrRgb('#fff')).toEqual([255, 255, 255]);
    expect(parseHexOrRgb('#eeeeee')).toEqual([238, 238, 238]);
    expect(parseHexOrRgb('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
    expect(parseHexOrRgb('nope')).toBeNull();
  });

  it('round-trips sRGB through OKLab', () => {
    for (const rgb of [
      [0, 0, 0],
      [255, 255, 255],
      [59, 91, 219],
      [240, 140, 0],
    ] as const) {
      expect(oklabToRgb(rgbToOklab([...rgb]))).toEqual([...rgb]);
    }
  });
});

describe('spec', () => {
  it('round-trips and encodes canonically', () => {
    const spec = randomDriftSpec({ style: 'aurora', warp: 0.333333 });
    const encoded = encodeDriftSpec(spec);
    expect(decodeDriftSpec(encoded)).toEqual({ ...spec, warp: 0.33 });
    expect(encodeDriftSpec(decodeDriftSpec(encoded)!)).toBe(encoded);
  });

  it('keeps the largest spec under the storage cap', () => {
    const worst: DriftSpec = {
      v: 2,
      seed: 0xffffffff,
      tone: 'lighter',
      speed: 5.55,
      style: 'marble',
      pal: 'chart',
      str: 0.55,
      scale: 3.33,
      warp: 0.55,
      soft: 0.55,
      light: 0.55,
      grain: 0.55,
      angle: -179,
    };
    expect(encodeDriftSpec(worst).length).toBeLessThan(DRIFT_SPEC_MAX);
  });

  it('upgrades a saved Neat v1 spec to silk, keeping seed, tone and speed', () => {
    expect(decodeDriftSpec('{"v":1,"seed":55361,"tone":"darker","speed":3}')).toMatchObject({
      v: 2,
      seed: 55361,
      tone: 'darker',
      speed: 3,
      style: 'silk',
    });
  });

  it('rejects garbage and clamps out-of-range numbers', () => {
    expect(decodeDriftSpec('')).toBeNull();
    expect(decodeDriftSpec('{')).toBeNull();
    expect(decodeDriftSpec('{"v":3,"seed":1}')).toBeNull();
    expect(decodeDriftSpec('{"v":2,"seed":-1}')).toBeNull();
    expect(decodeDriftSpec('{"v":1,"seed":1,"tone":"loud","speed":1}')).toBeNull();
    expect(decodeDriftSpec('{"v":2,"seed":1,"warp":9,"style":"blob"}')).toMatchObject({
      warp: 1,
      style: 'mesh',
    });
  });
});

describe('theme palette', () => {
  const base = { seed: 7, tone: 'auto' as const, mode: 'light' as const, source: 'brand' as const };

  it('is deterministic per seed', () => {
    expect(driftPaletteFromTheme(TOKENS, { ...base, strength: 0.5 })).toEqual(
      driftPaletteFromTheme(TOKENS, { ...base, strength: 0.5 }),
    );
  });

  it('washes toward the page surface as strength falls', () => {
    const chroma = (hex: string) => {
      const [, a, b] = rgbToOklab(parseHexOrRgb(hex)!);
      return Math.hypot(a, b);
    };
    const total = (strength: number) =>
      driftPaletteFromTheme(TOKENS, { ...base, strength }).colors.reduce(
        (s, c) => s + chroma(c),
        0,
      );
    expect(total(0.1)).toBeLessThan(total(0.5));
    expect(total(0.5)).toBeLessThan(total(1));
  });

  it('uses the chart tokens when asked, plus the ground', () => {
    const p = driftPaletteFromTheme(TOKENS, { ...base, strength: 1, source: 'chart' });
    expect(p.colors).toHaveLength(TOKENS.chart.length + 1);
  });

  it('maps a spec onto engine options', () => {
    const spec = { ...decodeDriftSpec('{"v":2,"seed":9,"speed":4,"style":"dunes"}')! };
    const o = driftOptionsFromSpec(spec, TOKENS, 'dark');
    expect(o.style).toBe('dunes');
    expect(o.speed).toBe(2);
    expect(o.colors?.length).toBe(4);
  });
});

describe('options', () => {
  it('fills defaults, clamps, and leaves resolution 0 to mean per-style', () => {
    const o = normalizeDriftOptions({ warp: 5, colors: [], resolution: 0 });
    expect(o.warp).toBe(1);
    expect(o.colors.length).toBeGreaterThan(0);
    expect(o.resolution).toBe(0);
    expect(DRIFT_STYLE_RESOLUTION.mesh).toBeLessThan(DRIFT_STYLE_RESOLUTION.silk);
  });
});
