import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  FRESH_APPEARANCE,
  projectNeatBackground,
  readAvatarStyle,
  readColorTheme,
  readNeatBackground,
} from './profile-projections';

/**
 * The fresh-install look: a brain that never chose wears the Jackdaw theme,
 * Lorelei avatars and the Neat background. A brain that DID choose keeps its
 * choice, and "off" for the background is a choice too.
 */
describe('FRESH_APPEARANCE', () => {
  it('is the Jackdaw theme, Lorelei avatars and a valid Neat spec', () => {
    expect(FRESH_APPEARANCE.colorTheme).toBe('jackdaw');
    expect(FRESH_APPEARANCE.avatarStyle).toBe('lorelei');
    // Survives the same projection a stored value goes through.
    expect(projectNeatBackground(FRESH_APPEARANCE.neatBackground)).toBe(
      FRESH_APPEARANCE.neatBackground,
    );
    expect(JSON.parse(FRESH_APPEARANCE.neatBackground)).toEqual({
      v: 1,
      seed: 55361,
      tone: 'auto',
      speed: 2,
    });
  });

  it('is seeded into a new profile row', () => {
    expect(DEFAULT_PREFERENCES.colorTheme).toBe(FRESH_APPEARANCE.colorTheme);
    expect(DEFAULT_PREFERENCES.avatarStyle).toBe(FRESH_APPEARANCE.avatarStyle);
    expect(DEFAULT_PREFERENCES.neatBackground).toBe(FRESH_APPEARANCE.neatBackground);
  });
});

describe('readColorTheme', () => {
  it('defaults an unset theme', () => {
    expect(readColorTheme(undefined)).toBe('jackdaw');
    expect(readColorTheme(null)).toBe('jackdaw');
    expect(readColorTheme('')).toBe('jackdaw');
    expect(readColorTheme('not a slug!')).toBe('jackdaw');
  });

  it('keeps a chosen theme, the old baseline included', () => {
    expect(readColorTheme('clean-slate')).toBe('clean-slate');
    expect(readColorTheme('darkmatter')).toBe('darkmatter');
  });
});

describe('readAvatarStyle', () => {
  it('defaults an unset style', () => {
    expect(readAvatarStyle(undefined)).toBe('lorelei');
    expect(readAvatarStyle('')).toBe('lorelei');
  });

  it('keeps a chosen style, the old default included', () => {
    expect(readAvatarStyle('thumbs')).toBe('thumbs');
    // Legacy ids survive storage; the web layer translates them on render.
    expect(readAvatarStyle('beam')).toBe('beam');
  });
});

describe('readNeatBackground', () => {
  it('switches the background on for a brain that never set it', () => {
    expect(readNeatBackground(undefined)).toBe(FRESH_APPEARANCE.neatBackground);
    expect(readNeatBackground(null)).toBe(FRESH_APPEARANCE.neatBackground);
  });

  it('keeps an explicit OFF off', () => {
    // '' is what the neat-background route stores for "off".
    expect(readNeatBackground('')).toBeUndefined();
  });

  it('keeps a chosen spec', () => {
    const mine = '{"v":1,"seed":7,"tone":"darker","speed":0}';
    expect(readNeatBackground(mine)).toBe(mine);
  });

  it('reads garbage as off, never as the default', () => {
    expect(readNeatBackground('{"v":2}')).toBeUndefined();
    expect(readNeatBackground(42)).toBeUndefined();
  });
});
