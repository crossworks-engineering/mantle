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
    expect(canonicalCell('10,5')).toBe('10.5');
    expect(canonicalCell(' 3.5 / FV ')).toBe('3.5/FV');
    expect(canonicalCell(null)).toBe('');
  });

  it('a cell: a thousands comma is never a decimal point', () => {
    expect(canonicalCell('1,250')).toBe('1,250');
    expect(canonicalCell('1,250,000')).toBe('1,250,000');
    expect(canonicalCell('1,2,5')).toBe('1,2,5');
    expect(canonicalCell('1,250')).not.toBe(canonicalCell('1.25'));
  });

  it('a cell: a decimal comma in a value with a unit is a decimal point', () => {
    expect(canonicalCell('10,5 barg')).toBe(canonicalCell('10.5 BARG'));
    expect(canonicalCell('-10,25 °C')).toBe(canonicalCell('-10.25 °C'));
    // A comma with 3 digits after it is still not a decimal point.
    expect(canonicalCell('1,250 kg')).toBe('1,250 KG');
    expect(canonicalCell('1,250 kg')).not.toBe(canonicalCell('1.25 kg'));
    // Two commas: none is a decimal point.
    expect(canonicalCell('10,5 / 20,5 barg')).toBe('10,5/20,5 BARG');
    // In the score: the candidate cell is right.
    const r = score({
      truth: [{ tag: 'XQ-P-1', conditions: { designP: '10.5 BARG' } }],
      candidates: [{ tag: 'XQ-P-1', conditions: { designP: '10,5 barg' } }],
    });
    expect(r.conditionCells).toEqual({ n: 1, of: 1, value: 1 });
  });

  it('a cell: a number past 15 significant digits stays text', () => {
    // Number() gives the same double for these two; they must not compare equal.
    expect(Number('1234567890123456789')).toBe(Number('1234567890123456788'));
    expect(canonicalCell('1234567890123456789')).not.toBe(canonicalCell('1234567890123456788'));
    expect(canonicalCell('0.12345678901234567')).toBe('0.12345678901234567');
    // 15 digits, and leading or trailing zeros, are still numbers.
    expect(canonicalCell('123456789012345')).toBe('123456789012345');
    expect(canonicalCell('000123.4500')).toBe('123.45');
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

  it('a tag found on several pages counts once; one wrong row makes the field wrong', () => {
    const rows = [
      { tag: 'ZZ9-V-1', service: 'Feed drum', conditions: { designP: '7' } },
      { tag: 'ZZ9-V-1', service: 'Feed', conditions: { designP: '7' } },
      { tag: 'ZZ9-V-1', service: 'Feed drum', conditions: { designP: '' } },
    ];
    const truthRow = [{ tag: 'ZZ9-V-1', service: 'Feed drum', conditions: { designP: '7,0' } }];
    const r = score({ truth: truthRow, candidates: rows, detail: true });
    expect(r.tags.found).toBe(1);
    // Two rows of three say "Feed drum": the old majority rule called that
    // exact and hid the wrong row.
    expect(r.serviceExact).toEqual({ n: 0, of: 1, value: 0 });
    // A row that gives no value does not count against the field.
    expect(r.conditionCells).toEqual({ n: 1, of: 1, value: 1 });
    expect(r.conflicts).toBe(1);
    expect(r.detail?.conflicts).toEqual(['ZZ9-V-1']);
    // The same rows in any order give the same result.
    for (const order of [
      [2, 1, 0],
      [1, 0, 2],
      [0, 2, 1],
    ]) {
      expect(
        score({ truth: truthRow, candidates: order.map((i) => rows[i]!), detail: true }),
      ).toEqual(r);
    }
  });

  it('rows that agree are exact and no conflict', () => {
    const r = score({
      truth: [{ tag: 'ZZ9-V-1', service: 'Feed drum' }],
      candidates: [
        { tag: 'ZZ9-V-1', service: 'Feed drum' },
        { tag: 'zz9-v-01', service: ' feed  DRUM' },
        { tag: 'ZZ9-V-1' },
      ],
    });
    expect(r.serviceExact.value).toBe(1);
    expect(r.conflicts).toBe(0);
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
      truthCollisions: [],
      conflicts: [],
    });
  });

  it('given unit codes take the canonical form of the tags', () => {
    // The unit "09" and the tag "09-V-1" both lose the leading zero.
    const r = score({
      truth: [{ tag: '09-V-1' }],
      units: [' 09 '],
      candidates: [{ tag: '09-V-1' }, { tag: '9-e-2' }],
    });
    expect(r.foreignUnitTags).toBe(0);
    expect(r.recall.value).toBe(1);
  });

  it('a tag with no dash that matches the truth is not a foreign unit', () => {
    const r = score({
      truth: [{ tag: 'ZZ9-V-1' }, { tag: 'K101' }],
      candidates: [{ tag: 'K101' }, { tag: 'Q202' }],
      detail: true,
    });
    expect(r.foreignUnitTags).toBe(1);
    expect(r.detail?.foreign).toEqual(['Q202']);
  });

  it('counts truth rows that fall on one tag, and scores them in any order', () => {
    const rows = [
      { tag: 'ZZ9-E-2', service: 'Cooler', conditions: { designP: '7' } },
      { tag: 'ZZ9-E-02', service: 'Cooler', conditions: { designP: '9' } },
      { tag: 'ZZ9-V-1', service: 'Drum' },
    ];
    const candidates = [{ tag: 'ZZ9-E-2', service: 'Cooler', conditions: { designP: '7' } }];
    const r = score({ truth: rows, candidates, detail: true });
    expect(r.truthCollisions).toBe(1);
    expect(r.detail?.truthCollisions).toEqual(['ZZ9-E-2']);
    expect(r.tags.truth).toBe(2);
    // The service agrees across the two rows: scored. The cell does not:
    // it counts and is never right, whichever row came first.
    expect(r.serviceExact).toEqual({ n: 1, of: 2, value: 0.5 });
    expect(r.conditionCells).toEqual({ n: 0, of: 1, value: 0 });
    expect(score({ truth: [rows[1]!, rows[0]!, rows[2]!], candidates, detail: true })).toEqual(r);
  });

  it('counts tags that are empty after the canonical form', () => {
    const r = score({
      truth: [{ tag: 'ZZ9-V-1' }, { tag: '  ' }],
      candidates: [{ tag: '' }, { tag: ' \t' }, { tag: 'ZZ9-V-1' }],
    });
    expect(r.emptyTags).toEqual({ truth: 1, candidates: 2 });
    expect(r.tags).toEqual({ truth: 1, found: 1, matched: 1 });
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
      unaccounted: 0,
      ok: true,
    });
  });

  it('fails a candidate with no page, or on a page not listed', () => {
    const r = score({
      truth,
      candidates: [...candidates, { tag: 'ZZ9-T-4' }, { tag: 'ZZ9-T-4', page: 9 }],
      pages: [
        { page: 1, tagLike: 2, candidate: 2, template: 0, rejected: {} },
        { page: 2, tagLike: 1, candidate: 1, template: 0, rejected: {} },
      ],
    });
    expect(r.accounting).toMatchObject({ pagesOk: 2, unaccounted: 2, ok: false });
  });

  it('a page listed twice is a bad page', () => {
    const r = score({
      truth,
      candidates: [{ tag: 'ZZ9-V-1', page: 1 }],
      pages: [
        { page: 1, tagLike: 1, candidate: 1, template: 0, rejected: {} },
        { page: 1, tagLike: 1, candidate: 1, template: 0, rejected: {} },
      ],
    });
    expect(r.accounting).toMatchObject({ pages: 2, pagesOk: 0, badCounts: 2, ok: false });
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
