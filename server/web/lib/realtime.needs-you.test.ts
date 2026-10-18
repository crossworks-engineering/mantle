/**
 * The realtime bridge turns a `needs_you_changed` NOTIFY (migration 0186)
 * into an owner change typed `needs_you`, for the owner live stream only:
 * /api/realtime passes it only to a session of the same owner (the member
 * stream carries no events since W8d). The
 * Postgres LISTEN is faked; the bridge and the route filter are the real code.
 * The route runs through the full pipeline (runRoute, A4 step 3b): the gate
 * answers the owner from the stood-in login's session cookie.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runRoute } from '@/server/run-route';
import { standInLogin } from '@/server/run-route-stand-ins';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (payload: string) => void>(),
}));

vi.mock('postgres', () => ({
  default: () => ({
    listen: async (channel: string, cb: (payload: string) => void) => {
      h.handlers.set(channel, cb);
      return { unlisten: async () => h.handlers.delete(channel) };
    },
    end: async () => undefined,
  }),
}));
const SECRET = 'realtime-needs-you-test-secret-at-least-32-chars';
vi.mock('@mantle/config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: (name: string) =>
    name === 'DATABASE_URL' ? 'postgres://fake/db' : name === 'SESSION_SECRET' ? SECRET : undefined,
}));
// @mantle/db stays real but for the brain-wide read the gate asks: nothing
// here queries (the fanout path is not used). The login row is stood in.
vi.mock(
  '@/lib/auth/login-row',
  async () => (await import('@/server/run-route-stand-ins')).loginRowStandIn,
);

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';

describe('needs_you_changed on the realtime bridge', () => {
  let stop: (() => Promise<void>) | null = null;
  beforeAll(() => standInLogin({ id: OWNER, role: 'admin', adminMember: true, isOwner: true }));
  afterAll(async () => {
    await stop?.();
  });

  it('reaches owner subscribers as `needs_you`', async () => {
    const rt = await import('./realtime');
    const owner: unknown[] = [];
    const offOwner = await rt.subscribeRealtime((c) => owner.push(c));
    stop = globalThis.__mantleRealtime?.stop ?? null;

    const fire = h.handlers.get('needs_you_changed');
    expect(fire).toBeTypeOf('function');
    fire!(OWNER);
    fire!(''); // a payload with no owner is dropped
    expect(owner).toEqual([{ ownerId: OWNER, type: 'needs_you', id: '' }]);
    offOwner();
  });

  it('/api/realtime sends it to the same owner only', async () => {
    const ac = new AbortController();
    const res = await runRoute(OWNER, 'GET', '/api/realtime', undefined, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const data = () =>
      text
        .split('\n\n')
        .filter((b) => b.startsWith('data: '))
        .map((b) => JSON.parse(b.slice(6)) as unknown);
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        text += decoder.decode(value);
      }
    })();
    // The route subscribes when the stream starts.
    await vi.waitFor(() => expect(globalThis.__mantleRealtime!.subs.size).toBe(1));
    const fire = h.handlers.get('needs_you_changed')!;
    // Another owner's change first, then ours: frames carry no owner, so
    // exactly one frame proves the other one was dropped.
    fire(OTHER);
    fire(OWNER);
    await vi.waitFor(() => expect(data().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await reader.cancel().catch(() => undefined);
    await pump;
    expect(data()).toEqual([{ type: 'needs_you', id: '' }]);
  });
});
