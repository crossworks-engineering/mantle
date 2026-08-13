import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_AREAS,
  BACKGROUND_AREA_IDS,
  BACKGROUND_OFF,
  DEFAULT_AREA_BACKGROUNDS,
  decodeBackgrounds,
  encodeBackgrounds,
  isBackgroundChoice,
  resolveAreaBackground,
  resolveBackgrounds,
} from './backgrounds';
import { AVATAR_PICKER_STYLES, AVATAR_STYLES, BACKGROUND_STYLES } from './avatar';

/**
 * The value here travels DB → HTML attribute → provider → four surfaces, so
 * these pin the two properties that chain depends on: a default is the absence
 * of a pair (or a default change never reaches anyone), and `off` survives the
 * whole round trip (or "I turned the header off" is indistinguishable from "I
 * never set the header").
 */

describe('the catalogue split', () => {
  it('puts every style in exactly one of the two galleries', () => {
    expect(AVATAR_PICKER_STYLES.length + BACKGROUND_STYLES.length).toBe(AVATAR_STYLES.length);
    const bg = new Set(BACKGROUND_STYLES.map((s) => s.id));
    for (const s of AVATAR_PICKER_STYLES) expect(bg, s.id).not.toContain(s.id);
  });

  // These encode an identity, which is an avatar's job and meaningless spread
  // across a sidebar, the reason they moved out of the old "minimalist" shelf.
  it('keeps the identity styles on the avatar side', () => {
    const ids = AVATAR_PICKER_STYLES.map((s) => s.id);
    for (const id of ['initials', 'initial-face', 'glyphs', 'icons']) expect(ids).toContain(id);
  });

  it('keeps the scene styles on the background side', () => {
    const ids = BACKGROUND_STYLES.map((s) => s.id);
    for (const id of ['constellation', 'landscape', 'planets', 'waves']) expect(ids).toContain(id);
  });
});

describe('choices', () => {
  it('accepts off and any background style', () => {
    expect(isBackgroundChoice(BACKGROUND_OFF)).toBe(true);
    for (const s of BACKGROUND_STYLES) expect(isBackgroundChoice(s.id), s.id).toBe(true);
  });

  it('rejects avatar-only styles, unknowns and empties', () => {
    for (const s of AVATAR_PICKER_STYLES) expect(isBackgroundChoice(s.id), s.id).toBe(false);
    for (const v of ['', '  ', 'nope', null, undefined]) expect(isBackgroundChoice(v)).toBe(false);
  });

  it('gives every area a default that is itself a valid choice', () => {
    for (const a of BACKGROUND_AREAS) {
      expect(isBackgroundChoice(DEFAULT_AREA_BACKGROUNDS[a.id]), a.id).toBe(true);
    }
  });

  it('falls back to the area default for anything invalid', () => {
    expect(resolveAreaBackground('menu', 'thumbs')).toBe(DEFAULT_AREA_BACKGROUNDS.menu);
    expect(resolveAreaBackground('header', 'nope')).toBe(DEFAULT_AREA_BACKGROUNDS.header);
    expect(resolveAreaBackground('chat', null)).toBe(DEFAULT_AREA_BACKGROUNDS.chat);
    expect(resolveAreaBackground('menu', 'waves')).toBe('waves');
  });

  it('fills in every area so consumers never see unset', () => {
    const all = resolveBackgrounds({ menu: 'stripes' });
    expect(Object.keys(all).sort()).toEqual([...BACKGROUND_AREA_IDS].sort());
    expect(all.menu).toBe('stripes');
  });
});

describe('the wire format', () => {
  it('omits areas sitting on their default', () => {
    expect(encodeBackgrounds(DEFAULT_AREA_BACKGROUNDS)).toBe('');
    expect(encodeBackgrounds({ menu: DEFAULT_AREA_BACKGROUNDS.menu })).toBe('');
  });

  // The point of omitting defaults: turning an area OFF is a real, stored
  // choice, so it must survive even when "off" is what most areas already are.
  it('carries a non-default off', () => {
    expect(encodeBackgrounds({ ...DEFAULT_AREA_BACKGROUNDS, menu: BACKGROUND_OFF })).toBe(
      'menu=off',
    );
    expect(decodeBackgrounds('menu=off').menu).toBe(BACKGROUND_OFF);
  });

  it('round-trips a full set', () => {
    const chosen = {
      menu: 'stripes',
      header: 'glass',
      chat: BACKGROUND_OFF,
      activity: 'landscape',
    } as const;
    expect(decodeBackgrounds(encodeBackgrounds(chosen))).toEqual(chosen);
  });

  it('emits areas in a stable order, so the stored string does not churn', () => {
    const a = encodeBackgrounds({ activity: 'waves', menu: 'glass' });
    const b = encodeBackgrounds({ menu: 'glass', activity: 'waves' });
    expect(a).toBe(b);
  });

  it('drops unknown areas and unknown styles on the way in', () => {
    const out = decodeBackgrounds('menu=waves,bogus=waves,header=thumbs,chat=nope');
    expect(out.menu).toBe('waves');
    expect(out.header).toBe(DEFAULT_AREA_BACKGROUNDS.header);
    expect(out.chat).toBe(DEFAULT_AREA_BACKGROUNDS.chat);
    expect(out).not.toHaveProperty('bogus');
  });

  it('survives garbage without throwing', () => {
    for (const raw of ['', '   ', ',,,', 'menu', 'menu=', '=waves', null, undefined]) {
      expect(() => decodeBackgrounds(raw)).not.toThrow();
      expect(decodeBackgrounds(raw).menu).toBe(DEFAULT_AREA_BACKGROUNDS.menu);
    }
  });
});
