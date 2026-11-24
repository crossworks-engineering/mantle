/**
 * ownKeyLines (key-status.ts): the Control Center's own box shows its key
 * lines only to a caller with the vault's own area, keys, as its Keys screen
 * does. Without it: `keys-area`, and no key row is read nor opened, and no
 * test runs.
 */
import { describe, expect, it, vi } from 'vitest';

const touched = vi.hoisted(() => ({ db: 0 }));
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    callerHasAreaBound: vi.fn(async () => false),
    db: new Proxy(
      {},
      {
        get() {
          touched.db++;
          throw new Error('no database read without the keys area');
        },
      },
    ),
  };
});

const { ownKeyLines } = await import('./key-status');

describe('ownKeyLines', () => {
  it('without the keys area: keys-area, no read, no test', async () => {
    expect(await ownKeyLines('00000000-0000-4000-8000-000000000001')).toEqual({
      ok: false,
      reason: 'keys-area',
    });
    expect(
      await ownKeyLines('00000000-0000-4000-8000-000000000001', { loginId: null, via: 'web' }),
    ).toEqual({ ok: false, reason: 'keys-area' });
    expect(touched.db).toBe(0);
  });
});
