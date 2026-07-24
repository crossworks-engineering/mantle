import { describe, it, expect } from 'vitest';
import { lineDiff, proseChanged } from './diff';

describe('lineDiff', () => {
  it('marks every line equal for identical text', () => {
    const d = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(d.every((l) => l.type === 'eq')).toBe(true);
    expect(d.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  it('detects an added line', () => {
    const d = lineDiff('a\nc', 'a\nb\nc');
    expect(d).toEqual([
      { type: 'eq', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'eq', text: 'c' },
    ]);
  });

  it('detects a removed line', () => {
    const d = lineDiff('a\nb\nc', 'a\nc');
    expect(d).toEqual([
      { type: 'eq', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'eq', text: 'c' },
    ]);
  });

  it('detects a changed line as del+add', () => {
    const d = lineDiff('hello world', 'hello there');
    expect(d).toContainEqual({ type: 'del', text: 'hello world' });
    expect(d).toContainEqual({ type: 'add', text: 'hello there' });
  });

  it('handles empty → content (all adds)', () => {
    const d = lineDiff('', 'x\ny');
    // '' splits to [''], so one eq-or-del of '' then adds — assert the adds land.
    expect(d.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['x', 'y']);
  });
});

describe('proseChanged', () => {
  it('ignores leading/trailing whitespace', () => {
    expect(proseChanged('  hi \n', 'hi')).toBe(false);
    expect(proseChanged('hi', 'hi there')).toBe(true);
  });
});
