/**
 * The PDF drawing scorer (pdf-drawing-score.ts). Every tag and service here
 * is made up: the repo is public.
 */

import { describe, expect, it } from 'vitest';
import { canonicalCell, canonicalTag, score } from './pdf-drawing-score';

const truth = [
  { tag: 'ZZ9-V-1', service: 'Feed drum', conditions: { designP: '10.5', designT: 120 } },
  { tag: 'ZZ9-E-2', service: 'Cooler', conditions: { designP: '7' } },
  { tag: 'ZZ9-P-3A', service: 'Feed pump' },
  { tag: 'ZZ9-T-4' },
];

describe('canonical forms', () => {
  it('a tag: case, spaces, dashes and leading zeros', () => {
    expect(canonicalTag(' zz9 – e-02 ')).toBe('ZZ9-E-2');
    expect(canonicalTag('ZZ9-E-02', false)).toBe('ZZ9-E-02');
    expect(canonicalTag('ZZ9-E-0')).toBe('ZZ9-E-0');
  });

  it('a cell: decimal comma, number form, spaces around a slash', () => {
    expect(canonicalCell('10,50')).toBe('10.5');
    expect(canonicalCell(' 3.5 / FV ')).toBe('3.5/FV');
    expect(canonicalCell(null)).toBe('');
  });
});

describe('score', () => {
  it('recall, precision, service, cells and foreign units', () => {
    const r = score({
      truth,
      candidates: [
        {
          tag: 'zz9-v-1',
          page: 1,
          service: ' FEED  DRUM ',
          conditions: { designP: '10,5', designT: '120' },
        },
        { tag: 'ZZ9-E-02', page: 1, service: 'Cooler Cooler', conditions: { designP: '7 / 7' } },
        { tag: 'ZZ9-Q-9', page: 1 }, // a wrong tag of the right unit
        { tag: 'ISO-S-5', page: 1 }, // a standard, read as a tag
      ],
    });
    expect(r.tags).toEqual({ truth: 4, found: 4, matched: 2 });
    expect(r.recall).toEqual({ n: 2, of: 4, value: 0.5 });
    expect(r.precision).toEqual({ n: 2, of: 4, value: 0.5 });
    // Three truth rows have a service; one is exact, one merged, one missed.
    expect(r.serviceExact).toEqual({ n: 1, of: 3, value: 0.3333 });
    // Three cells: 10.5 and 120 right, 7 bled into "7 / 7".
    expect(r.conditionCells).toEqual({ n: 2, of: 3, value: 0.6667 });
    expect(r.foreignUnitTags).toBe(1);
    expect(r.accounting).toBeNull();
    expect(r).not.toHaveProperty('detail');
  });

  it('a tag found on several pages counts once, its service by majority', () => {
    const r = score({
      truth: [{ tag: 'ZZ9-V-1', service: 'Feed drum' }],
      candidates: [
        { tag: 'ZZ9-V-1', service: 'Feed drum' },
        { tag: 'ZZ9-V-1', service: 'Feed' },
        { tag: 'ZZ9-V-1', service: 'Feed drum' },
      ],
    });
    expect(r.tags.found).toBe(1);
    expect(r.serviceExact.value).toBe(1);
  });

  it('units given win over the truth units; detail lists the tags', () => {
    const r = score({
      truth,
      units: ['ZZ9', 'ZZ8'],
      candidates: [{ tag: 'ZZ8-V-1' }, { tag: 'AB-1' }],
      detail: true,
    });
    expect(r.foreignUnitTags).toBe(1);
    expect(r.options.units).toBe('given');
    expect(r.detail).toEqual({
      missed: ['ZZ9-E-2', 'ZZ9-P-3A', 'ZZ9-T-4', 'ZZ9-V-1'],
      extra: ['AB-1', 'ZZ8-V-1'],
      foreign: ['AB-1'],
    });
  });

  it('empty sets give null ratios, not a divide by zero', () => {
    const r = score({ truth: [], candidates: [] });
    expect(r.recall.value).toBeNull();
    expect(r.precision.value).toBeNull();
  });
});

describe('the per-page accounting check (plan O2)', () => {
  const candidates = [
    { tag: 'ZZ9-V-1', page: 1 },
    { tag: 'ZZ9-E-2', page: 1 },
    { tag: 'ZZ9-P-3A', page: 2 },
  ];

  it('passes when every tag-like run is accounted for', () => {
    const r = score({
      truth,
      candidates,
      pages: [
        { page: 1, tagLike: 6, candidate: 2, template: 3, rejected: { standard: 1 } },
        { page: 2, tagLike: 1, candidate: 1, template: 0, rejected: {} },
      ],
    });
    expect(r.accounting).toEqual({
      pages: 2,
      pagesOk: 2,
      sumMismatch: 0,
      rejectedNoReason: 0,
      candidateMismatch: 0,
      badCounts: 0,
      ok: true,
    });
  });

  it('fails a page whose counts do not add up, a reject with no reason, a candidate count off the list', () => {
    const r = score({
      truth,
      candidates,
      pages: [
        { page: 1, tagLike: 7, candidate: 2, template: 3, rejected: { standard: 1 } }, // one run lost
        { page: 2, tagLike: 2, candidate: 1, template: 0, rejected: { ' ': 1 } }, // no reason
        { page: 3, tagLike: 1, candidate: 1, template: 0, rejected: {} }, // no candidate on page 3
        { page: 4, tagLike: 1.5, candidate: 0, template: 0, rejected: { x: 1.5 } }, // not a count
      ],
    });
    expect(r.accounting).toMatchObject({
      pages: 4,
      pagesOk: 0,
      sumMismatch: 1,
      rejectedNoReason: 1,
      candidateMismatch: 1,
      badCounts: 1,
      ok: false,
    });
  });
});
