/**
 * Admin password reset by the target's role (decision (a), 2026-09-29; the
 * contract's section 5): an admin's and a member's password can be reset (a
 * reset is a member's only way back in); a client, which signs in with a
 * link or a code, and a role this code does not know answer 400 with reason
 * `not-a-password-login`, and nothing is written. The database is stood in;
 * the real refusal on Postgres is in users-lockout.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'member' as string,
  updated: [] as string[],
}));

vi.mock('@mantle/db', () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [{ id: 'target', email: 'target@example.invalid', role: h.role }],
  };
  return {
    db: { select: () => chain },
    authUsers: { id: 'id', email: 'email', role: 'role' },
    eq: () => ({}),
  };
});

vi.mock('@/lib/auth', () => ({
  getOwnerOr401WithSource: async () => ({
    user: {
      id: '33333333-3333-4333-8333-333333333333',
      email: 'anchor@example.invalid',
      actor: {
        id: '55555555-5555-4555-8555-555555555555',
        email: 'admin@example.invalid',
        displayName: null,
        isOwner: false,
      },
    },
    source: 'web',
  }),
  updatePassword: async (id: string) => {
    h.updated.push(id);
  },
  endLoginSessions: async () => 1,
  bearerFromHeader: () => null,
  mobileTokenJti: () => null,
  setSessionCookie: () => {},
}));

vi.mock('@/lib/audit', () => ({ auditFireAndForget: () => {}, requestMetaFrom: () => ({}) }));

const TARGET = '22222222-2222-4222-8222-222222222222';

async function reset() {
  const { POST } = await import('./route');
  const res = await POST(
    new Request(`http://x/api/users/${TARGET}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: 'long-enough-pw' }),
    }),
    { params: Promise.resolve({ id: TARGET }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/users/:id/password by target role', () => {
  beforeEach(() => {
    h.updated = [];
  });

  it.each(['admin', 'member'])('resets a %s password', async (role) => {
    h.role = role;
    expect(await reset()).toEqual({ status: 200, body: { ok: true } });
    expect(h.updated).toEqual([TARGET]);
  });

  it.each(['client', 'auditor'])(
    'refuses a %s target with reason not-a-password-login, writing nothing',
    async (role) => {
      h.role = role;
      const { status, body } = await reset();
      expect(status).toBe(400);
      expect(body).toMatchObject({
        reason: 'not-a-password-login',
        error: expect.any(String),
        message: expect.any(String),
      });
      expect(h.updated).toEqual([]);
    },
  );
});
