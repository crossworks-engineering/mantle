import { describe, expect, it } from 'vitest';
import { clampTitle, heuristicTitle, sanitizeTitle, TITLE_CLAMP } from './forum-title-text';

/**
 * The pure text pipeline behind forum topic auto-titling. Invariants: never
 * empty, never longer than the clamp (+ellipsis), never a split surrogate
 * pair, and model artifacts (quotes / trailing period / newlines) stripped.
 */

describe('clampTitle', () => {
  it('returns short text unchanged', () => {
    expect(clampTitle('printer jammed')).toBe('printer jammed');
  });

  it('clips at a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(30).trim(); // 149 chars
    const out = clampTitle(long);
    expect(out.endsWith('…')).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(TITLE_CLAMP + 1);
    expect(out).not.toMatch(/ …$/);
  });

  it('hard-cuts a single unbroken run (no word boundary past the midpoint)', () => {
    const out = clampTitle('x'.repeat(200));
    expect(out).toBe(`${'x'.repeat(TITLE_CLAMP)}…`);
  });

  it('never splits a surrogate pair at the cut line', () => {
    // 79 ASCII chars, then emoji (2 UTF-16 units each) across the boundary.
    const out = clampTitle(`${'a'.repeat(79)} 😀😀😀 ${'b'.repeat(40)}`);
    // Round-trip through code points is lossless only when no lone surrogates.
    expect(Array.from(out).join('')).toBe(out);
    expect(out).not.toContain('�');
  });
});

describe('heuristicTitle', () => {
  it('uses the first line only, whitespace collapsed', () => {
    expect(heuristicTitle('First  line question\nsecond line detail')).toBe('First line question');
  });

  it('falls back to "New topic" for blank input', () => {
    expect(heuristicTitle('   \n  ')).toBe('New topic');
  });

  it('clamps long first lines', () => {
    const out = heuristicTitle(`${'word '.repeat(40)}\nmore`);
    expect(out.endsWith('…')).toBe(true);
    expect(Array.from(out).length).toBeLessThanOrEqual(TITLE_CLAMP + 1);
  });
});

describe('sanitizeTitle', () => {
  it('strips wrapping quotes and a trailing period', () => {
    expect(sanitizeTitle('"Warehouse wifi drops since AP update."')).toBe(
      'Warehouse wifi drops since AP update',
    );
    expect(sanitizeTitle('“Curly quoted title”')).toBe('Curly quoted title');
  });

  it('collapses newlines a model may emit', () => {
    expect(sanitizeTitle('Two\nline  title')).toBe('Two line title');
  });

  it('returns empty when nothing survives (caller falls back)', () => {
    expect(sanitizeTitle('"..."')).toBe('');
    expect(sanitizeTitle('   ')).toBe('');
  });

  it('clamps oversized output', () => {
    const out = sanitizeTitle('x'.repeat(300));
    expect(Array.from(out).length).toBeLessThanOrEqual(TITLE_CLAMP + 1);
  });
});
