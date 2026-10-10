/**
 * PUT /api/team-admin/hub-app without a database (workspaces W5b2):
 * designating the members' home app changes no level and makes no grant or
 * share link. An app the Team workspace reads is designated; one it does not
 * read is refused with 409 `not_in_team` (the admin shares it with Team in
 * Grant Access first), and the pref is left alone. The answer is exactly
 * `{ appId, levelChanged: false }`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const APP = '88888888-8888-4888-8888-888888888888';

const h = vi.hoisted(() => ({
  teamReads: true,
  prefs: [] as Array<Record<string, unknown>>,
  shares: 0,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: ANCHOR, email: 'admin@example.invalid' })),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  getApp: vi.fn(async () => ({ id: APP, publishedBuild: { ok: true } })),
  teamReadsItem: vi.fn(async () => h.teamReads),
  updateProfilePreferences: vi.fn(async (_owner: string, p: Record<string, unknown>) => {
    h.prefs.push(p);
  }),
  createShare: vi.fn(async () => {
    h.shares += 1;
    return { id: 's', token: 't', mode: 'public' };
  }),
}));

beforeEach(() => {
  h.teamReads = true;
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
  it('designates an app Team reads, and changes nothing else', async () => {
    const res = await put();
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ appId: APP, levelChanged: false });
    expect(h.prefs).toEqual([{ teamHubAppId: APP }]);
    expect(h.shares).toBe(0);
  });

  it('refuses an app Team does not read: share it with Team first', async () => {
    h.teamReads = false;
    const res = await put();
    expect(res.status).toBe(409);
    expect(await res.json()).toStrictEqual({
      error: 'Share the app with Team in Grant Access first.',
      code: 'not_in_team',
    });
    expect(h.prefs).toEqual([]);
    expect(h.shares).toBe(0);
  });
});
