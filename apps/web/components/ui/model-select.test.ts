import { describe, expect, it } from 'vitest';
import { formatContext, formatPriceCompact, sortModels } from './model-select-utils';
import type { ExplorerModel } from '../../lib/model-explorer';

/** Pure-helper coverage for the ModelSelect combobox — the JSX is exercised
 *  live on /settings/agents and /settings/ai-workers; here we lock the
 *  formatting + sort invariants so the visible badge text stays correct. */

const m = (over: Partial<ExplorerModel> = {}): ExplorerModel => ({
  id: 'a/b',
  raw: null,
  ...over,
});

describe('sortModels', () => {
  it('newest sort places ISO-dated rows first, others trail', () => {
    const out = sortModels(
      [
        m({ id: 'old', created: '2024-01-01T00:00:00Z' }),
        m({ id: 'undated' }),
        m({ id: 'new', created: '2026-05-01T00:00:00Z' }),
      ],
      'newest',
    );
    expect(out.map((x) => x.id)).toEqual(['new', 'old', 'undated']);
  });

  it('name sort is case-insensitive', () => {
    const out = sortModels(
      [
        m({ id: 'b', name: 'Beta' }),
        m({ id: 'a', name: 'alpha' }),
        m({ id: 'c', name: 'Charlie' }),
      ],
      'name',
    );
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('cheapest sort uses input + output sum and sinks unpriced rows', () => {
    const out = sortModels(
      [
        m({ id: 'mid', inputPricePerM: 3, outputPricePerM: 15 }),
        m({ id: 'free', inputPricePerM: 0, outputPricePerM: 0 }),
        m({ id: 'expensive', inputPricePerM: 15, outputPricePerM: 75 }),
        m({ id: 'unpriced' }),
      ],
      'cheapest',
    );
    expect(out.map((x) => x.id)).toEqual(['free', 'mid', 'expensive', 'unpriced']);
  });

  it('cheapest sort handles half-priced rows (only input known)', () => {
    const out = sortModels(
      [m({ id: 'a', inputPricePerM: 5 }), m({ id: 'b', inputPricePerM: 2 })],
      'cheapest',
    );
    expect(out.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('context sort is descending, missing context goes last', () => {
    const out = sortModels(
      [
        m({ id: 'small', contextTokens: 8_000 }),
        m({ id: 'unknown' }),
        m({ id: 'big', contextTokens: 1_000_000 }),
      ],
      'context',
    );
    expect(out.map((x) => x.id)).toEqual(['big', 'small', 'unknown']);
  });

  it('does not mutate the input array', () => {
    const input = [m({ id: 'b' }), m({ id: 'a' })];
    const before = input.map((x) => x.id);
    sortModels(input, 'name');
    expect(input.map((x) => x.id)).toEqual(before);
  });
});

describe('formatContext', () => {
  it.each([
    [1_000_000, '1M'],
    [1_050_000, '1.1M'],
    [2_000_000, '2M'],
    [200_000, '200k'],
    [16_384, '16k'],
    [4_096, '4k'],
    [500, '500'],
    [0, '0'],
  ])('formats %i as %s', (input, expected) => {
    expect(formatContext(input)).toBe(expected);
  });
});

describe('formatPriceCompact', () => {
  it('renders integer prices without trailing decimals', () => {
    expect(formatPriceCompact(m({ inputPricePerM: 3, outputPricePerM: 15 }))).toBe('$3 / $15');
  });

  it('strips trailing zeros on fractional prices', () => {
    expect(formatPriceCompact(m({ inputPricePerM: 0.2, outputPricePerM: 0.5 }))).toBe(
      '$0.2 / $0.5',
    );
  });

  it('renders zero as $0 (the free badge handles the "free" framing)', () => {
    expect(formatPriceCompact(m({ inputPricePerM: 0, outputPricePerM: 0 }))).toBe('$0 / $0');
  });

  it('marks missing sides with ? rather than dropping the row', () => {
    expect(formatPriceCompact(m({ inputPricePerM: 3 }))).toBe('$3 / ?');
    expect(formatPriceCompact(m({ outputPricePerM: 15 }))).toBe('? / $15');
  });
});
