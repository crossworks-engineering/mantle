import { describe, expect, it } from 'vitest';
import { BACKDROP_STYLE_IDS, DEFAULT_BACKDROP_STYLE, fitSvg, renderBackdropSvg } from './backdrop';
import { AVATAR_STYLE_IDS } from './avatar';

/**
 * The backdrop is decorative, so the risk is not that it looks wrong — it is
 * that it THROWS and takes the app shell with it, or that it silently stops
 * filling its box. These cover both, plus the two things that make it a
 * backdrop rather than a big avatar: the fit rewrite and the upright crop.
 */

/** Clean Slate --chart-1..5, light. Hex, straight out of themes.css. */
const RAMP = ['#666ed1', '#ae467f', '#ad5700', '#4b830f', '#00889b'];

describe('fitSvg', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" width="256" height="256"><rect/></svg>';

  it('drops the fixed size so CSS can size the layer', () => {
    const out = fitSvg(svg);
    const root = out.slice(0, out.indexOf('>') + 1);
    expect(root).not.toMatch(/\swidth=/);
    expect(root).not.toMatch(/\sheight=/);
  });

  it('adds a cover-style preserveAspectRatio', () => {
    expect(fitSvg(svg)).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(fitSvg(svg, 'xMidYMax')).toContain('preserveAspectRatio="xMidYMax slice"');
  });

  it('keeps the viewBox — without it there is nothing to scale', () => {
    expect(fitSvg(svg)).toContain('viewBox="0 0 100 100"');
  });

  it('does not add a second preserveAspectRatio when one is already there', () => {
    const once = fitSvg(svg, 'xMidYMax');
    expect(fitSvg(once, 'xMidYMax').match(/preserveAspectRatio/g)).toHaveLength(1);
  });

  it('touches only the root tag, leaving the RDF licence block intact', () => {
    const withMeta =
      '<svg viewBox="0 0 100 100" width="64" height="64"><metadata><dc:creator>DiceBear</dc:creator></metadata><rect width="10" height="10"/></svg>';
    const out = fitSvg(withMeta);
    expect(out).toContain('<dc:creator>DiceBear</dc:creator>');
    // The inner rect keeps its own width/height; only the root lost them.
    expect(out).toContain('<rect width="10" height="10"/>');
  });
});

describe('renderBackdropSvg', () => {
  it('renders every style the picker would offer', async () => {
    for (const id of BACKDROP_STYLE_IDS) {
      const svg = await renderBackdropSvg({ style: id, seed: 'mantle', ramp: RAMP });
      expect(svg.startsWith('<svg'), id).toBe(true);
      expect(svg, id).toContain('slice');
    }
  });

  it('only offers styles that actually exist in the avatar registry', () => {
    for (const id of BACKDROP_STYLE_IDS) expect(AVATAR_STYLE_IDS, id).toContain(id);
    expect(BACKDROP_STYLE_IDS).toContain(DEFAULT_BACKDROP_STYLE);
  });

  it('is deterministic — same seed, same bytes', async () => {
    const a = await renderBackdropSvg({ style: 'waves', seed: 'dev-brain', ramp: RAMP });
    const b = await renderBackdropSvg({ style: 'waves', seed: 'dev-brain', ramp: RAMP });
    expect(a).toBe(b);
  });

  it('gives different seeds different backdrops', async () => {
    const a = await renderBackdropSvg({ style: 'waves', seed: 'one', ramp: RAMP });
    const b = await renderBackdropSvg({ style: 'waves', seed: 'two', ramp: RAMP });
    expect(a).not.toBe(b);
  });

  it('puts the theme ramp into the artwork', async () => {
    const svg = await renderBackdropSvg({ style: 'waves', seed: 'mantle', ramp: RAMP });
    expect(RAMP.some((c) => svg.includes(c))).toBe(true);
  });

  // The whole reason `rotationVariant` is passed. A rotated `waves` hangs the
  // sea off the ceiling, which is fine on a 32px circle and wrong on a wall.
  it('renders waves upright by default, and rotates only when asked', async () => {
    const upright = await renderBackdropSvg({ style: 'waves', seed: 'mantle', ramp: RAMP });
    expect(upright).toContain('#rotation-none-');
    expect(upright).not.toMatch(/transform="rotate\(/);

    // `free` is the style's own weighted default, so allowing rotation must at
    // least stop pinning `none`.
    const free = await renderBackdropSvg({
      style: 'waves',
      seed: 'mantle',
      ramp: RAMP,
      allowRotation: true,
    });
    expect(free).not.toContain('#rotation-none-');
  });

  // DiceBear throws on an unknown option key, so a style WITHOUT a rotation or
  // animation component must not be handed those options.
  it('does not throw on styles that declare no rotation component', async () => {
    await expect(
      renderBackdropSvg({ style: 'identicon', seed: 'mantle', ramp: RAMP }),
    ).resolves.toContain('<svg');
  });

  it('survives unknown, legacy and empty style ids', async () => {
    for (const id of ['not-a-style', 'beam', '', null, undefined]) {
      await expect(renderBackdropSvg({ style: id, seed: 'mantle' })).resolves.toContain('<svg');
    }
  });

  // A caller reading a live CSS custom property is one theme edit away from
  // handing us `oklch(...)`, which DiceBear rejects outright.
  it('ignores non-hex colours rather than throwing', async () => {
    await expect(
      renderBackdropSvg({ style: 'waves', seed: 'mantle', ramp: ['oklch(0.7 0.1 250)', 'nope'] }),
    ).resolves.toContain('<svg');
  });
});
