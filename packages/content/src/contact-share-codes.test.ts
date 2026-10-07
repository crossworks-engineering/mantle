/**
 * Contact share codes without a database (contact shares, migration 0214):
 *
 *  - every failure to check a code does the same work: a wrong code, sharing
 *    off, a locked contact, a share that names no contact (an open link)
 *    and no share at all run the same steps in the same order (find the
 *    row, count the share's failures, hash and compare, count the failure),
 *    each hashing once. Spies on `codeCheckSteps`, in the style of the
 *    client code (B17) and password timing tests;
 *  - the stored hash is an HMAC keyed from MANTLE_MASTER_KEY (HKDF, fixed
 *    label) and bound to the contact: a database copy alone recovers no
 *    code, and one contact's hash never fits another;
 *  - a code is 8 characters of the look-alike-free alphabet; typing
 *    normalises spaces only.
 *
 * The rules on Postgres: contact-shares.db.test.ts.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({ fake: 'tx' }) },
}));

const MASTER = 'contact-codes-unit-master-key';
let saved: string | undefined;
beforeAll(() => {
  saved = process.env.MANTLE_MASTER_KEY;
  process.env.MANTLE_MASTER_KEY = MASTER;
});
afterAll(() => {
  if (saved === undefined) delete process.env.MANTLE_MASTER_KEY;
  else process.env.MANTLE_MASTER_KEY = saved;
});

const OWNER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const SHARE = { id: '33333333-3333-4333-8333-333333333333', ownerId: OWNER, contactId: CONTACT };

describe('checkContactShareCode takes one path for every failure', () => {
  let c: typeof import('./contact-share-codes');
  let calls: string[];
  let row: Record<string, unknown> | null;
  let failures: number;

  beforeEach(async () => {
    vi.restoreAllMocks();
    c = await import('./contact-share-codes');
    calls = [];
    row = null;
    failures = 0;
    const s = c.codeCheckSteps;
    const realCheck = s.checkCode.bind(s);
    vi.spyOn(s, 'findRow').mockImplementation(async () => {
      calls.push('findRow');
      return row as never;
    });
    vi.spyOn(s, 'shareFailures').mockImplementation(async () => {
      calls.push('shareFailures');
      return failures;
    });
    vi.spyOn(s, 'checkCode').mockImplementation((...a) => {
      calls.push('checkCode');
      return realCheck(...a);
    });
    vi.spyOn(s, 'countFailure').mockImplementation(async () => {
      calls.push('countFailure');
      return false;
    });
    vi.spyOn(s, 'accept').mockImplementation(async () => {
      calls.push('accept');
    });
  });

  const liveRow = (code: string, over: Record<string, unknown> = {}) => ({
    contactId: CONTACT,
    ownerId: OWNER,
    codeHash: c.hashContactCode(CONTACT, code),
    codeEpoch: 4,
    failedAttempts: 0,
    failedSince: null,
    lockedUntil: null,
    ...over,
  });

  it('a wrong code, sharing off, a lock, an open link and no share run the same steps', async () => {
    const FAIL = ['findRow', 'shareFailures', 'checkCode', 'countFailure'];
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        'wrong code',
        async () => {
          row = liveRow('ABCDEFGH');
          return c.checkContactShareCode(SHARE, 'ABCDEFGJ');
        },
      ],
      [
        'sharing off',
        async () => {
          row = liveRow('ABCDEFGH', { codeHash: null });
          return c.checkContactShareCode(SHARE, 'ABCDEFGH');
        },
      ],
      [
        'locked',
        async () => {
          row = liveRow('ABCDEFGH', { lockedUntil: new Date(Date.now() + 60_000) });
          return c.checkContactShareCode(SHARE, 'ABCDEFGH');
        },
      ],
      [
        'share limit',
        async () => {
          row = liveRow('ABCDEFGH');
          failures = c.CONTACT_CODE_SHARE_HOURLY_FAILURES;
          return c.checkContactShareCode(SHARE, 'ABCDEFGH');
        },
      ],
      [
        'open link',
        async () => {
          row = null;
          return c.checkContactShareCode({ ...SHARE, contactId: null }, 'ABCDEFGH');
        },
      ],
      [
        'no share',
        async () => {
          row = null;
          return c.checkContactShareCode(null, 'ABCDEFGH');
        },
      ],
      [
        'another brain',
        async () => {
          row = liveRow('ABCDEFGH', { ownerId: '44444444-4444-4444-8444-444444444444' });
          return c.checkContactShareCode(SHARE, 'ABCDEFGH');
        },
      ],
    ];
    for (const [name, run] of cases) {
      calls.length = 0;
      failures = 0;
      expect(await run(), name).toMatchObject({ ok: false });
      expect(calls, name).toEqual(FAIL);
    }
  });

  it('a right code runs the same lookups and hash, then accepts', async () => {
    row = liveRow(' ABCD EFGH ');
    row.codeHash = c.hashContactCode(CONTACT, 'ABCDEFGH');
    const r = await c.checkContactShareCode(SHARE, ' ABCD EFGH ');
    expect(r).toEqual({ ok: true, contactId: CONTACT, ownerId: OWNER, codeEpoch: 4 });
    expect(calls).toEqual(['findRow', 'shareFailures', 'checkCode', 'accept']);
  });
});

describe('the stored hash', () => {
  it('is HMAC-SHA256 of contact and code under a key HKDF-derived from the master key', async () => {
    const c = await import('./contact-share-codes');
    const key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(MASTER, 'utf8'),
        Buffer.alloc(0),
        'mantle contact share code v1',
        32,
      ),
    );
    const want = createHmac('sha256', key).update(`${CONTACT}:ABCDEFGH`, 'utf8').digest('hex');
    expect(c.hashContactCode(CONTACT, 'ABCDEFGH')).toBe(want);
    // Bound to the contact: the same code of another contact hashes apart.
    expect(c.hashContactCode(OWNER, 'ABCDEFGH')).not.toBe(want);
    // And to the key: another master key gives another hash.
    process.env.MANTLE_MASTER_KEY = `${MASTER}-other`;
    try {
      expect(c.hashContactCode(CONTACT, 'ABCDEFGH')).not.toBe(want);
    } finally {
      process.env.MANTLE_MASTER_KEY = MASTER;
    }
  });
});

describe('a code', () => {
  it('is 8 characters of the 54-character look-alike-free alphabet, every one in use', async () => {
    const c = await import('./contact-share-codes');
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const code = c.generateContactCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]{8}$/);
      for (const ch of code) seen.add(ch);
    }
    expect(seen.size).toBe(54);
  });

  it('normalises spaces only, never case', async () => {
    const c = await import('./contact-share-codes');
    expect(c.normalizeContactCode(' aB3d \t eF7h\n')).toBe('aB3deF7h');
  });
});
