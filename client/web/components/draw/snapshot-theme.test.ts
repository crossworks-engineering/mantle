import { describe, expect, it } from 'vitest';
import { drawSnapshotClass } from './snapshot-theme';

describe('drawSnapshotClass', () => {
  it('inverts a plain drawing under the dark theme, and only there', () => {
    const cls = drawSnapshotClass(false);
    // The filter must be gated on the dark variant: applied unconditionally it
    // would negate every drawing in light mode, which is the original bug with
    // the sign flipped.
    expect(cls.startsWith('dark:')).toBe(true);
    // Excalidraw's own THEME_FILTER, matched exactly — a preview that inverts
    // by a different amount than the canvas is a subtler wrong answer than one
    // that doesn't invert at all.
    expect(cls).toContain('invert(93%)');
    expect(cls).toContain('hue-rotate(180deg)');
  });

  it('leaves a drawing with pasted images alone', () => {
    // One filter over a flat <img> cannot spare the photos the way the canvas
    // does per element, so these keep the light rendition rather than showing
    // a negative. Snapshots are rendered as images by design (docs/draw.md §4),
    // so there is no inline-markup escape hatch here.
    expect(drawSnapshotClass(true)).toBe('');
  });

  it('is a literal class string — Tailwind v4 cannot see a built one', () => {
    for (const cls of [drawSnapshotClass(true), drawSnapshotClass(false)]) {
      expect(cls).not.toContain('${');
    }
  });
});
