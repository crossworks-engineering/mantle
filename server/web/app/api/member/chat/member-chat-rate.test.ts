/**
 * POST /api/member/chat: the 6-a-minute limit, per login, with the REAL
 * limiter (the idempotency test mocks it away). Without a database or DBOS:
 * the agent lookup, the daily cap and the workflow client are faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ login: '', enqueued: 0 }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMemberOr401: vi.fn(async () => ({
    role: 'member',
    loginId: h.login,
    anchorId: '33333333-3333-4333-8333-333333333333',
    spaceId: '66666666-6666-4666-8666-666666666666',
    email: 'pat@example.invalid',
    displayName: 'Pat',
    contactId: null,
  })),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [{ slug: 'team-responder', name: 'Team', audience: 'team' }],
  };
  return { ...actual, db: { select: () => chain } };
});

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countMemberInboundSince: vi.fn(async () => 0),
  recordTeamAccess: vi.fn(),
}));

vi.mock('@/lib/dbos-client', () => ({
  getDbosClient: async () => ({
    enqueue: async () => {
      h.enqueued += 1;
      return {};
    },
    getWorkflow: async () => undefined,
  }),
}));

const send = async (text: string) => {
  const { POST } = await import('./route');
  return POST(
    new Request('http://x/api/member/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }),
  );
};

beforeEach(() => {
  h.enqueued = 0;
});

describe('POST /api/member/chat rate limit', () => {
  it('six messages a minute per login; the seventh is a 429 with Retry-After', async () => {
    h.login = '22222222-2222-4222-8222-222222222222';
    for (let i = 1; i <= 6; i++) expect((await send(`message ${i}`)).status).toBe(202);
    const seventh = await send('message 7');
    expect(seventh.status).toBe(429);
    expect(Number(seventh.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(h.enqueued).toBe(6);
  });

  it('the limit is per login: another member is not held up', async () => {
    h.login = '44444444-4444-4444-8444-444444444444';
    expect((await send('hello')).status).toBe(202);
    expect(h.enqueued).toBe(1);
  });
});
