import { describe, expect, it } from 'vitest';
import { chunkDocText } from './chunk';

describe('chunkDocText', () => {
  it('returns nothing for empty input', () => {
    expect(chunkDocText('')).toEqual([]);
    expect(chunkDocText('   \n  ')).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    const out = chunkDocText('Hello world.\nA short note.');
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('Hello world.\nA short note.');
    expect(out[0]!.headingPath).toBeNull();
  });

  it('carries the most recent heading as section context', () => {
    const out = chunkDocText('# Intro\nFirst line.\n## Details\nSecond line.', { maxChars: 200 });
    expect(out[0]!.headingPath).toBe('Intro');
  });

  it('splits long text into multiple bounded chunks', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line number ${i} with some text`);
    const out = chunkDocText(lines.join('\n'), { maxChars: 60 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(60 + 30);
  });

  it('hard-splits a single overlong line', () => {
    const out = chunkDocText('x'.repeat(500), { maxChars: 200 });
    expect(out.length).toBe(3);
    // Chunks may exceed maxChars by up to the overlap (min(150, maxChars/2)=100)
    // plus the joining newline.
    expect(out.every((c) => c.text.length <= 200 + 100 + 1)).toBe(true);
  });

  it('overlaps consecutive chunks so boundary text is duplicated', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i} word word word`).join('\n');
    const noOverlap = chunkDocText(text, { maxChars: 100, overlapChars: 0 });
    const withOverlap = chunkDocText(text, { maxChars: 100, overlapChars: 40 });
    expect(withOverlap.length).toBe(noOverlap.length); // same chunk count
    const sum = (cs: { text: string }[]) => cs.reduce((n, c) => n + c.text.length, 0);
    expect(sum(withOverlap)).toBeGreaterThan(sum(noOverlap)); // overlap re-includes the boundary
  });
});
