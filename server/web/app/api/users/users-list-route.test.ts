/**
 * GET /api/users without a database: the answer is exactly
 * `{ users, currentActorId }`. `membersEnabled` (always true since member
 * logins Phase 6, kept one contract cycle for older clients) is gone.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { runRoute } from '@/server/run-route';
import { standInLogin } from '@/server/run-route-stand-ins';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const MEMBER = '22222222-2222-4222-8222-222222222222';

// Through the full pipeline (runRoute, A4 step 3a): the gate finds the
// stood-in login's session, the guard reads it (the users area: held).
vi.mock(
  '@/lib/auth/login-row',
  async () => (await import('@/server/run-route-stand-ins')).loginRowStandIn,
);
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  requireArea: async () => true,
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const rows = [
    {
      id: ANCHOR,
      email: 'admin@example.invalid',
      displayName: null,
      isOwner: true,
      role: 'admin',
      contactId: null,
      disabledAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: null,
      agentId: null,
      agentSlug: null,
      agentName: null,
    },
  ];
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    orderBy: async () => rows,
  };
  return {
    ...(await importOriginal<typeof import('@mantle/db')>()),
    ...(await import('@/server/run-route-stand-ins')).dbStandIns,
    db: { select: () => chain },
  };
});

beforeAll(() => {
  standInLogin({ id: ANCHOR, role: 'admin', isOwner: true });
  standInLogin({ id: MEMBER, role: 'member' });
});

describe('GET /api/users', () => {
  it('answers { users, currentActorId } and no membersEnabled', async () => {
    const res = await runRoute(ANCHOR, 'GET', '/api/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['currentActorId', 'users']);
    expect(body.currentActorId).toBe(ANCHOR);
    expect(body.users).toEqual([expect.objectContaining({ id: ANCHOR, agent: null })]);
  });

  it('refuses a member login and a request with no session, as the gate and guard did', async () => {
    const member = await runRoute(MEMBER, 'GET', '/api/users');
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ reason: 'member-login' });
    expect((await runRoute(null, 'GET', '/api/users')).status).toBe(401);
  });
});
