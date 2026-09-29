/**
 * POST /api/member/chat and the Idempotency-Key, without a database or DBOS:
 * the workflow store is a map with DBOS's rule (an enqueue under an id that
 * exists keeps the first input and drops the new one). A retry with the same
 * key and text is the same turn; the same key with NEW text must not vanish
 * behind a 202, so it is a 409.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  workflows: new Map<string, unknown[]>(),
  enqueued: [] as string[],
  queues: [] as string[],
  // The turn ledger (member-turn-ledger.ts) as a set of turn ids, with the
  // real claim rule: a known id is the same turn, else the cap applies.
  ledger: new Set<string>(),
  cap: 100,
  overBudget: false,
  enqueueFails: false,
  released: [] as string[],
  audience: 'team',
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
    limit: async () => [{ slug: 'team-responder', name: 'Team', audience: h.audience }],
  };
  return { ...actual, db: { select: () => chain } };
});

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimMemberTurn: vi.fn(async ({ turnId }: { turnId: string }) => {
    if (h.ledger.has(turnId)) return { ok: true, fresh: false };
    if (h.ledger.size >= h.cap) return { ok: false, reason: 'daily_cap', used: h.ledger.size };
    if (h.overBudget) return { ok: false, reason: 'token_budget', used: 9_999_999 };
    h.ledger.add(turnId);
    return { ok: true, fresh: true };
  }),
  releaseMemberTurn: vi.fn(async (turnId: string) => {
    h.released.push(turnId);
    h.ledger.delete(turnId);
  }),
  listTeamThread: vi.fn(async () => []),
  recordTeamAccess: vi.fn(),
}));

// The 6-a-minute limit is not under test here.
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rateLimit: () => ({ ok: true, remaining: 1, retryAfterSec: 0 }),
}));

vi.mock('@/lib/dbos-client', () => ({
  getDbosClient: async () => ({
    enqueue: async (opts: { workflowID: string; queueName: string }, ...args: unknown[]) => {
      if (h.enqueueFails) throw new Error('system database unreachable');
      h.enqueued.push(opts.workflowID);
      h.queues.push(opts.queueName);
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

// The route pulls in the runtime package: a cold import takes seconds.
beforeAll(async () => {
  await import('./route');
}, 60_000);

beforeEach(() => {
  h.workflows.clear();
  h.enqueued = [];
  h.queues = [];
  h.ledger.clear();
  h.cap = 100;
  h.overBudget = false;
  h.enqueueFails = false;
  h.released = [];
  h.audience = 'team';
});

describe('POST /api/member/chat: the agent must be at team level (client logins C4)', () => {
  for (const audience of ['admin', 'client', 'public']) {
    it(`team-responder at ${audience}: 409, nothing queued`, async () => {
      h.audience = audience;
      expect((await send('hello')).status).toBe(409);
      expect(h.enqueued).toEqual([]);
    });
  }
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

describe('POST /api/member/chat budget (audit F09)', () => {
  it('counts a turn when it is queued, and a same-key retry only once', async () => {
    expect((await send('hello', 'key-cccc-3333')).status).toBe(202);
    expect((await send('hello', 'key-cccc-3333')).status).toBe(202);
    expect(h.ledger.size).toBe(1);
  });

  it('refuses past the daily cap before anything is queued', async () => {
    h.cap = 2;
    expect((await send('one')).status).toBe(202);
    expect((await send('two')).status).toBe(202);
    const third = await send('three');
    expect(third.status).toBe(429);
    expect(((await third.json()) as { reason: string }).reason).toBe('daily_cap');
    expect(h.enqueued).toHaveLength(2);
  });

  it('still admits a retry of a queued turn once the cap is reached', async () => {
    h.cap = 1;
    expect((await send('only', 'key-dddd-4444')).status).toBe(202);
    expect((await send('only', 'key-dddd-4444')).status).toBe(202);
  });

  it('refuses over the token budget with a clear 429', async () => {
    h.overBudget = true;
    const res = await send('hello');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { reason: string; error: string };
    expect(body.reason).toBe('token_budget');
    expect(body.error).toMatch(/daily usage limit/);
    expect(h.enqueued).toEqual([]);
  });

  it('gives the slot back when the enqueue fails', async () => {
    h.enqueueFails = true;
    const res = await send('hello', 'key-eeee-5555');
    expect(res.status).toBe(500);
    expect(h.released).toEqual([`member-${LOGIN}.key-eeee-5555`]);
    expect(h.ledger.size).toBe(0);
  });
});

describe('member turns run on their own queue (audit F31)', () => {
  it('enqueues on MEMBER_TURN_QUEUE, never the owner queue', async () => {
    const { MEMBER_TURN_QUEUE, RUNNER_QUEUE } = await import('@mantle/runtime/assistant');
    expect((await send('hello')).status).toBe(202);
    expect(h.queues).toEqual([MEMBER_TURN_QUEUE]);
    expect(MEMBER_TURN_QUEUE).not.toBe(RUNNER_QUEUE);
  });
});

describe('GET /api/member/chat', () => {
  it('no longer answers the one-cycle `linked` field', async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://x/api/member/chat'));
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['agent', 'messages']);
  });

  it('strips NUL from the message before it is queued (audit F14)', async () => {
    expect((await send('a\u0000b')).status).toBe(202);
    const [input] = [...h.workflows.values()][0] as [{ text: string }];
    expect(input.text).toBe('ab');
  });
});
