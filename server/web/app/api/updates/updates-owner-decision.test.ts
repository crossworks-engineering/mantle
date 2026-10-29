/**
 * The owner's decision of 2026-10-14, through the full pipeline (runRoute)
 * with no database: GET and HEAD /api/updates/status and POST
 * /api/updates/check need the settings area their rows name, and the gate
 * answers it; GET /api/updates/check, the cached update banner, stays open to
 * every Admin user (a carve-out).
 *
 * Before: all three answered any Admin user, area or not, and a member the
 * handler's 401.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { warmWorkspacesMock } from '../../../lib/test-support/workspaces-mock';
import { runRoute } from '@/server/run-route';
import { standInLogin } from '@/server/run-route-stand-ins';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
/** An Admin user that holds no Admin area. */
const LIMITED = '44444444-4444-4444-8444-444444444444';
const MEMBER = '22222222-2222-4222-8222-222222222222';

vi.mock(
  '@/lib/auth/login-row',
  async () => (await import('@/server/run-route-stand-ins')).loginRowStandIn,
);
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  requireArea: async (caller: { loginId: string }) => caller.loginId !== LIMITED,
}));
// The mocked area module resolved alone, before any request (S9 part 3
// round 2: two first imports in flight at once can get the real module).
beforeAll(warmWorkspacesMock);
// The release check and the updater sidecar, stood in: no network, no disk.
vi.mock('@/lib/updates', () => ({
  checkForUpdate: vi.fn(async (force: boolean) => ({ available: false, forced: force })),
  updaterAvailable: vi.fn(async () => true),
  readUpdaterStatus: vi.fn(async () => ({ state: 'idle' })),
  readUpdaterLog: vi.fn(async () => ''),
}));
// The audit row an Admin user's forced check writes, kept off the database.
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  auditFireAndForget: vi.fn(),
}));

beforeAll(() => {
  standInLogin({ id: ANCHOR, role: 'admin', adminMember: true, isOwner: true });
  standInLogin({ id: LIMITED, role: 'admin', adminMember: true });
  standInLogin({ id: MEMBER, role: 'member' });
});

const AREA = {
  error: 'forbidden',
  reason: 'area',
  area: 'settings',
  message: 'You cannot manage this part of the brain.',
};

describe('the update routes after the owner decision of 2026-10-14', () => {
  it('the status poll and the forced check need the settings area', async () => {
    for (const [method, path] of [
      ['GET', '/api/updates/status'],
      ['POST', '/api/updates/check'],
    ] as const) {
      const ok = await runRoute(ANCHOR, method, path, method === 'POST' ? {} : undefined);
      expect(ok.status, `${method} ${path}`).toBe(200);
      const limited = await runRoute(LIMITED, method, path, method === 'POST' ? {} : undefined);
      expect(limited.status, `${method} ${path}`).toBe(403);
      expect(await limited.json()).toEqual(AREA);
      const member = await runRoute(MEMBER, method, path, method === 'POST' ? {} : undefined);
      expect(member.status, `${method} ${path}`).toBe(403);
      expect(await member.json()).toMatchObject({ reason: 'member-login' });
      const none = await runRoute(null, method, path, method === 'POST' ? {} : undefined);
      expect(none.status, `${method} ${path}`).toBe(401);
    }
    expect((await runRoute(LIMITED, 'HEAD', '/api/updates/status')).status).toBe(403);
    const { checkForUpdate } = await import('@/lib/updates');
    expect(vi.mocked(checkForUpdate).mock.calls).toEqual([[true]]);
  });

  it('the cached banner stays open to every Admin user, area or not', async () => {
    for (const login of [ANCHOR, LIMITED]) {
      const res = await runRoute(login, 'GET', '/api/updates/check');
      expect(res.status, login).toBe(200);
      expect(await res.json()).toEqual({ available: false, forced: false });
    }
    // A member: the handler's 401, as before.
    expect((await runRoute(MEMBER, 'GET', '/api/updates/check')).status).toBe(401);
    expect((await runRoute(null, 'GET', '/api/updates/check')).status).toBe(401);
  });
});
