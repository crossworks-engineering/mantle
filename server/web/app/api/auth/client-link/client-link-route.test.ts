/**
 * POST /api/auth/client-link (client logins C2) without a database: the
 * redeem is stood in, so these pin what the ROUTE does with it. One 401 for
 * every failure (no oracle) and no cookie then; on success a CLIENT session
 * cookie that lasts 30 days, never a year, signed with the login's epoch;
 * rate limited per IP and, on failed codes, brain-wide. The redeem itself
 * is proven on Postgres in packages/content/src/client-logins.db.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '12121212-1212-4212-8212-121212121212';
const ANCHOR = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  redeemed: null as null | Record<string, unknown>,
  calls: [] as Array<{ code: string; email: string }>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  redeemClientSigninLink: vi.fn(async (input: { code: string; email: string }) => {
    h.calls.push(input);
    return h.redeemed;
  }),
}));

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: (e: Record<string, unknown>) => h.audits.push(e),
  requestMetaFrom: () => ({}),
}));

const SECRET = 'client-link-secret-that-is-at-least-32-chars';
let savedSecret: string | undefined;
beforeAll(() => {
  savedSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = SECRET;
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
});

beforeEach(() => {
  // A fresh module graph per test: the rate limiter's buckets start empty.
  vi.resetModules();
  h.redeemed = null;
  h.calls = [];
  h.audits = [];
});

const signIn = async (body: unknown, ip = '203.0.113.1') => {
  const { POST } = await import('./route');
  return POST(
    new Request('https://brain.example.invalid/api/auth/client-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
};

const GOOD = { code: 'AbCdEfGhJkMnPqRs', email: 'client@example.invalid' };
const REDEEMED = {
  loginId: LOGIN,
  email: 'client@example.invalid',
  ownerId: ANCHOR,
  linkId: 'l1',
  sessionEpoch: 3,
};

describe('POST /api/auth/client-link', () => {
  it('signs the client in with a 30-day session at the login epoch', async () => {
    h.redeemed = REDEEMED;
    const before = Math.floor(Date.now() / 1000);
    const res = await signIn(GOOD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/^mantle_session=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Max-Age=2592000/);
    const value = decodeURIComponent(set.split(';')[0]!.split('=').slice(1).join('='));
    const { verifySessionCookie } = await import('@/lib/auth');
    const claims = verifySessionCookie(value)!;
    expect(claims.uid).toBe(LOGIN);
    expect(claims.ep).toBe(3);
    const thirty = 30 * 24 * 60 * 60;
    expect(claims.exp).toBeGreaterThanOrEqual(before + thirty);
    expect(claims.exp).toBeLessThanOrEqual(before + thirty + 5);
    expect(h.calls).toEqual([GOOD]);
    expect(h.audits.map((a) => a.action)).toEqual(['auth.client_link_signin']);
  });

  it('answers every failure with the same 401 and no cookie', async () => {
    const bodies: unknown[] = [
      GOOD, // the redeem says no (wrong, used, revoked, expired, wrong email: one null)
      { code: GOOD.code }, // no email
      { email: GOOD.email }, // no code
      { code: 'x'.repeat(65), email: GOOD.email },
      'not json',
    ];
    const seen = new Set<string>();
    for (const body of bodies) {
      const res = await signIn(body);
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
      seen.add(JSON.stringify(await res.json()));
    }
    expect(seen.size).toBe(1);
    expect(h.audits.every((a) => a.action === 'auth.client_link_failed')).toBe(true);
  });

  it('rate limits one address before any lookup', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await signIn(GOOD, '198.51.100.7')).status).toBe(401);
    }
    h.redeemed = REDEEMED;
    const res = await signIn(GOOD, '198.51.100.7');
    expect(res.status).toBe(429);
    expect(h.calls).toHaveLength(10);
    // Another address is not held back by it.
    expect((await signIn(GOOD, '198.51.100.8')).status).toBe(200);
  });

  it('rate limits the whole brain once many addresses keep failing', async () => {
    for (let i = 0; i < 120; i += 1) {
      expect((await signIn(GOOD, `198.51.100.${(i % 20) + 10}`)).status).toBe(401);
    }
    h.redeemed = REDEEMED;
    expect((await signIn(GOOD, '198.51.100.99')).status).toBe(429);
  });
});
