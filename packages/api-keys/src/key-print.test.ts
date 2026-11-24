/**
 * keyPrint (shape.ts): the short print of a provider key that key status on
 * the fleet shows (docs/control-center.md, "Key status on the fleet"). Never
 * more than a quarter of the key; a short key gives its last 4 or nothing; a
 * shown part with a character outside [A-Za-z0-9_-] gives no print. Every
 * key here is made at run time from a repeated letter, so it looks like no
 * real key.
 */
import { describe, expect, it } from 'vitest';
import { KEY_PRINT_RE } from '@mantle/client-types';
import { keyPrint } from './shape';

/** A made-up key of `n` characters: `p` then `x`s, ending in `WXYZ`. */
const fake = (n: number, p = 'ab-') => (p + 'x'.repeat(Math.max(0, n))).slice(0, n - 4) + 'WXYZ';

const shown = (print: string) => print.replace('…', '').length;

describe('keyPrint', () => {
  it('a long key: its first 12 and its last 4', () => {
    const key = `sk-or-v1-${'0'.repeat(60)}WXYZ`;
    expect(key.length).toBe(73);
    expect(keyPrint(key)).toBe('sk-or-v1-000…WXYZ');
  });

  it('64 characters: the full head and tail, a quarter exactly', () => {
    const p = keyPrint(fake(64))!;
    expect(p).toBe('ab-xxxxxxxxx…WXYZ');
    expect(shown(p)).toBe(16);
  });

  it('under 64: the head shrinks to keep a quarter', () => {
    expect(keyPrint(fake(40))).toBe('ab-xxx…WXYZ');
    expect(shown(keyPrint(fake(40))!)).toBe(10);
  });

  it('24 characters: 2 of the head and the last 4', () => {
    expect(keyPrint(fake(24))).toBe('ab…WXYZ');
  });

  it('23 characters: the last 4 only', () => {
    expect(keyPrint(fake(23))).toBe('…WXYZ');
  });

  it('16 characters: the last 4 only (a quarter)', () => {
    expect(keyPrint(fake(16))).toBe('…WXYZ');
  });

  it('15, 12, 11 and 0 characters: nothing (4 would be more than a quarter)', () => {
    for (const n of [15, 12, 11]) expect(keyPrint(fake(n)), String(n)).toBeNull();
    expect(keyPrint('')).toBeNull();
  });

  it('never more than a quarter, and always the CC pattern, at every length', () => {
    for (let n = 0; n <= 300; n++) {
      const p = keyPrint(fake(n));
      if (p === null) continue;
      expect(shown(p) * 4, String(n)).toBeLessThanOrEqual(n);
      expect(KEY_PRINT_RE.test(p), String(n)).toBe(true);
    }
  });

  it('a character outside the pattern in a shown part: no print', () => {
    // In the head, in the tail.
    expect(keyPrint(`pk.${'x'.repeat(80)}WXYZ`)).toBeNull();
    expect(keyPrint(`ab-${'x'.repeat(80)}WX=Z`)).toBeNull();
    expect(keyPrint(`ab-${'x'.repeat(80)}WX Z`)).toBeNull();
    expect(keyPrint(`ab-${'x'.repeat(80)}WX\nZ`)).toBeNull();
    expect(keyPrint(`ab-${'x'.repeat(80)}WX…Z`)).toBeNull();
    // In the middle, left out: the print stands.
    expect(keyPrint(`ab-${'x'.repeat(20)}.=/${'x'.repeat(60)}WXYZ`)).toBe('ab-xxxxxxxxx…WXYZ');
  });
});
