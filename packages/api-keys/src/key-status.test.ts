/**
 * ownKeyLines and testKeyLines (key-status.ts):
 *  - the Control Center's own box shows its key lines only to a caller with
 *    the vault's own area, keys, as its Keys screen does; without it
 *    `keys-area`, and no key row is read, opened or tested;
 *  - a read or a test that fails answers `error` for that box alone;
 *  - a test while one runs for the same owner joins it: one probe per key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: 0, keysArea: false, tests: 0 }));
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    callerHasAreaBound: vi.fn(async () => h.keysArea),
    db: new Proxy(
      {},
      {
        get() {
          h.db++;
          throw new Error('no database here');
        },
      },
    ),
  };
});
vi.mock('./index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./index')>()),
  providerKeyPrints: vi.fn(async () => {
    if (!h.keysArea) throw new Error('read without the keys area');
    return [{ id: 'k1', service: 'openrouter', createdAt: new Date(), print: null }];
  }),
}));
vi.mock('./probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./probe')>()),
  canProbeService: () => true,
}));
vi.mock('./vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vault')>()),
  testVaultKey: vi.fn(async () => {
    h.tests++;
    await new Promise((r) => setTimeout(r, 30));
    return null;
  }),
}));

const { ownKeyLines, testKeyLines } = await import('./key-status');
const OWNER = '00000000-0000-4000-8000-000000000001';
const WHO = { loginId: null, via: 'web' } as const;

afterEach(() => {
  h.db = 0;
  h.tests = 0;
  h.keysArea = false;
});

describe('ownKeyLines', () => {
  it('without the keys area: keys-area, no read, no test', async () => {
    expect(await ownKeyLines(OWNER)).toEqual({ ok: false, reason: 'keys-area' });
    expect(await ownKeyLines(OWNER, WHO)).toEqual({ ok: false, reason: 'keys-area' });
    expect(h.db).toBe(0);
    expect(h.tests).toBe(0);
  });

  it('a read or a test that fails: error, for this box alone', async () => {
    h.keysArea = true;
    // The read after the test reaches the database, which fails here.
    expect(await ownKeyLines(OWNER)).toEqual({ ok: false, reason: 'error' });
    expect(await ownKeyLines(OWNER, WHO)).toEqual({ ok: false, reason: 'error' });
  });
});

describe('testKeyLines', () => {
  it('an ask while a test runs joins it: one probe per key', async () => {
    h.keysArea = true;
    const both = await Promise.allSettled([testKeyLines(WHO, OWNER), testKeyLines(WHO, OWNER)]);
    expect(both.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(h.tests).toBe(1);
    // Once it ended, a new ask tests again.
    await testKeyLines(WHO, OWNER).catch(() => null);
    expect(h.tests).toBe(2);
  });
});
