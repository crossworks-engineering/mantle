/**
 * GET /api/team-admin/shares without a database: the live links (no level
 * since W5b2), shaped for jackdaw. `retired` (the old client links) is always
 * [] since W5c. An admin route: members and clients are refused by the
 * gate's owner answer (the sweeps drive every route).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The route reads the caller the pipeline answers (A4 step 3b part 4).
  ownerCaller: vi.fn(() => ({
    id: 'owner-1',
    email: 'admin@example.invalid',
    actor: { id: 'admin-1', email: 'admin@example.invalid', displayName: null, isOwner: false },
  })),
}));
vi.mock('@/lib/team-admin-overview', () => ({ teamAdminBadges: vi.fn(async () => ({})) }));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listActiveShares: vi.fn(async () => [
    {
      id: 's1',
      token: 'live-token',
      nodeId: 'n1',
      nodeType: 'page',
      title: 'Price list',
      nodeIcon: null,
      mode: 'public',
      cascade: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      viewCount: 3,
      lastViewedAt: null,
    },
  ]),
}));

describe('GET /api/team-admin/shares', () => {
  it('lists live links; retired is always [] (W5c)', async () => {
    const { GET } = await import('./route');
    const body = await (await GET()).json();
    expect(body.shares).toEqual([expect.objectContaining({ id: 's1', path: '/s/live-token' })]);
    expect(body.shares[0]).not.toHaveProperty('level');
    expect(body.retired).toEqual([]);
  });
});
