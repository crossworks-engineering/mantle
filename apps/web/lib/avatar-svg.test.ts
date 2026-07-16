import { describe, it, expect } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BoringAvatar from 'boring-avatars';
import { renderAvatarSvg } from './avatar-svg';

/**
 * `lib/avatar-svg.ts` is a hand-port of boring-avatars v2 so the avatar API
 * route can render SVG without React (the library's `useId()` crashes under
 * react-dom/server in a Next route — mismatched React instances). These tests
 * pin byte-equivalent rendering against the real library so the port can't drift
 * if boring-avatars is upgraded.
 *
 * We compare a render-equivalent *signature* (ordered hex colours + numeric
 * attributes) rather than the raw string, because React serializes attributes in
 * a different order and names element ids via useId — neither affects how the SVG
 * renders. Geometry (paths, transforms, coordinates) and fills must match.
 */
const PALETTE = ['#6366F1', '#4F46E5', '#4338CA', '#3730A3', '#312E81'];
const VARIANTS = ['beam', 'bauhaus', 'ring', 'pixel', 'sunset', 'marble', 'geometric', 'abstract'];
const SEEDS = [
  'meyx5q5a',
  'uqk1scjz',
  'tl8wwyea',
  '9unkittx',
  '9y95vtqy',
  '0dv8219y',
  'Clara Barton',
  'x',
];

function sig(svg: string): string {
  const cleaned = svg
    .replace(/id="[^"]*"/g, '')
    .replace(/url\(#[^)]*\)/g, 'url()')
    .replace(/_R_[^"]*/g, '');
  const colors = cleaned.match(/#[0-9A-Fa-f]{6}/g) ?? [];
  const nums = cleaned.match(/-?\d+(\.\d+)?/g) ?? [];
  return JSON.stringify({ colors, nums });
}

function libSvg(variant: string, name: string): string {
  return renderToStaticMarkup(
    createElement(BoringAvatar as unknown as ComponentType<Record<string, unknown>>, {
      name,
      variant,
      size: 96,
      colors: PALETTE,
    }),
  );
}

describe('renderAvatarSvg parity with boring-avatars v2', () => {
  for (const variant of VARIANTS) {
    for (const seed of SEEDS) {
      it(`matches the library for variant=${variant} seed=${seed}`, () => {
        const mine = renderAvatarSvg({ name: seed, variant, size: 96, colors: PALETTE });
        expect(sig(mine)).toBe(sig(libSvg(variant, seed)));
      });
    }
  }
});

describe('renderAvatarSvg output shape', () => {
  it('produces a valid svg root with the requested render size', () => {
    const out = renderAvatarSvg({ name: 'saskia', variant: 'beam', size: 128, colors: PALETTE });
    expect(out.startsWith('<svg ')).toBe(true);
    expect(out).toContain('width="128" height="128"');
    // viewBox keeps the variant's internal coordinate space (beam = 36).
    expect(out).toContain('viewBox="0 0 36 36"');
  });

  it('falls back to the marble variant for an unknown style', () => {
    const unknown = renderAvatarSvg({ name: 'x', variant: 'totally-bogus', colors: PALETTE });
    const marble = renderAvatarSvg({ name: 'x', variant: 'marble', colors: PALETTE });
    expect(sig(unknown)).toBe(sig(marble));
  });

  it('defaults size to 40px when omitted (library default)', () => {
    const out = renderAvatarSvg({ name: 'x', variant: 'ring', colors: PALETTE });
    expect(out).toContain('width="40px" height="40px"');
  });
});
