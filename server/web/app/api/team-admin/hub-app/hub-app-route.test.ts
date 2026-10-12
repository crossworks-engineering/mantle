/**
 * PUT and DELETE /api/team-admin/hub-app without a database: removed with
 * per-workspace landing pages (task d78e7bde). Each answers 410 `gone` after
 * the old owner guard, and changes no preference: the home app is a
 * workspace setting now (PATCH /api/workspaces/:id `landingAppId`).
 */
import { describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({ prefs: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: ANCHOR, email: 'admin@example.invalid' })),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  updateProfilePreferences: vi.fn(async (_owner: string, p: Record<string, unknown>) => {
    h.prefs.push(p);
  }),
}));

describe('/api/team-admin/hub-app (gone)', () => {
  it('PUT and DELETE answer 410 and write no preference', async () => {
    const { PUT, DELETE } = await import('./route');
    for (const handler of [PUT, DELETE]) {
      const res = await handler();
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ code: 'gone' });
    }
    expect(h.prefs).toEqual([]);
  });
});
