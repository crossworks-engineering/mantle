/**
 * PUT /api/team-admin/hub-app without a database (member logins Phase 6
 * stage 6): designating the members' home app makes no share link (team links
 * are retired). An app still at admin goes to team, so members can run it;
 * an app already at a member level keeps it. The answer is exactly
 * `{ appId, levelChanged }`: the retired `modeChanged` alias is gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const APP = '88888888-8888-4888-8888-888888888888';

const h = vi.hoisted(() => ({
  audience: 'admin' as string,
  levels: [] as Array<[string, string]>,
  prefs: [] as Array<Record<string, unknown>>,
  shares: 0,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: ANCHOR, email: 'admin@example.invalid' })),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  getApp: vi.fn(async () => ({ id: APP, audience: h.audience, publishedBuild: { ok: true } })),
  setItemLevel: vi.fn(async (_owner: string, id: string, level: string) => {
    h.levels.push([id, level]);
    return {};
  }),
  updateProfilePreferences: vi.fn(async (_owner: string, p: Record<string, unknown>) => {
    h.prefs.push(p);
  }),
  createShare: vi.fn(async () => {
    h.shares += 1;
    return { id: 's', token: 't', mode: 'public' };
  }),
  applyShareMode: vi.fn(async () => {
    h.shares += 1;
    return true;
  }),
}));

beforeEach(() => {
  h.audience = 'admin';
  h.levels = [];
  h.prefs = [];
  h.shares = 0;
});

const put = async () => {
  const { PUT } = await import('./route');
  return PUT(
    new Request('https://brain.example.invalid/api/team-admin/hub-app', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: APP }),
    }),
  );
};

describe('PUT /api/team-admin/hub-app', () => {
  it('puts an admin app at team and makes no link', async () => {
    const res = await put();
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ appId: APP, levelChanged: true });
    expect(h.levels).toEqual([[APP, 'team']]);
    expect(h.prefs).toEqual([{ teamHubAppId: APP }]);
    expect(h.shares).toBe(0);
  });

  it('leaves an app members can already run at its level', async () => {
    for (const audience of ['team', 'client', 'public']) {
      h.audience = audience;
      const res = await put();
      expect(await res.json()).toStrictEqual({ appId: APP, levelChanged: false });
    }
    expect(h.levels).toEqual([]);
    expect(h.shares).toBe(0);
  });
});
