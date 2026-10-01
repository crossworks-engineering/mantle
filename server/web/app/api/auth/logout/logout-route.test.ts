/**
 * POST /api/auth/logout without a database: the login and the epoch bump are
 * stood in. A plain sign-out clears this browser's cookie and ends nothing
 * else for an admin or a member; for a CLIENT it ends every session and
 * asset token the login holds (client logins audit B23: a download URL left
 * in a shared browser's history must stop when the client signs out).
 * `{ everywhere: true }` ends them for every role. Proven on Postgres in
 * lib/auth/session-epoch.db.test.ts and client-session.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  login: null as null | { kind: string; loginId: string; email: string },
  ended: [] as string[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLoginOr401: vi.fn(async () => {
    const { NextResponse } = await import('@/server/http-compat');
    return h.login ?? NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }),
  endLoginSessions: vi.fn(async (id: string) => {
    h.ended.push(id);
    return 1;
  }),
}));

vi.mock('@/lib/audit', () => ({
  auditFireAndForget: () => {},
  requestMetaFrom: () => ({}),
}));

beforeEach(() => {
  h.login = null;
  h.ended = [];
});

const logout = async (body?: unknown) => {
  const { POST } = await import('./route');
  return POST(
    new Request('https://brain.example.invalid/api/auth/logout', {
      method: 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
};

describe('POST /api/auth/logout', () => {
  it.each(['admin', 'member'])('a plain sign-out of an %s ends only this browser', async (kind) => {
    h.login = { kind, loginId: `${kind}-id`, email: `${kind}@example.invalid` };
    const res = await logout();
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/mantle_session=;/);
    expect(h.ended).toEqual([]);
  });

  it("a client's plain sign-out ends every session and asset token it holds", async () => {
    h.login = { kind: 'client', loginId: 'client-id', email: 'c@example.invalid' };
    const res = await logout();
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/mantle_session=;/);
    expect(h.ended).toEqual(['client-id']);
  });

  it.each(['admin', 'member', 'client'])('everywhere ends them for an %s', async (kind) => {
    h.login = { kind, loginId: `${kind}-id`, email: `${kind}@example.invalid` };
    expect((await logout({ everywhere: true })).status).toBe(200);
    expect(h.ended).toEqual([`${kind}-id`]);
  });

  it('with no session it still clears the cookie and ends nothing', async () => {
    const res = await logout();
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/mantle_session=;/);
    expect(h.ended).toEqual([]);
  });
});
