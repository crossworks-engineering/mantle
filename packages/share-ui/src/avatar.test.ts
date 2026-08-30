import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AVATAR_CATEGORIES,
  AVATAR_STYLES,
  DEFAULT_AVATAR_STYLE,
  DEFAULT_AVATAR_TINT,
  resolveAvatarTint,
  avatarStyleMeta,
  loadAvatarStyle,
  renderAvatarSvg,
  requiresAttribution,
  resolveAvatarStyle,
} from './avatar';

/**
 * The avatar generator runs in a client component AND in a route handler, so
 * these assert the properties both tiers depend on: it never throws on stored
 * input, the theme ramp actually reaches the SVG, and the same seed is the
 * same bytes (the mobile companion caches on that).
 */

/** Clean Slate --chart-1..5, light. Hex, straight out of themes.css. */
const RAMP = ['#666ed1', '#ae467f', '#ad5700', '#4b830f', '#00889b'];

const styleJson = (id: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../node_modules/@dicebear/styles/dist/${id}.min.json`, import.meta.url),
      ),
      'utf8',
    ),
  ) as { meta: { source: { name: string }; creator: { name: string }; license: { name: string } } };

describe('the style registry', () => {
  it('renders every shipped style', async () => {
    for (const s of AVATAR_STYLES) {
      const svg = await renderAvatarSvg({ style: s.id, seed: 'Saskia', size: 48 });
      expect(svg.startsWith('<svg'), s.id).toBe(true);
    }
  });

  it('has unique ids, a known category each, and a default that exists', () => {
    const ids = AVATAR_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_AVATAR_STYLE);
    const known = new Set(AVATAR_CATEGORIES.map((c) => c.id));
    for (const s of AVATAR_STYLES) expect(known, s.id).toContain(s.category);
  });

  // Labels are OURS, not DiceBear's. Its `meta.source.name` is unusable as a
  // picker label: `bottts` and `bottts-neutral` are both "Bottts", `big-ears`
  // is "Face Generator", and `croodles` is "Croodles - Doodle your face". Ten
  // styles would have been indistinguishable in the list.
  it('gives every style a distinct, non-empty label', () => {
    const labels = AVATAR_STYLES.map((s) => s.label);
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size, 'duplicate labels').toBe(labels.length);
  });

  // The repo is public and 14 of these styles are CC BY 4.0, which REQUIRES
  // attribution. If a DiceBear bump relicensed a style or renamed its designer,
  // our credit would quietly become wrong — so the table is checked against the
  // bytes actually installed rather than trusted.
  it('states each style’s real creator and licence', () => {
    for (const s of AVATAR_STYLES) {
      const meta = styleJson(s.id).meta;
      expect(s.creator, `${s.id} creator`).toBe(meta.creator.name);
      // The package writes a couple of licences with a trailing full stop.
      expect(s.license, `${s.id} licence`).toBe(meta.license.name.replace(/\.$/, ''));
    }
  });

  it('flags exactly the styles that oblige us to credit someone', () => {
    for (const s of AVATAR_STYLES) {
      const free = s.license === 'CC0 1.0' || s.license === 'MIT';
      expect(requiresAttribution(s), `${s.id} (${s.license})`).toBe(!free);
    }
  });
});

describe('resolveAvatarStyle', () => {
  it('passes current ids through', () => {
    expect(resolveAvatarStyle('rings')).toBe('rings');
  });

  // Stored avatars still carry boring-avatars ids; they must keep rendering
  // something sensible without a data migration.
  it.each([
    ['beam', 'thumbs'],
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

  it('always yields metadata, even for junk', () => {
    expect(avatarStyleMeta('nope').id).toBe(DEFAULT_AVATAR_STYLE);
  });
});

describe('lazy loading', () => {
  // The sync path exists for React, which cannot await mid-render. It must
  // report "not yet" rather than throw or render a broken avatar.
  //
  // The style cache is module-level and every test above populates it, so a
  // cold style has to come from a FRESH module instance — otherwise this
  // silently tests the warm path and would still pass if laziness broke.
  it('renders nothing synchronously until the style is loaded', async () => {
    vi.resetModules();
    const cold = await import('./avatar');
    expect(cold.isAvatarStyleReady('constellation')).toBe(false);
    expect(cold.renderAvatarSvgSync({ style: 'constellation', seed: 'x' })).toBeNull();
    await cold.loadAvatarStyle('constellation');
    expect(cold.isAvatarStyleReady('constellation')).toBe(true);
    expect(cold.renderAvatarSvgSync({ style: 'constellation', seed: 'x' })).toContain('<svg');
  });

  it('shares one load between concurrent callers', async () => {
    const [a, b] = await Promise.all([loadAvatarStyle('planets'), loadAvatarStyle('planets')]);
    expect(a).toBe(b);
  });
});

describe('theming', () => {
  it('puts the theme ramp in the SVG', async () => {
    const svg = await renderAvatarSvg({ style: 'shapes', seed: 'Saskia', ramp: RAMP });
    expect(RAMP.some((c) => svg.includes(c))).toBe(true);
  });

  // backgroundColor is a CORE option, so it lands even on styles that declare
  // no `background` colour group — the minimalist ones that expose only a
  // shape colour, and the character styles, which expose none at all. Without
  // that, "theme the background" would be a silent no-op for most of the set.
  it.each(['rings', 'identicon', 'notionists', 'bottts', 'lorelei'])(
    'themes %s, which declares no background group',
    async (style) => {
      const svg = await renderAvatarSvg({ style, seed: 'Saskia', ramp: RAMP });
      expect(RAMP.some((c) => svg.includes(c))).toBe(true);
    },
  );

  // DiceBear validates colours as hex and throws on anything else. An avatar
  // must never be the thing that takes a page down.
  it('drops non-hex colours instead of throwing', async () => {
    await expect(
      renderAvatarSvg({ style: 'rings', seed: 'x', ramp: ['oklch(0.5 0.1 200)'] }),
    ).resolves.toContain('<svg');
  });
});

describe('tint', () => {
  it('defaults to mixed and rejects junk', () => {
    expect(DEFAULT_AVATAR_TINT).toBe('mixed');
    for (const v of ['nope', '', null, undefined]) expect(resolveAvatarTint(v)).toBe('mixed');
    for (const v of ['native', 'mixed', 'theme']) expect(resolveAvatarTint(v)).toBe(v);
  });

  it('native leaves the ramp out entirely', async () => {
    const svg = await renderAvatarSvg({
      style: 'shapes',
      seed: 'Saskia',
      ramp: RAMP,
      tint: 'native',
    });
    expect(RAMP.some((c) => svg.includes(c))).toBe(false);
  });

  // `theme` repaints the style's own colour groups too, so a style with several
  // of them lands MORE ramp colours in the SVG than `mixed` does.
  it('theme paints more of the artwork than mixed', async () => {
    const count = (svg: string) => RAMP.filter((c) => svg.includes(c)).length;
    const mixed = await renderAvatarSvg({
      style: 'shapes',
      seed: 'Saskia',
      ramp: RAMP,
      tint: 'mixed',
    });
    const themed = await renderAvatarSvg({
      style: 'shapes',
      seed: 'Saskia',
      ramp: RAMP,
      tint: 'theme',
    });
    expect(count(themed)).toBeGreaterThan(count(mixed));
  });

  // The guard that stops `theme` producing an invisible avatar: groups declared
  // `contrastTo` another group are the legible part drawn ON it (initials text,
  // the icons glyph, thumbs' eyes and mouth) and DiceBear solves them to black
  // or white. Painting them from the same ramp as the surface behind them is a
  // coin-flip on whether the avatar still has a face.
  it('never repaints a contrastTo group, even on theme', async () => {
    for (const style of ['initials', 'icons', 'thumbs']) {
      const svg = await renderAvatarSvg({ style, seed: 'Saskia', ramp: RAMP, tint: 'theme' });
      const solved = /#000000|#ffffff/i.test(svg);
      expect(solved, `${style} lost its contrast-solved colour`).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('same seed → same bytes', async () => {
    const a = await renderAvatarSvg({ style: 'loops', seed: 'Remy', size: 40, ramp: RAMP });
    const b = await renderAvatarSvg({ style: 'loops', seed: 'Remy', size: 40, ramp: RAMP });
    expect(a).toBe(b);
  });

  it('different seeds → different avatars', async () => {
    const a = await renderAvatarSvg({ style: 'loops', seed: 'Remy' });
    const b = await renderAvatarSvg({ style: 'loops', seed: 'Saskia' });
    expect(a).not.toBe(b);
  });

  it('honours size', async () => {
    expect(await renderAvatarSvg({ style: 'shapes', seed: 'x', size: 96 })).toContain('width="96"');
  });
});

describe('parts (avatar builder choices)', () => {
  it('exposes each style’s components, variants, and optional set', async () => {
    const loaded = await loadAvatarStyle('adventurer');
    expect(Object.keys(loaded.variants).length).toBeGreaterThan(0);
    for (const names of Object.values(loaded.variants)) {
      expect(names.length).toBeGreaterThan(0);
    }
    // Every optional component is a real component.
    for (const c of loaded.optional) expect(loaded.variants[c]).toBeDefined();
  });

  it('a pinned variant is deterministic and actually changes the avatar', async () => {
    const loaded = await loadAvatarStyle('adventurer');
    const [component, names] =
      Object.entries(loaded.variants).find(([, v]) => v.length >= 2) ?? [];
    if (!component || !names) throw new Error('adventurer lost its multi-variant components');
    const base = { style: 'adventurer', seed: 'Remy', size: 40 };
    const a1 = await renderAvatarSvg({ ...base, parts: { [component]: names[0]! } });
    const a2 = await renderAvatarSvg({ ...base, parts: { [component]: names[0]! } });
    const b = await renderAvatarSvg({ ...base, parts: { [component]: names[1]! } });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it('drops unknown components and variants instead of throwing', async () => {
    const loaded = await loadAvatarStyle('adventurer');
    const component = Object.keys(loaded.variants)[0]!;
    const plain = await renderAvatarSvg({ style: 'adventurer', seed: 'Remy' });
    const junk = await renderAvatarSvg({
      style: 'adventurer',
      seed: 'Remy',
      parts: { noSuchComponent: 'x', [component]: 'noSuchVariant' },
    });
    expect(junk).toBe(plain);
  });

  it('null hides an optional component; a pin force-shows it', async () => {
    const loaded = await loadAvatarStyle('adventurer');
    const component = loaded.optional[0];
    if (!component) throw new Error('adventurer lost its optional components');
    const variant = loaded.variants[component]![0]!;
    const base = { style: 'adventurer', seed: 'Remy', size: 40 };
    const shown = await renderAvatarSvg({ ...base, parts: { [component]: variant } });
    const hidden = await renderAvatarSvg({ ...base, parts: { [component]: null } });
    expect(shown).not.toBe(hidden);
  });

  it('stays deterministic with a themed ramp on top', async () => {
    const loaded = await loadAvatarStyle('adventurer');
    const component = Object.keys(loaded.variants)[0]!;
    const variant = loaded.variants[component]![0]!;
    const opts = {
      style: 'adventurer',
      seed: 'Remy',
      ramp: RAMP,
      tint: 'theme' as const,
      parts: { [component]: variant },
    };
    expect(await renderAvatarSvg(opts)).toBe(await renderAvatarSvg(opts));
  });
});
