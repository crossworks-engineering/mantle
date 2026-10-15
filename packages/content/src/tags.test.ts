import { describe, expect, it } from 'vitest';
import { dedupeTags } from './tags';

describe('dedupeTags (A10 #15: the one tag normaliser)', () => {
  it('trims, lower-cases and drops blanks and repeats, in order', () => {
    expect(dedupeTags([' Work ', 'work', '', '  ', 'Home'])).toEqual(['work', 'home']);
  });
  it('drops a tag over 40 characters and keeps one of exactly 40', () => {
    expect(dedupeTags(['a'.repeat(41), 'b'.repeat(40)])).toEqual(['b'.repeat(40)]);
  });
  it('keeps at most 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
    expect(dedupeTags(many)).toEqual(many.slice(0, 20));
  });
});
