import { describe, expect, it } from 'vitest';
import {
  derivedBucketForType,
  derivedCountsOf,
  describeDerivedCounts,
  emptyDerivedCounts,
} from './derived-counts';

/**
 * Pure halves of the derived-node reap (house style: DB wrappers are verified
 * live, the logic that shapes what they report is unit-tested). The bucket
 * mapping is load-bearing: every known type must route to its own delete
 * function downstream, and a type that silently fell into the wrong bucket
 * would re-open the workbook-file-orphan class the reap exists to close.
 */

describe('derivedBucketForType', () => {
  it('maps each spawning type to its bucket', () => {
    expect(derivedBucketForType('file')).toBe('images');
    expect(derivedBucketForType('table')).toBe('tables');
    expect(derivedBucketForType('page')).toBe('pages');
    expect(derivedBucketForType('note')).toBe('notes');
  });

  it('routes unknown types to other, never a typed bucket', () => {
    expect(derivedBucketForType('journal')).toBe('other');
    expect(derivedBucketForType('')).toBe('other');
  });
});

describe('derivedCountsOf', () => {
  it('sums GROUP BY rows into buckets and a total', () => {
    const counts = derivedCountsOf([
      { kind: 'file', n: 34 },
      { kind: 'table', n: 2 },
      { kind: 'note', n: 1 },
      { kind: 'journal', n: 3 },
    ]);
    expect(counts).toEqual({ images: 34, tables: 2, pages: 0, notes: 1, other: 3, total: 40 });
  });

  it('returns the empty shape for no rows', () => {
    expect(derivedCountsOf([])).toEqual(emptyDerivedCounts());
  });
});

describe('describeDerivedCounts', () => {
  it('joins buckets with commas and a final and', () => {
    expect(
      describeDerivedCounts({ images: 34, tables: 2, pages: 0, notes: 1, other: 0, total: 37 }),
    ).toBe('34 images, 2 tables and 1 note');
  });

  it('singular forms and a single bucket', () => {
    expect(
      describeDerivedCounts({ images: 1, tables: 0, pages: 0, notes: 0, other: 0, total: 1 }),
    ).toBe('1 image');
  });

  it('empty counts read as nothing', () => {
    expect(describeDerivedCounts(emptyDerivedCounts())).toBe('nothing');
  });
});
