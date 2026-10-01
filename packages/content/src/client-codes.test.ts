/**
 * Email sign-in codes (client logins C2b) without a database: the pieces
 * the audit asked to pin that need no rows.
 *
 *  - B17: a redeem does the same work whatever the email. An unknown email,
 *    a disabled login and a live code with a wrong digit run the same steps
 *    in the same order (look the login up, look the code up under lock,
 *    hash and compare, count the try), so the timing cannot tell whether an
 *    email is a client. Spies on `redeemSteps`; not a timing test.
 *  - B21: the stored hash is an HMAC keyed from SESSION_SECRET (HKDF, fixed
 *    label), so a copy of the database without the secret recovers no code.
 *
 * The code rules on Postgres: client-codes.db.test.ts.
 */
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({ fake: 'tx' }) },
}));

const SECRET = 'client-codes-unit-secret-at-least-32-characters';
let saved: string | undefined;
beforeAll(() => {
  saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = SECRET;
});
afterAll(() => {
  if (saved === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = saved;
});

const REQ = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const LOGIN = {
  id: '12121212-1212-4212-8212-121212121212',
  email: 'client@example.invalid',
  role: 'client',
  disabledAt: null as Date | null,
  sessionEpoch: 3,
};

describe('redeemClientEmailCode takes one path (audit B17)', () => {
  let c: typeof import('./client-codes');
  let calls: string[];

  beforeEach(async () => {
    vi.restoreAllMocks();
    c = await import('./client-codes');
    calls = [];
    const s = c.redeemSteps;
    const real = { checkCode: s.checkCode.bind(s) };
    vi.spyOn(s, 'findLogin').mockImplementation(async () => {
      calls.push('findLogin');
      return null;
    });
    vi.spyOn(s, 'findOpenCode').mockImplementation(async () => {
      calls.push('findOpenCode');
      return null;
    });
    vi.spyOn(s, 'checkCode').mockImplementation((...a) => {
      calls.push('checkCode');
      return real.checkCode(...a);
    });
    vi.spyOn(s, 'countTry').mockImplementation(async () => {
      calls.push('countTry');
    });
    vi.spyOn(s, 'finish').mockImplementation(async () => {
      calls.push('finish');
    });
  });

  const redeem = (code: string) =>
    c.redeemClientEmailCode({ requestId: REQ, email: LOGIN.email, code });

  it('an unknown email, a disabled login and a wrong code run the same steps', async () => {
    const live = { id: 'code-1', codeHash: c.hashClientCode(REQ, '12345678') };

    // 1. No such login: no row either.
    expect(await redeem('12345678')).toBeNull();
    const unknown = [...calls];

    // 2. A live code of an active client, one digit wrong.
    calls.length = 0;
    vi.mocked(c.redeemSteps.findLogin).mockImplementation(async () => {
      calls.push('findLogin');
      return LOGIN;
    });
    vi.mocked(c.redeemSteps.findOpenCode).mockImplementation(async () => {
      calls.push('findOpenCode');
      return live;
    });
    expect(await redeem('12345679')).toBeNull();
    const wrong = [...calls];

    // 3. A disabled login with the right code.
    calls.length = 0;
    vi.mocked(c.redeemSteps.findLogin).mockImplementation(async () => {
      calls.push('findLogin');
      return { ...LOGIN, disabledAt: new Date() };
    });
    expect(await redeem('12345678')).toBeNull();
    const disabled = [...calls];

    // 4. A login that is no longer a client, with the right code.
    calls.length = 0;
    vi.mocked(c.redeemSteps.findLogin).mockImplementation(async () => {
      calls.push('findLogin');
      return { ...LOGIN, role: 'member' };
    });
    expect(await redeem('12345678')).toBeNull();
    const member = [...calls];

    const path = ['findLogin', 'findOpenCode', 'checkCode', 'countTry'];
    expect(unknown).toEqual(path);
    expect(wrong).toEqual(path);
    expect(disabled).toEqual(path);
    expect(member).toEqual(path);
  });

  it('the no-row branch still hashes and compares, and counts nothing', async () => {
    expect(await redeem('12345678')).toBeNull();
    expect(c.redeemSteps.checkCode).toHaveBeenCalledWith(REQ, '12345678', null);
    expect(c.redeemSteps.countTry).toHaveBeenCalledWith({ fake: 'tx' }, null);
    expect(c.redeemSteps.finish).not.toHaveBeenCalled();
  });

  it('only the right code of an active client finishes', async () => {
    const live = { id: 'code-2', codeHash: c.hashClientCode(REQ, '87654321') };
    vi.mocked(c.redeemSteps.findLogin).mockImplementation(async () => LOGIN);
    vi.mocked(c.redeemSteps.findOpenCode).mockImplementation(async () => live);
    expect(await redeem('8765 4321')).toEqual({
      loginId: LOGIN.id,
      email: LOGIN.email,
      codeId: 'code-2',
      sessionEpoch: 3,
    });
    expect(c.redeemSteps.finish).toHaveBeenCalledTimes(1);
    expect(c.redeemSteps.countTry).not.toHaveBeenCalled();
  });

  it('checkCode never matches the dummy hash', async () => {
    vi.restoreAllMocks();
    // Even a code whose HMAC happened to be the dummy would not pass: the
    // no-row compare is for the timing only.
    expect(c.redeemSteps.checkCode(REQ, '00000000', null)).toBe(false);
    expect(c.redeemSteps.checkCode(REQ, '00000000', c.hashClientCode(REQ, '00000000'))).toBe(true);
  });
});

describe('the stored code hash (audit B21)', () => {
  it('is an HMAC keyed from SESSION_SECRET, not a bare SHA-256', async () => {
    const c = await import('./client-codes');
    const key = Buffer.from(
      hkdfSync('sha256', SECRET, Buffer.alloc(0), 'mantle client sign-in code v1', 32),
    );
    const want = createHmac('sha256', key).update(`${REQ}:01234567`, 'utf8').digest('hex');
    expect(c.hashClientCode(REQ.toUpperCase(), '01234567')).toBe(want);
    const bare = createHash('sha256').update(`${REQ}:01234567`, 'utf8').digest('hex');
    expect(c.hashClientCode(REQ, '01234567')).not.toBe(bare);
  });

  it('changes with the secret, and refuses to work without one', async () => {
    const c = await import('./client-codes');
    const a = c.hashClientCode(REQ, '01234567');
    process.env.SESSION_SECRET = `${SECRET}-rotated`;
    try {
      expect(c.hashClientCode(REQ, '01234567')).not.toBe(a);
      process.env.SESSION_SECRET = 'short';
      expect(() => c.hashClientCode(REQ, '01234567')).toThrow(/SESSION_SECRET/);
    } finally {
      process.env.SESSION_SECRET = SECRET;
    }
    expect(c.hashClientCode(REQ, '01234567')).toBe(a);
  });

  it('a send failure reason for the admin never carries a code', async () => {
    const c = await import('./client-codes');
    expect(c.clientCodeFailureReason('550 rejected\n  code 01234567 in body')).toBe(
      '550 rejected code ######## in body',
    );
    expect(c.clientCodeFailureReason('   ')).toBe('unknown error');
    expect(c.clientCodeFailureReason('x'.repeat(500))).toHaveLength(300);
  });
});
