import { describe, expect, it } from 'vitest';
import { decodeNeatSpec, encodeNeatSpec, neatConfigFromSpec } from './neat-background';

const SPEC = { v: 1 as const, seed: 2325271021, tone: 'auto' as const, speed: 2 };

describe('decodeNeatSpec', () => {
  it('round-trips the canonical encoding', () => {
    expect(decodeNeatSpec(encodeNeatSpec(SPEC))).toEqual(SPEC);
  });

  it('rejects garbage as null, never a throw', () => {
    for (const bad of [null, '', '{}', '{"v":2}', 'not json', '{"v":1,"seed":-1}']) {
      expect(decodeNeatSpec(bad)).toBeNull();
    }
  });
});

describe('neatConfigFromSpec — the wash', () => {
  const long = {
    background: '#ffffff',
    primary: '#b85c23',
    accent: '#eeeeee',
    secondary: '#527575',
  };
  // What getComputedStyle actually returns on a deployed build: the compiled
  // stylesheet minifies hex custom properties to shorthand where possible.
  const short = { background: '#fff', primary: '#b85c23', accent: '#eee', secondary: '#527575' };

  it('produces the IDENTICAL config for shorthand #rgb and #rrggbb tokens', () => {
    // Whole-config equality on purpose: it pins the wash (a failed shorthand
    // parse degraded stops to the raw brand colour) AND the raw pass-throughs
    // (colors[0]/[4] and backgroundColor once carried '#fff' verbatim, which
    // Neat's parseInt-based parser reads as 0x000fff — electric blue).
    expect(neatConfigFromSpec(SPEC, short, 'light')).toEqual(
      neatConfigFromSpec(SPEC, long, 'light'),
    );
  });

  it('hands the shader only canonical six-digit hex, never shorthand', () => {
    const c = neatConfigFromSpec(SPEC, short, 'light');
    for (const stop of c.colors) expect(stop.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(c.backgroundColor).toBe('#ffffff');
  });

  it('actually washes the brand colour toward the ground', () => {
    const washed = neatConfigFromSpec(SPEC, short, 'light').colors[1]?.color ?? '';
    // Raw primary (or its 1.08 shade, #c66c39-ish) means the mix silently
    // failed; a washed stop is much lighter than the brand colour.
    expect(washed).not.toBe('#b85c23');
    const mean =
      [1, 3, 5].map((i) => parseInt(washed.slice(i, i + 2), 16)).reduce((s, n) => s + n, 0) / 3;
    expect(mean).toBeGreaterThan(150);
  });

  it('is deterministic — same seed, same config', () => {
    expect(neatConfigFromSpec(SPEC, long, 'dark')).toEqual(neatConfigFromSpec(SPEC, long, 'dark'));
  });
});
