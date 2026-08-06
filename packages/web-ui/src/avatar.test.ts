import { describe, expect, it } from 'vitest';
import { AVATAR_STYLES, DEFAULT_AVATAR_STYLE, renderAvatarSvg, resolveAvatarStyle } from './avatar';

/**
 * The avatar generator runs in a client component AND in a route handler, so
 * these assert the properties both tiers depend on: it never throws on stored
 * input, the theme ramp actually reaches the SVG, and the same seed is the
 * same bytes (the mobile companion caches on that).
 */

/** Clean Slate --chart-1..5, light. Hex, straight out of themes.css. */
const RAMP = ['#666ed1', '#ae467f', '#ad5700', '#4b830f', '#00889b'];

describe('avatar styles', () => {
  it('every shipped style renders', () => {
    for (const s of AVATAR_STYLES) {
      const svg = renderAvatarSvg({ style: s.id, seed: 'Saskia', size: 48 });
      expect(svg.startsWith('<svg'), s.id).toBe(true);
    }
  });

  it('style ids are unique and the default is one of them', () => {
    const ids = AVATAR_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_AVATAR_STYLE);
  });
});

describe('resolveAvatarStyle', () => {
  it('passes current ids through', () => {
    expect(resolveAvatarStyle('rings')).toBe('rings');
  });

  // Stored avatars still carry boring-avatars ids; they must keep rendering
  // something sensible without a data migration.
  it.each([
    ['beam', 'shapes'],
    ['bauhaus', 'shapes'],
    ['marble', 'glass'],
    ['sunset', 'glass'],
    ['pixel', 'identicon'],
    ['ring', 'rings'],
  ])('maps legacy %s → %s', (legacy, expected) => {
    expect(resolveAvatarStyle(legacy)).toBe(expected);
  });

  it('falls back for unknown, empty and nullish ids', () => {
    for (const v of ['nope', '', null, undefined]) {
      expect(resolveAvatarStyle(v)).toBe(DEFAULT_AVATAR_STYLE);
    }
  });
});

describe('theming', () => {
  it('puts the theme ramp in the SVG', () => {
    const svg = renderAvatarSvg({ style: 'shapes', seed: 'Saskia', background: RAMP });
    expect(RAMP.some((c) => svg.includes(c))).toBe(true);
  });

  // backgroundColor is a CORE option, so it lands even on styles that declare
  // no `background` colour group. Without that, "theme the background" would
  // be a silent no-op for these two.
  it.each(['rings', 'identicon'])('themes %s, which declares no background group', (style) => {
    const svg = renderAvatarSvg({ style, seed: 'Saskia', background: RAMP });
    expect(RAMP.some((c) => svg.includes(c))).toBe(true);
  });

  // DiceBear validates colours as hex and throws on anything else. An avatar
  // must never be the thing that takes a page down.
  it('drops non-hex colours instead of throwing', () => {
    expect(() =>
      renderAvatarSvg({ style: 'rings', seed: 'x', background: ['oklch(0.5 0.1 200)'] }),
    ).not.toThrow();
  });

  it('renders untinted when no ramp is given', () => {
    expect(renderAvatarSvg({ style: 'shapes', seed: 'x' }).startsWith('<svg')).toBe(true);
  });
});

describe('determinism', () => {
  it('same seed → same bytes', () => {
    const a = renderAvatarSvg({ style: 'loops', seed: 'Remy', size: 40, background: RAMP });
    const b = renderAvatarSvg({ style: 'loops', seed: 'Remy', size: 40, background: RAMP });
    expect(a).toBe(b);
  });

  it('different seeds → different avatars', () => {
    const a = renderAvatarSvg({ style: 'loops', seed: 'Remy' });
    const b = renderAvatarSvg({ style: 'loops', seed: 'Saskia' });
    expect(a).not.toBe(b);
  });

  it('honours size', () => {
    expect(renderAvatarSvg({ style: 'shapes', seed: 'x', size: 96 })).toContain('width="96"');
  });
});
