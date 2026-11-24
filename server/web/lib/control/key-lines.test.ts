/**
 * The Control Center's hold on a box's key lines (key-lines.ts, the facts
 * read in run.ts): every string to a pattern, so a box's free text never
 * reaches the key status screen. And an older box (no key part) and a newer
 * one (a part the CC does not know) both read fine, never as bad-reply.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/db/control-center', () => ({}));
vi.mock('@mantle/tools/box-status', () => ({ shapeBoxStatus: (s: unknown) => s }));

const { KeyLines } = await import('./key-lines');

const AT = '2026-11-20T10:00:00.000Z';
const line = (over: Record<string, unknown> = {}) => ({
  service: 'openrouter',
  setAt: AT,
  print: 'ab-xxxxxxxxx…WXYZ',
  testable: true,
  test: { ok: true, at: AT },
  ...over,
});

describe('KeyLines', () => {
  it('keeps a good line as sent', () => {
    expect(KeyLines.parse([line()])).toEqual([line()]);
  });

  it('a print that does not fit is null, never its text', () => {
    for (const print of [
      'ab-xxxxxxxxxxx…WXYZ', // a head of 14
      'ab-xxx…WXYZ0', // a tail of 5
      'ab-xxx...WXYZ', // not the mark
      'ab xxx…WXYZ', // a space
      '<b>…WXYZ',
      'ab-xxx…WX', // a short tail
      'the whole key itself with no mark at all',
    ]) {
      expect(KeyLines.parse([line({ print })])[0]!.print, print).toBeNull();
    }
    expect(KeyLines.parse([line({ print: '…WXYZ' })])[0]!.print).toBe('…WXYZ');
  });

  it('a line with a service or set time that does not fit is dropped', () => {
    expect(
      KeyLines.parse([
        line({ service: 'Open Router' }),
        line({ service: 'x'.repeat(70) }),
        line({ setAt: 'yesterday' }),
        line({ service: 'mapbox' }),
      ]).map((l) => l.service),
    ).toEqual(['mapbox']);
  });

  it('a test with a bad time is null; a field a later box adds is dropped', () => {
    const [l] = KeyLines.parse([line({ test: { ok: true, at: 'soon' }, extra: 'free text' })]);
    expect(l!.test).toBeNull();
    expect(l).not.toHaveProperty('extra');
  });

  it('a wrong type is a bad reply', () => {
    expect(KeyLines.safeParse([line({ testable: 'yes' })]).success).toBe(false);
    expect(KeyLines.safeParse('lines').success).toBe(false);
  });

  it('keeps at most 100 lines', () => {
    expect(KeyLines.parse(Array.from({ length: 150 }, () => line()))).toHaveLength(100);
  });
});
