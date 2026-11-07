/**
 * GET /api/dashboard without a database: the bundle's sources are stood in
 * and record who asked. The bundle is cached for a few seconds, keyed by
 * the calling login, not the brain: the errors and failures in it are that
 * login's own, so two logins asking one after the other each get their own
 * (screenshots final audit, M1), and one login asking twice gets the cached
 * bundle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  actor: 'login-x',
  calls: [] as Array<{ fn: string; login: string }>,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: () => ({ id: 'brain-id', email: '', actor: { id: h.actor } }),
}));
vi.mock('@/lib/metrics', () => ({
  spendByDay: async () => [],
  topErrors: async (_o: string, login: string) => {
    h.calls.push({ fn: 'topErrors', login });
    return [{ message: `${login} error`, count: 1, lastAt: '', lastTraceId: 't' }];
  },
  recentFailures: async (_o: string, login: string) => {
    h.calls.push({ fn: 'recentFailures', login });
    return [{ id: 't', kind: 'extractor_run', startedAt: '', error: `${login} failure` }];
  },
}));
vi.mock('@/lib/dashboard', () => ({
  brainCounts: async () => ({}),
  corpusCapacity: async () => ({}),
  emailStats: async () => ({}),
  graphIntegrity: async () => ({}),
  heartbeatStats: async () => ({}),
  nodesCreatedByDay: async () => [],
  pendingToolCount: async () => 0,
  telegramStats: async () => ({}),
  vectorCounts: async () => ({}),
}));

const { GET } = await import('./route');

type Bundle = { errs: Array<{ message: string }>; fails: Array<{ error: string }> };
const asLogin = async (login: string) => {
  h.actor = login;
  return (await (await GET()).json()) as Bundle;
};

beforeEach(() => {
  h.calls.length = 0;
});

describe('GET /api/dashboard: the cache is per login', () => {
  it("two logins one after the other each get their own errors, never the other's", async () => {
    const x = await asLogin('login-x');
    const y = await asLogin('login-y');
    expect(x.errs.map((e) => e.message)).toEqual(['login-x error']);
    expect(x.fails.map((f) => f.error)).toEqual(['login-x failure']);
    expect(y.errs.map((e) => e.message)).toEqual(['login-y error']);
    expect(y.fails.map((f) => f.error)).toEqual(['login-y failure']);
    expect(JSON.stringify(y)).not.toContain('login-x');
    // Each was read for its own login.
    expect(h.calls).toEqual([
      { fn: 'topErrors', login: 'login-x' },
      { fn: 'recentFailures', login: 'login-x' },
      { fn: 'topErrors', login: 'login-y' },
      { fn: 'recentFailures', login: 'login-y' },
    ]);
  });

  it('the same login again within the window gets its cached bundle', async () => {
    const first = await asLogin('login-z');
    const again = await asLogin('login-z');
    expect(again).toEqual(first);
    expect(h.calls.filter((c) => c.login === 'login-z')).toHaveLength(2);
  });
});
