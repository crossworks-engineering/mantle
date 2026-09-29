/**
 * GET /api/team-admin/shares (client logins C3) without a database: the live
 * links with their level, and the retired old client links, shaped for
 * jackdaw, never with a token for a retired one. An admin route: members and
 * clients are refused by getOwnerOr401 (the sweeps drive every route).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
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
      level: 'public',
    },
  ]),
  listRetiredClientLinks: vi.fn(async () => [
    {
      id: 's2',
      nodeId: 'n2',
      nodeType: 'note',
      title: 'Old client note',
      nodeIcon: '📄',
      level: 'client',
      createdAt: '2026-05-01T00:00:00.000Z',
      retiredAt: '2026-09-29T00:00:00.000Z',
      viewCount: 12,
      lastViewedAt: '2026-09-20T00:00:00.000Z',
    },
  ]),
}));

describe('GET /api/team-admin/shares', () => {
  it('lists live links and the retired old client links, without a token for those', async () => {
    const { GET } = await import('./route');
    const body = await (await GET()).json();
    expect(body.shares).toEqual([
      expect.objectContaining({ id: 's1', path: '/s/live-token', level: 'public' }),
    ]);
    expect(body.retired).toEqual([
      {
        id: 's2',
        nodeId: 'n2',
        nodeType: 'note',
        title: 'Old client note',
        icon: '📄',
        level: 'client',
        createdAt: '2026-05-01T00:00:00.000Z',
        retiredAt: '2026-09-29T00:00:00.000Z',
        viewCount: 12,
        lastViewedAt: '2026-09-20T00:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(body.retired)).not.toMatch(/\/s\//);
  });
});
