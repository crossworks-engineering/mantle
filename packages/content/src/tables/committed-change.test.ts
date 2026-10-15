/**
 * A table commit's re-index (A10 #7 fix round 2, M3): a cell-only commit
 * keeps the summary only when the table has one, by the extractor's own test
 * (hasSummary). An empty summary is none: the commit runs the whole pass, as
 * it did on main, instead of leaving the table with no vector.
 */
import { describe, expect, it } from 'vitest';
import { committedChange } from './draft';

describe('committedChange', () => {
  it('a cell-only commit on a summarised table is cells (an embed, no model call)', () => {
    expect(committedChange('h1', 'h1', { summary: 'Readings by month.' })).toBe('cells');
  });

  it.each([
    ['an empty summary', { summary: '' }],
    ['a blank summary', { summary: '  \n' }],
    ['no summary', {}],
    ['no data', null],
  ])('a cell-only commit on a table with %s is schema (the whole pass, as main)', (_l, data) => {
    expect(committedChange('h1', 'h1', data)).toBe('schema');
  });

  it('a shape change or a first commit is schema', () => {
    expect(committedChange('h1', 'h2', { summary: 's' })).toBe('schema');
    expect(committedChange(null, 'h1', { summary: 's' })).toBe('schema');
  });
});
