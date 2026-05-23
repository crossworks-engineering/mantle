import { describe, expect, it } from 'vitest';
import { mergeAndSortTurns, parseWindowBound, type RecallTurn } from './builtins-recall';

describe('parseWindowBound', () => {
  it('widens a bare date to the start of the UTC day', () => {
    const d = parseWindowBound('2026-05-20', 'start');
    expect(d?.toISOString()).toBe('2026-05-20T00:00:00.000Z');
  });

  it('widens a bare date to the end of the UTC day', () => {
    const d = parseWindowBound('2026-05-20', 'end');
    expect(d?.toISOString()).toBe('2026-05-20T23:59:59.999Z');
  });

  it('takes a full ISO datetime as-is regardless of edge', () => {
    const iso = '2026-05-20T14:30:00.000Z';
    expect(parseWindowBound(iso, 'start')?.toISOString()).toBe(iso);
    expect(parseWindowBound(iso, 'end')?.toISOString()).toBe(iso);
  });

  it('trims surrounding whitespace', () => {
    expect(parseWindowBound('  2026-05-20  ', 'start')?.toISOString()).toBe(
      '2026-05-20T00:00:00.000Z',
    );
  });

  it('returns null for empty or unparseable input', () => {
    expect(parseWindowBound('', 'start')).toBeNull();
    expect(parseWindowBound('   ', 'start')).toBeNull();
    expect(parseWindowBound('not a date', 'start')).toBeNull();
    expect(parseWindowBound('2026-13-99', 'start')).toBeNull();
  });
});

describe('mergeAndSortTurns', () => {
  const turn = (at: string, surface: RecallTurn['surface']): RecallTurn => ({
    surface,
    direction: 'inbound',
    speaker: 'user',
    at,
    text: `${surface}@${at}`,
  });

  it('interleaves turns from both surfaces in chronological order', () => {
    const merged = mergeAndSortTurns([
      turn('2026-05-20T10:00:00.000Z', 'telegram'),
      turn('2026-05-20T09:00:00.000Z', 'web'),
      turn('2026-05-20T09:30:00.000Z', 'telegram'),
    ]);
    expect(merged.map((t) => t.text)).toEqual([
      'web@2026-05-20T09:00:00.000Z',
      'telegram@2026-05-20T09:30:00.000Z',
      'telegram@2026-05-20T10:00:00.000Z',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [
      turn('2026-05-20T10:00:00.000Z', 'telegram'),
      turn('2026-05-20T09:00:00.000Z', 'web'),
    ];
    const before = input.map((t) => t.at);
    mergeAndSortTurns(input);
    expect(input.map((t) => t.at)).toEqual(before);
  });

  it('handles an empty transcript', () => {
    expect(mergeAndSortTurns([])).toEqual([]);
  });
});
