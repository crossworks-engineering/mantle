/**
 * GET /api/team-admin/clients/usage (client logins C4): every client login,
 * with today's turns and tokens (zeros for one with no use) and the caps.
 * Admin only: members and clients are refused by the role sweeps.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({ id: 'anchor-1' })),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listClientLogins: vi.fn(async () => [{ id: 'c1' }, { id: 'c2' }]),
  clientChatUsageSince: vi.fn(async () => new Map([['c1', { turns: 4, tokens: 1234 }]])),
}));

describe('GET /api/team-admin/clients/usage', () => {
  it('lists every client login with its use today and the member caps', async () => {
    const { GET } = await import('./route');
    const body = (await (await GET()).json()) as {
      limits: { dailyTurns: number; dailyTokens: number };
      rows: unknown[];
    };
    expect(body.limits.dailyTurns).toBeGreaterThan(0);
    expect(body.rows).toEqual([
      { loginId: 'c1', turnsToday: 4, tokensToday: 1234 },
      { loginId: 'c2', turnsToday: 0, tokensToday: 0 },
    ]);
  });
});
