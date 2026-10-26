/**
 * POST /api/auth/logout without a database: the login and the epoch bump are
 * stood in. A plain sign-out clears this browser's cookie and ends nothing
 * else, for every login (there is no client login since workspaces W8a).
 * `{ everywhere: true }` ends every session, asset token and API key the
 * login holds. Proven on Postgres in lib/auth/session-epoch.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  login: null as null | { kind: string; loginId: string; email: string },
  ended: [] as string[],
  endOpts: [] as unknown[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The login the pipeline answers at the read (A4 hand batch B): null
  // where the guard refused.
  publicLoginItself: vi.fn(async () => h.login ?? null),
  endLoginSessions: vi.fn(async (id: string, opts?: unknown) => {
    h.ended.push(id);
    h.endOpts.push(opts);
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
  h.endOpts = [];
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

  it.each(['admin', 'member'])('everywhere ends them for an %s, keys too', async (kind) => {
    h.login = { kind, loginId: `${kind}-id`, email: `${kind}@example.invalid` };
    expect((await logout({ everywhere: true })).status).toBe(200);
    expect(h.ended).toEqual([`${kind}-id`]);
    expect(h.endOpts).toEqual([{ endKeys: true }]);
  });

  it('with no session it still clears the cookie and ends nothing', async () => {
    const res = await logout();
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/mantle_session=;/);
    expect(h.ended).toEqual([]);
  });

  // A10 part 2 fix round 1, L4: a body that is not JSON reads as none, as on
  // main; sign-out still clears the cookie and answers 200.
  it.each([
    ['malformed JSON', 'application/json', '{"everywhere":'],
    ['a form post', 'application/x-www-form-urlencoded', 'everywhere=true'],
    ['plain text', 'text/plain', 'bye'],
  ])('%s still signs out (200, cookie cleared, nothing else ended)', async (_n, type, body) => {
    h.login = { kind: 'admin', loginId: 'admin-id', email: 'admin@example.invalid' };
    const { POST } = await import('./route');
    const res = await POST(
      new Request('https://brain.example.invalid/api/auth/logout', {
        method: 'POST',
        headers: { 'content-type': type },
        body,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('set-cookie')).toMatch(/mantle_session=;/);
    expect(h.ended).toEqual([]);
  });
});
