/**
 * GET /api/users without a database: the answer is exactly
 * `{ users, currentActorId }`. `membersEnabled` (always true since member
 * logins Phase 6, kept one contract cycle for older clients) is gone.
 */
import { describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: ANCHOR, actor: { id: ANCHOR } })),
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
    db: { select: () => chain },
  };
});

describe('GET /api/users', () => {
  it('answers { users, currentActorId } and no membersEnabled', async () => {
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['currentActorId', 'users']);
    expect(body.currentActorId).toBe(ANCHOR);
    expect(body.users).toEqual([expect.objectContaining({ id: ANCHOR, agent: null })]);
  });
});
