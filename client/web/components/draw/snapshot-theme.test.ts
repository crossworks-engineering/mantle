import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DRAW_EMBED_CLASS, drawSnapshotClass, snapshotPlacesImage } from './snapshot-theme';

const PLAIN = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
const WITH_IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AA=="/></svg>';

describe('snapshotPlacesImage', () => {
  it('spots a pasted raster image', () => {
    expect(snapshotPlacesImage(WITH_IMAGE)).toBe(true);
    expect(snapshotPlacesImage('<svg><image\n  href="x"/></svg>')).toBe(true);
    expect(snapshotPlacesImage('<svg><IMAGE href="x"/></svg>')).toBe(true);
  });

  it('is not fooled by a tag that merely starts with the same letters', () => {
    // An Excalidraw export is full of these; matching `<image` loosely would
    // strip the inversion from most drawings for no reason.
    expect(snapshotPlacesImage(PLAIN)).toBe(false);
    expect(snapshotPlacesImage('<svg><imagemask id="x"/></svg>')).toBe(false);
  });
});

describe('drawSnapshotClass', () => {
  it('inverts a plain snapshot under the dark theme, and only there', () => {
    const cls = drawSnapshotClass(PLAIN);
    // Gated on the dark variant: applied unconditionally it would negate every
    // drawing in light mode, which is the original bug with the sign flipped.
    expect(cls.startsWith('dark:')).toBe(true);
    // Excalidraw's own THEME_FILTER, matched exactly — a preview that inverts
    // by a different amount than the canvas is a subtler wrong answer than one
    // that doesn't invert at all.
    expect(cls).toContain('invert(93%)');
    expect(cls).toContain('hue-rotate(180deg)');
  });

  it('leaves a snapshot with pasted images alone', () => {
    // One filter over a flat <img> cannot spare the photos the way the canvas
    // does per element, so these keep the light rendition rather than showing
    // a negative.
    expect(drawSnapshotClass(WITH_IMAGE)).toBe('');
  });

  it('does nothing before the snapshot has arrived', () => {
    expect(drawSnapshotClass(null)).toBe('');
    expect(drawSnapshotClass(undefined)).toBe('');
  });
});

describe('DRAW_EMBED_CLASS', () => {
  it('waits for the data attribute, so the default stays un-inverted', () => {
    // A page embed can't know the drawing at render time. Arming the rule on
    // the attribute means an unchecked (or unreachable) embed renders exactly
    // as it does today instead of flashing through a wrong state.
    expect(DRAW_EMBED_CLASS).toContain('data-[draw-theme=invert]');
    expect(DRAW_EMBED_CLASS.startsWith('dark:')).toBe(true);
    expect(DRAW_EMBED_CLASS).toContain('invert(93%)');
  });
});

describe('the classes as Tailwind sees them', () => {
  // Asserted against the SOURCE, not the runtime values. Tailwind v4 extracts
  // candidates by scanning source text, so a class assembled at runtime from a
  // shared fragment produces a correct-looking string here and NO CSS at all in
  // the build — the filter silently does nothing. Checking the built value
  // cannot catch that; only reading the file can.
  const source = readFileSync(new URL('./snapshot-theme.ts', import.meta.url), 'utf8');

  it('appears whole in the source, not assembled from parts', () => {
    for (const cls of [DRAW_EMBED_CLASS, drawSnapshotClass(PLAIN)]) {
      expect(cls.length).toBeGreaterThan(0);
      expect(source).toContain(`'${cls}'`);
    }
  });
});
