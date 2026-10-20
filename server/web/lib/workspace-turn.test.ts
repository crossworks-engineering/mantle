/**
 * A chat turn with a workspace assistant (W7c, lib/workspace-turn.ts): the
 * member limits moved here from the retired POST /api/member/chat. The
 * 6-a-minute limit per login, the daily cap and token budget taken when the
 * turn is QUEUED (audit F09), idempotency by key, the member queue (audit
 * F31), and an Admin user unlimited. No database or DBOS: the ledger and the
 * workflow client are faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enqueued: [] as { workflowID: string; queueName: string; input: { text: string } }[],
  firstInput: null as { text: string } | null,
  claim: { ok: true, fresh: true } as
    | { ok: true; fresh: boolean }
    | { ok: false; reason: 'daily_cap' | 'token_budget'; used: number },
  claimed: [] as string[],
  released: [] as string[],
  enqueueFails: false,
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordTeamAccess: vi.fn(),
  claimMemberTurn: vi.fn(async (a: { turnId: string }) => {
    h.claimed.push(a.turnId);
    return h.claim;
  }),
  releaseMemberTurn: vi.fn(async (id: string) => {
    h.released.push(id);
  }),
}));

vi.mock('./dbos-client', () => ({
  getDbosClient: async () => ({
    enqueue: async (opts: { workflowID: string; queueName: string }, input: { text: string }) => {
      if (h.enqueueFails) throw new Error('queue down');
      h.enqueued.push({ ...opts, input });
      h.firstInput ??= input;
      return {};
    },
    getWorkflow: async () => (h.firstInput ? { input: [h.firstInput] } : undefined),
  }),
}));

// Whether the chat login is an Admin user is adminFacts' answer (plan v3.2
// section 2.2), stood in here from the stand-in Login.
vi.mock('./auth/login', () => ({
  adminFacts: vi.fn(async (l: { admin?: boolean }) => ({
    admin: l.admin === true,
    areas: new Set(),
  })),
}));

const OWNER = '33333333-3333-4333-8333-333333333333';
const login = (kind: 'admin' | 'member', loginId: string) =>
  ({
    asLogin: { loginId, admin: kind === 'admin' } as never,
    ownerId: OWNER,
    loginId,
    source: 'web',
    user: {
      id: OWNER,
      email: 'pat@example.invalid',
      actor: { id: loginId, email: 'pat@example.invalid', displayName: 'Pat', isOwner: false },
    },
    displayName: 'Pat',
    email: 'pat@example.invalid',
  }) as const;
const agent = { id: 'agent-1', slug: 'team-responder', turnEngine: 'workspace' } as never;

async function send(
  who: ReturnType<typeof login>,
  text: string,
  key: string | null = null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { queueWorkspaceTurn } = await import('./workspace-turn');
  const r = await queueWorkspaceTurn({ login: who, agent, text, idempotencyKey: key });
  return { status: r.status, body: r.body as Record<string, unknown> };
}

beforeEach(() => {
  h.enqueued = [];
  h.firstInput = null;
  h.claim = { ok: true, fresh: true };
  h.claimed = [];
  h.released = [];
  h.enqueueFails = false;
});

describe('workspace turns: the per-minute limit', () => {
  it('six messages a minute per login; the seventh is a 429 with Retry-After', async () => {
    const who = login('member', '22222222-2222-4222-8222-222222222222');
    for (let i = 1; i <= 6; i++) expect((await send(who, `message ${i}`)).status).toBe(202);
    const { queueWorkspaceTurn } = await import('./workspace-turn');
    const seventh = await queueWorkspaceTurn({
      login: who,
      agent,
      text: 'message 7',
      idempotencyKey: null,
    });
    expect(seventh.status).toBe(429);
    expect(Number(new Headers(seventh.headers).get('retry-after'))).toBeGreaterThan(0);
    expect(h.enqueued).toHaveLength(6);
  });

  it('the limit is per login, and an Admin user is not limited or ledgered', async () => {
    expect((await send(login('member', '44444444-4444-4444-8444-444444444444'), 'hi')).status).toBe(
      202,
    );
    const admin = login('admin', '55555555-5555-4555-8555-555555555555');
    for (let i = 1; i <= 8; i++) expect((await send(admin, `a ${i}`)).status).toBe(202);
    expect(h.claimed).toHaveLength(1);
  });
});

describe('workspace turns: idempotency and the queue', () => {
  it('names the login in the turn id and runs on the member queue', async () => {
    const r = await send(login('member', '66666666-6666-4666-8666-666666666666'), 'q', 'k1');
    expect(r.status).toBe(202);
    expect(h.enqueued[0]!.workflowID).toBe('ws-66666666-6666-4666-8666-666666666666.k1');
    expect(h.enqueued[0]!.queueName).toBe('mantle.member');
    expect(r.body.turnId).toBe('ws-66666666-6666-4666-8666-666666666666.k1');
  });

  it('the same key with new text is a 409, not a silent drop', async () => {
    const who = login('member', '77777777-7777-4777-8777-777777777777');
    expect((await send(who, 'first', 'k2')).status).toBe(202);
    const again = await send(who, 'other text', 'k2');
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe('idempotency-key-reused');
  });
});

describe('workspace turns: the daily budget (audit F09)', () => {
  it('refuses past the daily cap before anything is queued', async () => {
    h.claim = { ok: false, reason: 'daily_cap', used: 200 };
    const r = await send(login('member', '88888888-8888-4888-8888-888888888888'), 'q');
    expect(r.status).toBe(429);
    expect(r.body.reason).toBe('daily_cap');
    expect(h.enqueued).toHaveLength(0);
  });

  it('gives the slot back when the enqueue fails', async () => {
    h.enqueueFails = true;
    const r = await send(login('member', '99999999-9999-4999-8999-999999999999'), 'q', 'k3');
    expect(r.status).toBe(500);
    expect(h.released).toEqual(['ws-99999999-9999-4999-8999-999999999999.k3']);
  });
});
