/**
 * POST /api/assistant/turn/:turnId/ui/:callId, the window's answer to one
 * agent UI call (docs/agent-ui.md), without a database: the owner is stood
 * in and the answer's outcome is the one @mantle/db answerUiCall gives (its
 * WHERE is the rule: ui-calls.db.test.ts). Pinned here: the login, turn and
 * window the route hands it, and each refusal's status: another login's,
 * another turn's or another window's call 404 with no detail, an expired or
 * second answer 409, an oversized result 413, a bad body 400.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_UI_RESULT_MAX_BYTES } from '@mantle/client-types/agent-ui';

const LOGIN = '22222222-2222-4222-8222-222222222222';
const CALL = '33333333-3333-4333-8333-333333333333';
const WINDOW = 'win_abcdefgh';

const h = vi.hoisted(() => ({
  outcome: 'done' as string,
  asked: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: () => ({ id: 'owner-id', actor: { id: LOGIN } }),
}));

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  answerUiCall: async (a: Record<string, unknown>) => {
    h.asked.push(a);
    return h.outcome;
  },
}));

const { POST } = await import('./route');

const post = (body: unknown, callId = CALL, turnId = 'turn-1') =>
  POST(
    new Request(`http://brain.invalid/api/assistant/turn/${turnId}/ui/${callId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ turnId, callId }) },
  );

beforeEach(() => {
  h.outcome = 'done';
  h.asked = [];
});

describe('POST /api/assistant/turn/:turnId/ui/:callId', () => {
  it("answers with the session's login, the path's turn and the body's window", async () => {
    const res = await post({ windowId: WINDOW, result: { ok: true, route: '/pages' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.asked).toEqual([
      {
        callId: CALL,
        turnId: 'turn-1',
        loginId: LOGIN,
        windowId: WINDOW,
        result: { ok: true, route: '/pages' },
      },
    ]);
  });

  it("another login's call, another turn's or another window's: 404 with no detail", async () => {
    h.outcome = 'not_found';
    const res = await post({ windowId: 'win_other000', result: { ok: true } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('a call id that is not a uuid is 404 before any lookup', async () => {
    const res = await post({ windowId: WINDOW, result: { ok: true } }, 'nope');
    expect(res.status).toBe(404);
    expect(h.asked).toEqual([]);
  });

  it('a second answer, or an expired call: 409 with no detail', async () => {
    for (const outcome of ['answered', 'expired']) {
      h.outcome = outcome;
      const res = await post({ windowId: WINDOW, result: { ok: true } });
      expect(res.status, outcome).toBe(409);
      expect(await res.json()).toEqual({ error: 'conflict' });
    }
  });

  it('a result over 64 KB is 413 and answers nothing', async () => {
    const big = { ok: true, text: 'z'.repeat(AGENT_UI_RESULT_MAX_BYTES) };
    const res = await post({ windowId: WINDOW, result: big });
    expect(res.status).toBe(413);
    expect(h.asked).toEqual([]);
  });

  it('a bad window id or a result that is not an object is 400', async () => {
    expect((await post({ windowId: 'short', result: { ok: true } })).status).toBe(400);
    expect((await post({ windowId: WINDOW, result: 'ok' })).status).toBe(400);
    expect((await post({ result: { ok: true } })).status).toBe(400);
    expect(h.asked).toEqual([]);
  });
});
