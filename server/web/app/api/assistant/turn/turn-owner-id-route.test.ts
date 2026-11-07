/**
 * POST /api/assistant/turn on the owner engine (docs/agent-ui.md, "Turn
 * ids"): an Admin user's streamed turn runs and streams on
 * `turn-<loginId>.<key>`, minted from the session's login, never on the raw
 * Idempotency-Key, and the 202 hands that id back as `{ turnId, stream }`.
 * Two Admin users sending the same key get two turns. A key in a turn
 * namespace never streams. No database or DBOS: the login, the agent and the
 * workflow client are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_A = '55555555-5555-4555-8555-555555555555';
const ADMIN_B = '66666666-6666-4666-8666-666666666666';
const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100';

const h = vi.hoisted(() => ({
  loginId: '',
  enqueued: [] as Array<{ workflowID?: string; input: { options: Record<string, unknown> } }>,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  chatCaller: () => ({
    asLogin: { loginId: h.loginId, admin: true },
    ownerId: 'owner-id',
    loginId: h.loginId,
    source: 'cookie',
    user: { id: 'owner-id', email: '', actor: { id: h.loginId } },
    displayName: null,
    email: 'admin@example.invalid',
  }),
}));
vi.mock('@/lib/assistant-chat', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  chatAdmin: vi.fn(async () => true),
  resolveChatAgentToWrite: vi.fn(async () => ({
    id: 'agent-1',
    slug: 'saskia',
    turnEngine: 'owner',
  })),
}));
vi.mock('@mantle/config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  feature: () => true,
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadProfilePreferences: vi.fn(async () => ({})),
}));
vi.mock('@/lib/dbos-client', () => ({
  getDbosClient: async () => ({
    enqueue: async (o: { workflowID?: string }, input: { options: Record<string, unknown> }) => {
      h.enqueued.push({ ...(o.workflowID ? { workflowID: o.workflowID } : {}), input });
      const row = { id: 'm', text: 't', createdAt: 'now', model: null };
      return {
        getResult: async () => ({ inbound: row, outbound: row, reply: 't', artifacts: [] }),
      };
    },
  }),
}));

const { POST } = await import('./route');

async function send(loginId: string, key: string): Promise<{ status: number; body: unknown }> {
  h.loginId = loginId;
  const res = await POST(
    new Request('https://brain.example.invalid/api/assistant/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ text: 'hello' }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  h.enqueued = [];
});

describe('owner turn ids', () => {
  it("an Admin user's turn streams on turn-<loginId>.<key>, and the 202 says so", async () => {
    const r = await send(ADMIN_A, KEY);
    expect(r).toEqual({ status: 202, body: { turnId: `turn-${ADMIN_A}.${KEY}`, stream: true } });
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]!.workflowID).toBe(`turn-${ADMIN_A}.${KEY}`);
    expect(h.enqueued[0]!.input.options.streamId).toBe(`turn-${ADMIN_A}.${KEY}`);
  });

  it("Admin B sending the same key gets a turn of its own, never Admin A's", async () => {
    const key = '1f0e0d0c-0b0a-4908-8706-050403020100';
    const a = await send(ADMIN_A, key);
    const b = await send(ADMIN_B, key);
    expect((a.body as { turnId: string }).turnId).toBe(`turn-${ADMIN_A}.${key}`);
    expect((b.body as { turnId: string }).turnId).toBe(`turn-${ADMIN_B}.${key}`);
    expect(h.enqueued.map((e) => e.input.options.streamId)).toEqual([
      `turn-${ADMIN_A}.${key}`,
      `turn-${ADMIN_B}.${key}`,
    ]);
  });

  it('a key in a turn namespace (any case) never becomes a stream id', async () => {
    for (const key of [`turn-${ADMIN_B}.${KEY}`, `WS-${ADMIN_B}.${KEY}`]) {
      h.enqueued = [];
      const r = await send(ADMIN_A, key);
      // Not streamed: the blocking answer, and the runner publishes nothing.
      expect(r.status, key).toBe(200);
      expect(h.enqueued[0]!.input.options, key).not.toHaveProperty('streamId');
    }
  });
});
