import { describe, expect, it } from 'vitest';
import {
  asideBackground,
  asideBorderColor,
  DEFAULT_ASIDE_ANGLE,
  DEFAULT_ASIDE_COLOR,
  normalizeAsideAngle,
  normalizeAsideColor,
} from './aside-style';

describe('aside-style', () => {
  it('normalises colours to a known chart token', () => {
    expect(normalizeAsideColor('chart-4')).toBe('chart-4');
    expect(normalizeAsideColor('chart-9')).toBe(DEFAULT_ASIDE_COLOR);
    expect(normalizeAsideColor(undefined)).toBe(DEFAULT_ASIDE_COLOR);
  });

  it('wraps angles into 0–359 integers', () => {
    expect(normalizeAsideAngle(200)).toBe(200);
    expect(normalizeAsideAngle(360)).toBe(0);
    expect(normalizeAsideAngle(-45)).toBe(315);
    expect(normalizeAsideAngle('nope')).toBe(DEFAULT_ASIDE_ANGLE);
  });

  it('builds a themed two-tone gradient blending into the next chart colour', () => {
    const bg = asideBackground('chart-2', 135);
    // base + cyclically-next stop, theme vars only (no raw colours).
    expect(bg).toContain('var(--chart-2)');
    expect(bg).toContain('var(--chart-3)');
    expect(bg).toContain('linear-gradient(135deg');
    expect(bg).toContain('radial-gradient');
    // chart-5 wraps to chart-1.
    expect(asideBackground('chart-5', 0)).toContain('var(--chart-1)');
  });

  it('derives a faint themed border from the base colour', () => {
    expect(asideBorderColor('chart-3')).toContain('var(--chart-3)');
  });
});
