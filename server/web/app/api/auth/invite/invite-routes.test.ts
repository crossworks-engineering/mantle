/**
 * The public invite routes (member logins, Phase 6) without a database: the
 * redeem and preview are stood in, so these pin what the ROUTES do with them.
 * Rate limits per IP and, on failed codes, brain-wide, before bcrypt (a few
 * addresses cannot lock real invitees out); one 401 for every code
 * failure (no oracle); one 404 for every unusable code on the preview; the
 * session cookie set as /api/auth/login sets it; the password handed to the
 * redeem already hashed. The redeem itself is proven on Postgres in
 * packages/content/src/member-invites.db.test.ts.
 */
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  redeemed: null as null | Record<string, unknown>,
  redeemCalls: [] as Array<{ code: string; passwordHash: string; email?: string }>,
  preview: null as null | { ownerId: string; email: string; displayName: string | null },
  audits: [] as Array<Record<string, unknown>>,
  lastLogin: [] as unknown[],
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  redeemMemberInvite: vi.fn(
    async (input: { code: string; passwordHash: string; email?: string }) => {
      h.redeemCalls.push(input);
      return h.redeemed;
    },
  ),
  previewMemberInvite: vi.fn(async () => h.preview),
  loadPreferencesFor: vi.fn(async () => ({ siteName: 'Acme brain' })),
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {
    update: () => ({
      set: (v: unknown) => ({
        where: async () => {
          h.lastLogin.push(v);
        },
      }),
    }),
  },
}));

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: (e: Record<string, unknown>) => h.audits.push(e),
  requestMetaFrom: () => ({}),
}));

const SECRET = 'invite-routes-secret-that-is-at-least-32-chars';
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
  h.redeemCalls = [];
  h.preview = null;
  h.audits = [];
  h.lastLogin = [];
});

const accept = async (body: unknown, ip = '203.0.113.1') => {
  const { POST } = await import('./accept/route');
  return POST(
    new Request('https://brain.example.invalid/api/auth/invite/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }),
  );
};

const preview = async (code: string, ip = '203.0.113.1') => {
  const { GET } = await import('./[code]/route');
  return GET(
    new Request(`https://brain.example.invalid/api/auth/invite/${code}`, {
      headers: { 'x-forwarded-for': ip },
    }),
    { params: Promise.resolve({ code }) },
  );
};

const GOOD = { code: 'AbCdEfGhJkMnPqRs', password: 'correct horse' };

describe('POST /api/auth/invite/accept', () => {
  it('signs the new member in with the login session cookie', async () => {
    h.redeemed = {
      loginId: LOGIN,
      email: 'pat@example.invalid',
      ownerId: ANCHOR,
      contactId: null,
      inviteId: 'i1',
      via: 'invite',
    };
    const res = await accept(GOOD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: 'pat@example.invalid' });

    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/^mantle_session=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Path=\//);
    expect(set).toMatch(/Secure/i);
    const value = decodeURIComponent(set.split(';')[0]!.split('=').slice(1).join('='));
    const { verifySessionCookie } = await import('@/lib/auth');
    expect(verifySessionCookie(value)?.uid).toBe(LOGIN);

    // The password reaches the redeem hashed, never in the clear.
    const call = h.redeemCalls[0]!;
    expect(call.passwordHash).not.toContain(GOOD.password);
    expect(await bcrypt.compare(GOOD.password, call.passwordHash)).toBe(true);
    expect(h.audits.map((a) => a.action)).toEqual(['auth.invite_accepted']);
    expect(h.lastLogin).toHaveLength(1);
  });

  it('answers every code failure with the same 401 and no cookie', async () => {
    const bodies: unknown[] = [
      GOOD, // redeem says no (wrong, used, revoked, expired: all one null)
      { ...GOOD, email: 'someone@example.invalid' },
      { password: GOOD.password }, // no code
      { code: 'x'.repeat(65), password: GOOD.password },
      'not json',
    ];
    const seen = new Set<string>();
    for (const body of bodies) {
      const res = await accept(body);
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
      seen.add(JSON.stringify(await res.json()));
    }
    expect(seen.size).toBe(1);
    expect(h.audits.every((a) => a.action === 'auth.invite_failed')).toBe(true);
  });

  it('refuses a short password before any code is looked at', async () => {
    const res = await accept({ ...GOOD, password: 'short' });
    expect(res.status).toBe(400);
    expect(h.redeemCalls).toHaveLength(0);
  });

  it('rate limits one address before bcrypt', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await accept({ ...GOOD, password: 'short' }, '198.51.100.7')).status).toBe(400);
    }
    const res = await accept(GOOD, '198.51.100.7');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(h.redeemCalls).toHaveLength(0);
    // Another address is not held back by it.
    expect((await accept({ ...GOOD, password: 'short' }, '198.51.100.8')).status).toBe(400);
  });

  const NO_CODE = { password: GOOD.password }; // a failed code, before bcrypt

  it('does not let a few addresses lock out a real invitee', async () => {
    // Six addresses failing at their full rate (the audit's lockout).
    for (let i = 0; i < 60; i += 1) {
      const ip = `198.51.100.${(i % 6) + 10}`;
      expect((await accept(NO_CODE, ip)).status).toBe(401);
    }
    h.redeemed = {
      loginId: LOGIN,
      email: 'pat@example.invalid',
      ownerId: ANCHOR,
      contactId: null,
      inviteId: 'i1',
      via: 'invite',
    };
    expect((await accept(GOOD, '198.51.100.99')).status).toBe(200);
  });

  it('counts only failed codes brain-wide, not honest requests', async () => {
    // A short password is refused before any code: it spends no brain-wide
    // budget, however many addresses send one.
    for (let i = 0; i < 300; i += 1) {
      const ip = `198.51.100.${(i % 30) + 10}`;
      expect((await accept({ ...GOOD, password: 'short' }, ip)).status).toBe(400);
    }
    expect((await accept(GOOD, '198.51.100.99')).status).toBe(401);
    expect(h.redeemCalls).toHaveLength(1);
  });

  it('rate limits the whole brain once many addresses keep failing', async () => {
    for (let i = 0; i < 120; i += 1) {
      const ip = `198.51.100.${(i % 12) + 10}`;
      expect((await accept(NO_CODE, ip)).status).toBe(401);
    }
    const res = await accept(GOOD, '198.51.100.99');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(h.redeemCalls).toHaveLength(0);
  });
});

describe('GET /api/auth/invite/:code', () => {
  it('names who the invite is for, with the brain name', async () => {
    h.preview = { ownerId: ANCHOR, email: 'pat@example.invalid', displayName: 'Pat' };
    const res = await preview('AbCdEfGhJkMnPqRs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: 'pat@example.invalid',
      displayName: 'Pat',
      siteName: 'Acme brain',
    });
  });

  it('answers any unusable code with the same 404', async () => {
    const res = await preview('nope-nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Invite not found.' });
  });

  it('rate limits one address, and the whole brain on failed codes only', async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await preview('nope-nope', '192.0.2.1')).status).toBe(404);
    }
    expect((await preview('nope-nope', '192.0.2.1')).status).toBe(429);
    // Good previews spend no brain-wide budget.
    h.preview = { ownerId: ANCHOR, email: 'pat@example.invalid', displayName: 'Pat' };
    for (let i = 0; i < 600; i += 1) {
      expect((await preview('AbCdEfGhJkMnPqRs', `192.0.2.${(i % 25) + 2}`)).status).toBe(200);
    }
    h.preview = null;
    // 570 failures after the first address's 30: still under the cap.
    for (let i = 0; i < 570; i += 1) {
      expect((await preview('nope-nope', `198.18.0.${(i % 20) + 2}`)).status).toBe(404);
    }
    expect((await preview('nope-nope', '192.0.2.200')).status).toBe(429);
  });
});
