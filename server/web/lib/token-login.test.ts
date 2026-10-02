// The mobile companion's login refuses a member login: every route the app
// calls is an admin route, so a member bearer would only collect 403s (audit
// MED, member logins Phase 1). The web token route still admits members.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ role: 'admin' as string, inserts: 0 }));

vi.mock('@mantle/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'set']) chain[m] = () => chain;
  chain['values'] = () => {
    state.inserts += 1;
    return chain;
  };
  chain['then'] = (resolve: (v: unknown[]) => void) => resolve([{ role: state.role }]);
  return {
    db: { select: () => chain, insert: () => chain, update: () => chain },
    authUsers: { id: 'id', role: 'role', lastLoginAt: 'last_login_at' },
    mobileTokens: {},
    eq: () => ({}),
    sql: () => ({}),
  };
});
vi.mock('@/lib/auth', () => ({
  loginWithPassword: vi.fn(async () => 'login-1'),
  buildMobileToken: () => ({ value: 'tok', expiresInSec: 60, expiresAt: new Date() }),
}));
vi.mock('@/lib/audit', () => ({ auditFireAndForget: vi.fn(), requestMetaFrom: () => ({}) }));
vi.mock('@/lib/brain-identity', () => ({
  brainIdField: async () => ({ brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f' }),
}));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: () => '1.1.1.1',
  clientIpKey: () => '1.1.1.1',
  rateLimit: () => ({ ok: true }),
}));

import { handleTokenLogin } from './token-login';

const login = (adminsOnly?: boolean) =>
  handleTokenLogin(
    new Request('https://brain.example.com/api/auth/x', {
      method: 'POST',
      body: JSON.stringify({ email: 'm@example.com', password: 'pw' }),
    }),
    { path: '/api/auth/x', channel: 'mobile', defaultLabel: 'Mobile device', adminsOnly },
  );

beforeEach(() => {
  state.role = 'admin';
  state.inserts = 0;
});

describe('token login: adminsOnly', () => {
  it('refuses a member with 403 member-login and mints nothing', async () => {
    state.role = 'member';
    const res = await login(true);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe('member-login');
    expect(state.inserts).toBe(0);
  });

  it('admits an admin', async () => {
    const res = await login(true);
    expect(res.status).toBe(200);
    expect(state.inserts).toBe(1);
  });

  it('admits a member where the route does not ask (the web token route)', async () => {
    state.role = 'member';
    expect((await login()).status).toBe(200);
  });
});

describe('token login: what the answer names', () => {
  const signIn = (opts: { withRole?: boolean; adminsOnly?: boolean }) =>
    handleTokenLogin(
      new Request('https://brain.example.com/api/auth/x', {
        method: 'POST',
        body: JSON.stringify({ email: 'm@example.com', password: 'pw' }),
      }),
      { path: '/api/auth/x', channel: 'mobile', defaultLabel: 'Mobile device', ...opts },
    );

  it('device-login (withRole) names the role, the login and this brain', async () => {
    state.role = 'member';
    const body = (await (await signIn({ withRole: true })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      token: 'tok',
      deviceId: expect.any(String),
      role: 'member',
      loginId: 'login-1',
      brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
    });
  });

  it('the frozen mobile-login (adminsOnly) and the web token answer as before: no login, no brain', async () => {
    for (const opts of [{ adminsOnly: true }, {}]) {
      const body = (await (await signIn(opts)).json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['deviceId', 'expiresAt', 'expiresIn', 'token']);
    }
  });
});
