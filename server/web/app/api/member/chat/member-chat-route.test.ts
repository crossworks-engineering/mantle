/**
 * POST /api/member/chat and the Idempotency-Key, without a database or DBOS:
 * the workflow store is a map with DBOS's rule (an enqueue under an id that
 * exists keeps the first input and drops the new one). A retry with the same
 * key and text is the same turn; the same key with NEW text must not vanish
 * behind a 202, so it is a 409.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  workflows: new Map<string, unknown[]>(),
  enqueued: [] as string[],
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMemberOr401: vi.fn(async () => ({
    role: 'member',
    loginId: LOGIN,
    anchorId: ANCHOR,
    spaceId: '66666666-6666-4666-8666-666666666666',
    email: 'pat@example.invalid',
    displayName: 'Pat',
    contactId: null,
  })),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // memberAgent: team-responder, set below admin.
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

// The 6-a-minute limit is not under test here.
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rateLimit: () => ({ ok: true, remaining: 1, retryAfterSec: 0 }),
}));

vi.mock('@/lib/dbos-client', () => ({
  getDbosClient: async () => ({
    enqueue: async (opts: { workflowID: string }, ...args: unknown[]) => {
      h.enqueued.push(opts.workflowID);
      if (!h.workflows.has(opts.workflowID)) h.workflows.set(opts.workflowID, args);
      return {};
    },
    getWorkflow: async (id: string) =>
      h.workflows.has(id) ? { workflowID: id, input: h.workflows.get(id) } : undefined,
  }),
}));

const send = async (text: string, key?: string) => {
  const { POST } = await import('./route');
  return POST(
    new Request('http://x/api/member/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify({ text }),
    }),
  );
};

beforeEach(() => {
  h.workflows.clear();
  h.enqueued = [];
});

describe('POST /api/member/chat idempotency', () => {
  it('a retry with the same key and text is the same turn (202 both times)', async () => {
    const a = await send('hello there', 'key-aaaa-1111');
    const b = await send('hello there', 'key-aaaa-1111');
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const idA = ((await a.json()) as { turnId: string }).turnId;
    expect(((await b.json()) as { turnId: string }).turnId).toBe(idA);
    expect(idA).toBe(`member-${LOGIN}.key-aaaa-1111`);
    expect(h.workflows.size).toBe(1);
  });

  it('the same key with NEW text is a 409, not a silent drop', async () => {
    expect((await send('first message', 'key-bbbb-2222')).status).toBe(202);
    const second = await send('a different message', 'key-bbbb-2222');
    expect(second.status).toBe(409);
    const body = (await second.json()) as { reason?: string };
    expect(body.reason).toBe('idempotency-key-reused');
    // The first turn is untouched.
    expect(h.workflows.get(`member-${LOGIN}.key-bbbb-2222`)?.[0]).toMatchObject({
      text: 'first message',
    });
  });

  it('without a key every send is its own turn', async () => {
    const a = await send('one');
    const b = await send('one');
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(h.workflows.size).toBe(2);
  });
});
