import { describe, expect, it } from 'vitest';
import { FRESH_APPEARANCE } from '@mantle/client-types/fresh-appearance';
import { resolveAppearanceAttrs, type BrainAppearance } from './appearance';
import { AVATAR_PICKER_STYLES, DEFAULT_AVATAR_STYLE, resolveAvatarStyle } from './avatar';
import {
  BASE_COLOR_THEME,
  COLOR_THEMES,
  DEFAULT_COLOR_THEME,
  FRESH_COLOR_THEME,
} from './lib/themes';
import { decodeNeatSpec, encodeNeatSpec } from './neat-background';

/**
 * The client fallbacks for the fresh-install look agree with the brain's
 * (FRESH_APPEARANCE): what renders when the brain sent nothing, or sent an
 * unset value, is the Jackdaw theme and Lorelei avatars.
 */
const UNSET: BrainAppearance = {
  colorTheme: null,
  fontLogo: null,
  fontTitle: null,
  fontUi: null,
  fontProse: null,
  fontSize: null,
  fontLogoSize: null,
  fontTitleSize: null,
  fontProseSize: null,
  avatarStyle: null,
  avatarTint: null,
  backgrounds: null,
};

describe('the fresh-install look exists', () => {
  it('names a registered theme and a picker avatar style', () => {
    expect(COLOR_THEMES.map((t) => t.id)).toContain(FRESH_APPEARANCE.colorTheme);
    expect(AVATAR_PICKER_STYLES.map((s) => s.id)).toContain(FRESH_APPEARANCE.avatarStyle);
  });

  it('carries a Neat spec in canonical form', () => {
    const spec = decodeNeatSpec(FRESH_APPEARANCE.neatBackground);
    expect(spec).not.toBeNull();
    expect(encodeNeatSpec(spec!)).toBe(FRESH_APPEARANCE.neatBackground);
  });
});

describe('client fallbacks', () => {
  it('default to the fresh look; the baseline name stays the CSS baseline', () => {
    expect(FRESH_COLOR_THEME).toBe('jackdaw');
    expect(DEFAULT_AVATAR_STYLE).toBe('lorelei');
    expect(resolveAvatarStyle(null)).toBe('lorelei');
    expect(resolveAvatarStyle('no-such-style')).toBe('lorelei');
    // The deprecated alias must keep its value: clients still on it use it
    // to decide when to DROP the attribute.
    expect(BASE_COLOR_THEME).toBe('clean-slate');
    expect(DEFAULT_COLOR_THEME).toBe(BASE_COLOR_THEME);
  });
});

describe('resolveAppearanceAttrs and the colour theme', () => {
  it('stamps the fresh theme when the brain sent nothing at all', () => {
    expect(resolveAppearanceAttrs(null)).toEqual({ colorTheme: 'jackdaw', fontVars: {} });
    expect(resolveAppearanceAttrs(undefined).colorTheme).toBe('jackdaw');
  });

  it('stamps the fresh theme for an unset theme', () => {
    expect(resolveAppearanceAttrs(UNSET).colorTheme).toBe('jackdaw');
    expect(resolveAppearanceAttrs({ ...UNSET, colorTheme: '' }).colorTheme).toBe('jackdaw');
  });

  it('keeps painting the baseline for a stored theme that no longer exists', () => {
    // A retired id always rendered clean-slate; an existing brain keeps that.
    expect(resolveAppearanceAttrs({ ...UNSET, colorTheme: 'retired-theme' }).colorTheme).toBe(
      undefined,
    );
  });

  it('keeps a chosen theme, and omits only the CSS baseline', () => {
    expect(resolveAppearanceAttrs({ ...UNSET, colorTheme: 'darkmatter' }).colorTheme).toBe(
      'darkmatter',
    );
    // Someone who chose clean-slate keeps it: no attribute paints it.
    expect(resolveAppearanceAttrs({ ...UNSET, colorTheme: 'clean-slate' }).colorTheme).toBe(
      undefined,
    );
  });
});

describe('resolveAppearanceAttrs and the avatar style', () => {
  it('omits the attribute for the default, so the provider falls back to it', () => {
    expect(resolveAppearanceAttrs(UNSET).avatarStyle).toBeUndefined();
    expect(resolveAppearanceAttrs({ ...UNSET, avatarStyle: 'lorelei' }).avatarStyle).toBe(
      undefined,
    );
  });

  it('stamps a chosen style, the old default included', () => {
    expect(resolveAppearanceAttrs({ ...UNSET, avatarStyle: 'thumbs' }).avatarStyle).toBe('thumbs');
  });
});
