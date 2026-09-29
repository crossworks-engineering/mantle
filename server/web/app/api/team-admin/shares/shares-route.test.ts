/**
 * GET /api/team-admin/shares without a database (client logins C1, audit
 * A18): every row carries its item's `level` in the one answer, so the
 * Shared-links tab needs no second call to tell an old client link (from
 * when client meant an open link) from a public one.
 */
import { describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: ANCHOR, email: 'admin@example.invalid' })),
}));

vi.mock('@/lib/team-admin-overview', () => ({
  teamAdminBadges: vi.fn(async () => ({ openRequestCount: 0 })),
}));

const row = (id: string, level: string) => ({
  id,
  token: `tok-${id}`,
  nodeId: `node-${id}`,
  nodeType: 'page',
  mode: 'public',
  cascade: false,
  createdAt: '2026-09-29T00:00:00.000Z',
  expiresAt: null,
  viewCount: 1,
  title: `Item ${id}`,
  level,
  nodeIcon: null,
  nodePath: null,
  lastViewedAt: null,
});

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  listActiveShares: vi.fn(async () => [row('a', 'public'), row('b', 'client')]),
}));

describe('GET /api/team-admin/shares', () => {
  it('gives every row its item level', async () => {
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shares: { id: string; level?: string }[] };
    expect(body.shares.map((s) => [s.id, s.level])).toEqual([
      ['a', 'public'],
      ['b', 'client'],
    ]);
  });
});
