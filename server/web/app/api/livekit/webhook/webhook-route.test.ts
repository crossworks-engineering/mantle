/**
 * POST /api/livekit/webhook through the full pipeline (runRoute, the real
 * route file, the real verifier): public at the gate, a body with no or a
 * wrong signature is one 401 and nothing is applied, a signed body is
 * applied once and a replay answers what the store says, a body over 1 MB
 * is the gate's 413, and no reply ever carries the body or the reason.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signLivekitWebhookForTests } from '@mantle/content/livekit';
import { runRoute } from '@/server/run-route';

const KEY = 'APItestkey';
const SECRET = 'a-secret-long-enough-for-the-sdk-to-accept-it';
const ROOM = 'msgr-11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  applied: [] as unknown[],
  outcome: 'applied' as string,
}));

vi.mock('@/lib/messenger', async () => {
  const lk = await import('@mantle/content/livekit');
  return {
    verifyLivekitWebhook: lk.verifyLivekitWebhook,
    applyCallWebhook: vi.fn(async (ev: unknown) => {
      h.applied.push(ev);
      return h.outcome;
    }),
  };
});

const body = JSON.stringify({
  event: 'participant_left',
  id: 'EV_route_1',
  room: { name: ROOM, sid: 'RM_1' },
  participant: { identity: 'login:22222222-2222-4222-8222-222222222222', name: 'Pat' },
  createdAt: 1700000000,
});

const sign = (secret: string, forBody: string) => signLivekitWebhookForTests(forBody, secret, KEY);

const post = (raw: string, authorization?: string) =>
  runRoute(null, 'POST', '/api/livekit/webhook', undefined, {
    rawBody: raw,
    headers: {
      'content-type': 'application/webhook+json',
      ...(authorization ? { authorization } : {}),
    },
  });

describe('POST /api/livekit/webhook', () => {
  beforeAll(() => {
    process.env.MANTLE_LIVEKIT_API_KEY = KEY;
    process.env.MANTLE_LIVEKIT_API_SECRET = SECRET;
  });
  beforeEach(() => {
    h.applied.length = 0;
    h.outcome = 'applied';
  });

  it('refuses an unsigned, a wrongly signed and a tampered body with 401 and applies nothing', async () => {
    const other = 'another-secret-long-enough-for-the-sdk-to-take';
    for (const [raw, auth] of [
      [body, undefined],
      [body, 'Bearer nope'],
      [body, await sign(other, body)],
      [body.replace('EV_route_1', 'EV_route_2'), await sign(SECRET, body)],
      ['{"hello":"world"}', await sign(SECRET, '{"hello":"world"}')],
    ] as const) {
      const res = await post(raw, auth);
      expect(res.status, auth ?? 'no header').toBe(401);
      const text = await res.text();
      expect(text).toBe('{"error":"unauthorized"}');
      expect(text.includes(ROOM)).toBe(false);
    }
    expect(h.applied).toEqual([]);
  });

  it('applies a signed body once, and a replay answers the store\'s "duplicate"', async () => {
    const auth = await sign(SECRET, body);
    const res = await post(body, auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: 'applied' });
    expect(h.applied).toEqual([
      {
        id: 'EV_route_1',
        event: 'participant_left',
        roomName: ROOM,
        participant: { identity: 'login:22222222-2222-4222-8222-222222222222', name: 'Pat' },
        createdAt: 1700000000,
      },
    ]);
    h.outcome = 'duplicate';
    const again = await post(body, auth);
    expect(await again.json()).toEqual({ ok: true, outcome: 'duplicate' });
    expect(h.applied.length).toBe(2);
  });

  it('a body over 1 MB is refused before the handler reads it', async () => {
    const big = body.slice(0, -1) + `,"pad":"${'x'.repeat(1024 * 1024 + 10)}"}`;
    const res = await post(big, await sign(SECRET, big));
    expect(res.status).toBe(413);
    expect(h.applied).toEqual([]);
  });
});
