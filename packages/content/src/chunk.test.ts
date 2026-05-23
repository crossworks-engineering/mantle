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
    expect(out.every((c) => c.text.length <= 200)).toBe(true);
  });
});
