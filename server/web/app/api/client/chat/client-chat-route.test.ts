/**
 * GET/POST /api/client/chat (client logins C4), without a database or DBOS.
 * Pins the route's side of the client chat guarantees:
 *   - the chat is open only while client-responder is EXACTLY at client level
 *     (admin, team or public: 409 chat-closed, nothing queued, no slot taken);
 *   - a turn is queued on the CLIENT queue as the client workflow,
 *     partitioned by the login (one turn in flight per login), with the
 *     session's epoch, the login from the session, and the member caps taken
 *     from the ledger first;
 *   - the Idempotency-Key rules of the member chat;
 *   - GET reads the session login's own thread, its pictures rewritten for
 *     a client (chatTextsForReader at the client level, client logins C6).
 * The client gate itself (members and admins refused) is the client sweep's.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const LOGIN = '22222222-2222-4222-8222-222222222222';
const ANCHOR = '33333333-3333-4333-8333-333333333333';

type Enqueued = {
  workflowName: string;
  queueName: string;
  workflowID: string;
  queuePartitionKey?: string;
};

const h = vi.hoisted(() => ({
  workflows: new Map<string, unknown[]>(),
  enqueued: [] as Enqueued[],
  ledger: new Set<string>(),
  claims: [] as { loginId: string; limits: unknown }[],
  cap: 100,
  overBudget: false,
  enqueueFails: false,
  released: [] as string[],
  agent: { slug: 'client-responder', name: 'Client Responder', audience: 'client' } as {
    slug: string;
    name: string;
    audience: string;
  } | null,
  threadCalls: [] as unknown[],
  readerCalls: [] as unknown[][],
  rateOk: true,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getClientOr401: vi.fn(async () => ({
    role: 'client',
    loginId: LOGIN,
    anchorId: ANCHOR,
    spaceId: '66666666-6666-4666-8666-666666666666',
    email: 'casey@example.invalid',
    displayName: 'Casey',
    sessionEpoch: 7,
  })),
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (h.agent ? [h.agent] : []),
  };
  return { ...actual, db: { select: () => chain } };
});

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimMemberTurn: vi.fn(
    async ({ turnId, loginId, limits }: { turnId: string; loginId: string; limits: unknown }) => {
      h.claims.push({ loginId, limits });
      if (h.ledger.has(turnId)) return { ok: true, fresh: false };
      if (h.ledger.size >= h.cap) return { ok: false, reason: 'daily_cap', used: h.ledger.size };
      if (h.overBudget) return { ok: false, reason: 'token_budget', used: 9_999_999 };
      h.ledger.add(turnId);
      return { ok: true, fresh: true };
    },
  ),
  releaseMemberTurn: vi.fn(async (turnId: string) => {
    h.released.push(turnId);
    h.ledger.delete(turnId);
  }),
  listTeamThread: vi.fn(async (...args: unknown[]) => {
    h.threadCalls.push(args);
    return [
      {
        id: 'm1',
        direction: 'outbound',
        text: 'hello',
        status: 'failed',
        error: 'provider said no',
        createdAt: new Date('2026-09-29T10:00:00Z'),
      },
    ];
  }),
  recordTeamAccess: vi.fn(),
  // The rewrite itself is chat-images.test.ts's (and on Postgres,
  // chat-images.viewer.db.test.ts): here, that the route sends its output.
  chatTextsForReader: vi.fn(async (...args: unknown[]) => {
    h.readerCalls.push(args);
    return (args[2] as string[]).map((t) => `${t} [for the client]`);
  }),
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rateLimit: (key: string) =>
    h.rateOk && key === `client-turn:${LOGIN}`
      ? { ok: true, remaining: 1, retryAfterSec: 0 }
      : { ok: false, remaining: 0, retryAfterSec: 30 },
}));

vi.mock('@/lib/dbos-client', () => ({
  getDbosClient: async () => ({
    enqueue: async (opts: Enqueued, ...args: unknown[]) => {
      if (h.enqueueFails) throw new Error('system database unreachable');
      h.enqueued.push(opts);
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
    new Request('http://x/api/client/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify({ text }),
    }),
  );
};

beforeAll(async () => {
  await import('./route');
}, 60_000);

beforeEach(() => {
  h.workflows.clear();
  h.enqueued = [];
  h.ledger.clear();
  h.claims = [];
  h.cap = 100;
  h.overBudget = false;
  h.enqueueFails = false;
  h.released = [];
  h.agent = { slug: 'client-responder', name: 'Client Responder', audience: 'client' };
  h.threadCalls = [];
  h.rateOk = true;
});

describe('POST /api/client/chat: the agent must be at client level', () => {
  for (const audience of ['admin', 'team', 'public']) {
    it(`client-responder at ${audience}: 409 chat-closed, nothing queued, no slot taken`, async () => {
      h.agent = { slug: 'client-responder', name: 'Client Responder', audience };
      const res = await send('hello');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { reason?: string }).reason).toBe('chat-closed');
      expect(h.enqueued).toEqual([]);
      expect(h.claims).toEqual([]);
    });
  }

  it('no client-responder at all (missing or disabled): 409 chat-closed', async () => {
    h.agent = null;
    expect((await send('hello')).status).toBe(409);
    expect(h.enqueued).toEqual([]);
  });
});

describe('POST /api/client/chat: the queued turn', () => {
  it('is the client workflow on the client queue, partitioned by the login, with the session epoch', async () => {
    const res = await send('what is the shutdown date?', 'key-cccc-3333');
    expect(res.status).toBe(202);
    expect(h.enqueued).toHaveLength(1);
    const q = h.enqueued[0]!;
    expect(q.workflowName).toBe('clientTurnWorkflow');
    expect(q.queueName).toBe('mantle.client');
    expect(q.queuePartitionKey).toBe(LOGIN);
    expect(q.workflowID).toBe(`client-${LOGIN}.key-cccc-3333`);
    const input = h.workflows.get(q.workflowID)?.[0] as {
      ownerId: string;
      text: string;
      options: Record<string, unknown>;
    };
    expect(input.ownerId).toBe(ANCHOR);
    expect(input.options).toMatchObject({
      loginId: LOGIN,
      sessionEpoch: 7,
      agentSlug: 'client-responder',
      contactName: 'Casey',
    });
  });

  it('takes the member caps for this login from the ledger before queuing', async () => {
    await send('hi');
    expect(h.claims).toHaveLength(1);
    expect(h.claims[0]!.loginId).toBe(LOGIN);
    expect(h.claims[0]!.limits).toEqual({
      dailyTurns: expect.any(Number),
      dailyTokens: expect.any(Number),
    });
  });

  it('the daily cap and the token budget refuse with 429 and queue nothing', async () => {
    h.cap = 0;
    const capped = await send('one more');
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { reason?: string }).reason).toBe('daily_cap');
    h.cap = 100;
    h.overBudget = true;
    const budget = await send('and another');
    expect(budget.status).toBe(429);
    expect(((await budget.json()) as { reason?: string }).reason).toBe('token_budget');
    expect(h.enqueued).toEqual([]);
  });

  it('6 a minute per client login: 429 rate-limited before any claim', async () => {
    h.rateOk = false;
    const res = await send('fast');
    expect(res.status).toBe(429);
    expect(((await res.json()) as { reason?: string }).reason).toBe('rate-limited');
    expect(h.claims).toEqual([]);
  });

  it('a failed enqueue gives the slot back', async () => {
    h.enqueueFails = true;
    expect((await send('lost')).status).toBe(500);
    expect(h.released).toHaveLength(1);
  });

  it('the same key with new text is a 409; the same text is the same turn', async () => {
    expect((await send('first', 'key-dddd-4444')).status).toBe(202);
    expect((await send('first', 'key-dddd-4444')).status).toBe(202);
    const again = await send('second', 'key-dddd-4444');
    expect(again.status).toBe(409);
    expect(((await again.json()) as { reason?: string }).reason).toBe('idempotency-key-reused');
    expect(h.workflows.size).toBe(1);
  });
});

describe('GET /api/client/chat', () => {
  it("reads the session login's own thread, with no internals", async () => {
    const { GET } = await import('./route');
    const res = await GET(new Request('http://x/api/client/chat?before=2026-09-29T11:00:00Z'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: unknown; messages: Record<string, unknown>[] };
    expect(body.agent).toEqual({ name: 'Client Responder' });
    expect(body.messages[0]).toEqual({
      id: 'm1',
      direction: 'outbound',
      text: 'hello [for the client]',
      status: 'failed',
      failed: true,
      createdAt: '2026-09-29T10:00:00.000Z',
    });
    const [anchor, contact, opts] = h.threadCalls[0] as [string, string, Record<string, unknown>];
    expect(anchor).toBe(ANCHOR);
    expect(contact).toBe('');
    expect(opts).toMatchObject({ loginId: LOGIN, before: '2026-09-29T11:00:00Z' });
    // The pictures are rewritten for this brain, at the client level.
    expect(h.readerCalls.at(-1)).toEqual([ANCHOR, 'client', ['hello']]);
  });

  it('agent null while client-responder is not at client level', async () => {
    h.agent = { slug: 'client-responder', name: 'Client Responder', audience: 'team' };
    const { GET } = await import('./route');
    const body = (await (await GET(new Request('http://x/api/client/chat'))).json()) as {
      agent: unknown;
    };
    expect(body.agent).toBeNull();
  });
});
