import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { focusGridClass, focusGridColumns } from './focus-layout';

describe('focusGridColumns', () => {
  it('keeps the dragged list width when not in focus mode', () => {
    expect(focusGridColumns(false, 300)).toBe('300px minmax(0, 1fr)');
  });

  it('gives the preview the whole row in focus mode', () => {
    // One track, not a zero-width first one: a 0px column still leaves the
    // border and the resize handle's hit area behind.
    expect(focusGridColumns(true, 300)).toBe('minmax(0, 1fr)');
    expect(focusGridColumns(true, 560)).toBe('minmax(0, 1fr)');
  });
});

describe('focusGridClass', () => {
  it('swaps the fixed list column out in focus mode', () => {
    expect(focusGridClass(false)).toBe('md:grid-cols-[360px_1fr]');
    expect(focusGridClass(true)).toBe('md:grid-cols-[minmax(0,1fr)]');
  });

  it('returns classes that appear whole in the source', () => {
    // Tailwind v4 scans source text: a class built from a variable emits no
    // rule, and the grid silently keeps its default columns. Same guard as
    // snapshot-theme.test.ts.
    const source = readFileSync(new URL('./focus-layout.ts', import.meta.url), 'utf8');
    for (const cls of [focusGridClass(true), focusGridClass(false)]) {
      expect(source).toContain(`'${cls}'`);
    }
  });
});
