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
vi.mock('@/lib/rate-limit', () => ({ clientIp: () => '1.1.1.1', rateLimit: () => ({ ok: true }) }));

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
