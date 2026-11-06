/**
 * A member's turn on its own stream, Stop and ui answer (docs/agent-ui.md,
 * "Members"): GET .../stream, POST .../cancel and POST .../ui/:callId are
 * open to the login that sent the turn, whatever its role, and to no other
 * (404, no detail, nothing subscribed, published or answered). An Admin
 * user keeps its own turns; a member never reaches an Admin user's turn id.
 * No database: the chat login, the Admin answer, the realtime bridge, the
 * buffer and the writes are stood in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnEvent } from '@mantle/client-types';

const MEMBER = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const OWNER = '33333333-3333-4333-8333-333333333333';
const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100';
const CALL = '66666666-6666-4666-8666-666666666666';
const WINDOW = 'win_abcdefgh';
const MEMBER_TURN = `ws-${MEMBER}.${KEY}`;

const h = vi.hoisted(() => ({
  login: { loginId: '', admin: false },
  subscribed: [] as string[],
  live: null as ((e: TurnEvent) => void) | null,
  buffered: [] as TurnEvent[],
  cancels: [] as string[],
  expired: [] as Array<{ turnId: string; loginId: string }>,
  answered: [] as Array<Record<string, unknown>>,
  superseded: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  chatCaller: () => ({
    ownerId: '33333333-3333-4333-8333-333333333333',
    loginId: h.login.loginId,
    asLogin: { admin: h.login.admin },
  }),
}));

vi.mock('@/lib/assistant-chat', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  chatAdmin: vi.fn(async (l: { asLogin: { admin: boolean } }) => l.asLogin.admin),
}));

vi.mock('@/lib/realtime', () => ({
  subscribeTurnStream: vi.fn(
    async (ownerId: string, turnId: string, fn: (e: TurnEvent) => void) => {
      h.subscribed.push(`${ownerId} ${turnId}`);
      h.live = fn;
      return () => {
        h.live = null;
      };
    },
  ),
}));

vi.mock('@mantle/turn-stream', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBufferedTurnEvents: vi.fn(async () => h.buffered),
  publishTurnCancel: vi.fn(async (ownerId: string, turnId: string) => {
    h.cancels.push(`${ownerId} ${turnId}`);
  }),
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  expireTurnUiCalls: vi.fn(async (p: { turnId: string; loginId: string }) => {
    h.expired.push(p);
    return 0;
  }),
  answerUiCall: vi.fn(async (a: Record<string, unknown>) => {
    h.answered.push(a);
    return 'done';
  }),
}));

vi.mock('@mantle/runtime/agent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  markTurnSuperseded: vi.fn(async (a: Record<string, unknown>) => {
    h.superseded.push(a);
    return 2;
  }),
}));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadProfilePreferences: vi.fn(async () => ({})),
}));

vi.mock('@mantle/config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  feature: () => true,
}));

const stream = await import('./stream/route');
const cancel = await import('./cancel/route');
const ui = await import('./ui/[callId]/route');

const as = (loginId: string, admin = false) => {
  h.login = { loginId, admin };
};

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): TurnEvent =>
  ({ v: 1, turnId: MEMBER_TURN, seq, round: 0, type, data }) as unknown as TurnEvent;

const openStream = (turnId: string) =>
  stream.GET(new Request(`http://brain.invalid/api/assistant/turn/${turnId}/stream`), {
    params: Promise.resolve({ turnId }),
  });

const stop = (turnId: string, body?: unknown) =>
  cancel.POST(
    new Request(`http://brain.invalid/api/assistant/turn/${turnId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({ turnId }) },
  );

const answer = (turnId: string) =>
  ui.POST(
    new Request(`http://brain.invalid/api/assistant/turn/${turnId}/ui/${CALL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ windowId: WINDOW, result: { ok: true } }),
    }),
    { params: Promise.resolve({ turnId, callId: CALL }) },
  );

/** Read SSE frames until `n` data frames arrived, then close the stream. */
async function frames(res: Response, n: number, during?: () => void): Promise<TurnEvent[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  const out: TurnEvent[] = [];
  let poked = false;
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
    const parts = text.split('\n\n');
    text = parts.pop() ?? '';
    for (const p of parts) {
      const data = p.split('\n').find((l) => l.startsWith('data: '));
      if (data) out.push(JSON.parse(data.slice(6)) as TurnEvent);
    }
    if (!poked && during && h.live) {
      poked = true;
      during();
    }
  }
  await reader.cancel();
  return out;
}

beforeEach(() => {
  h.subscribed = [];
  h.live = null;
  h.buffered = [];
  h.cancels = [];
  h.expired = [];
  h.answered = [];
  h.superseded = [];
});

describe("a member's turn streams to that member", () => {
  it('replays the buffer, then the live events, ui-call among them, in order', async () => {
    as(MEMBER);
    h.buffered = [ev(0, 'turn-start'), ev(1, 'text-delta', { text: 'Hel' })];
    const res = await openStream(MEMBER_TURN);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const got = await frames(res, 4, () => {
      h.live!(ev(2, 'ui-call', { callId: CALL, action: 'screen', args: {}, expiresAt: 'soon' }));
      h.live!(ev(3, 'done'));
    });
    expect(got.map((e) => `${e.seq}:${e.type}`)).toEqual([
      '0:turn-start',
      '1:text-delta',
      '2:ui-call',
      '3:done',
    ]);
    expect(h.subscribed).toEqual([`${OWNER} ${MEMBER_TURN}`]);
  });

  it('another member gets 404 with no detail, and nothing is subscribed', async () => {
    as(OTHER);
    const res = await openStream(MEMBER_TURN);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(h.subscribed).toEqual([]);
  });

  it("an Admin user gets the same 404 on a member's turn", async () => {
    as(ADMIN, true);
    expect((await openStream(MEMBER_TURN)).status).toBe(404);
    expect(h.subscribed).toEqual([]);
  });

  it("an Admin user keeps its own turn's stream; a member never reaches it (Admin-only stays Admin-only)", async () => {
    as(ADMIN, true);
    const mine = await openStream(KEY);
    expect(mine.status).toBe(200);
    await mine.body?.cancel();
    expect(h.subscribed).toEqual([`${OWNER} ${KEY}`]);
    as(MEMBER);
    const res = await openStream(KEY);
    expect(res.status).toBe(404);
    expect(h.subscribed).toHaveLength(1);
  });
});

describe("a member's Stop", () => {
  it('stops its own turn: the cancel is published and its open ui calls given up, as its login', async () => {
    as(MEMBER);
    const res = await stop(MEMBER_TURN);
    expect(res.status).toBe(200);
    expect(h.cancels).toEqual([`${OWNER} ${MEMBER_TURN}`]);
    expect(h.expired).toEqual([{ turnId: MEMBER_TURN, loginId: MEMBER }]);
  });

  it("supersedes in its own thread only (the session's login, never the body's)", async () => {
    as(MEMBER);
    const ids = {
      inboundId: '77777777-7777-4777-8777-777777777771',
      outboundId: '77777777-7777-4777-8777-777777777772',
      newTurnId: '77777777-7777-4777-8777-777777777773',
    };
    const res = await stop(MEMBER_TURN, { supersede: ids, loginId: OTHER });
    expect(await res.json()).toEqual({ ok: true, superseded: 2 });
    expect(h.superseded).toEqual([{ ownerId: OWNER, loginId: MEMBER, ...ids }]);
  });

  it("another login's turn: 404 with no detail, nothing published, expired or stamped", async () => {
    for (const [who, admin, turn] of [
      [OTHER, false, MEMBER_TURN],
      [ADMIN, true, MEMBER_TURN],
      [MEMBER, false, KEY],
    ] as const) {
      as(who, admin);
      const res = await stop(turn, {
        supersede: {
          inboundId: '77777777-7777-4777-8777-777777777771',
          outboundId: '77777777-7777-4777-8777-777777777772',
          newTurnId: '77777777-7777-4777-8777-777777777773',
        },
      });
      expect(res.status, `${who} ${turn}`).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
    expect(h.cancels).toEqual([]);
    expect(h.expired).toEqual([]);
    expect(h.superseded).toEqual([]);
  });

  it('an Admin user still stops its own turn', async () => {
    as(ADMIN, true);
    expect((await stop(KEY)).status).toBe(200);
    expect(h.cancels).toEqual([`${OWNER} ${KEY}`]);
    expect(h.expired).toEqual([{ turnId: KEY, loginId: ADMIN }]);
  });
});

describe("a member's window answers its turn's ui call", () => {
  it("answers with the session's login on its own turn", async () => {
    as(MEMBER);
    const res = await answer(MEMBER_TURN);
    expect(res.status).toBe(200);
    expect(h.answered).toEqual([
      {
        callId: CALL,
        turnId: MEMBER_TURN,
        loginId: MEMBER,
        windowId: WINDOW,
        result: { ok: true },
      },
    ]);
  });

  it("another login's turn: 404 with no detail, before any lookup", async () => {
    for (const [who, admin, turn] of [
      [OTHER, false, MEMBER_TURN],
      [ADMIN, true, MEMBER_TURN],
      [MEMBER, false, KEY],
    ] as const) {
      as(who, admin);
      const res = await answer(turn);
      expect(res.status, `${who} ${turn}`).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
    expect(h.answered).toEqual([]);
  });
});
