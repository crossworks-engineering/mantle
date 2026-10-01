/**
 * The realtime bridge turns a `needs_you_changed` NOTIFY (migration 0186)
 * into an owner change typed `needs_you`, for the owner live stream only:
 * the member stream's subscribers (subscribeSpaceItems) never receive it,
 * and /api/realtime passes it only to a session of the same owner. The
 * Postgres LISTEN is faked; the bridge and the route filter are the real code.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

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
vi.mock('@mantle/config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: (name: string) => (name === 'DATABASE_URL' ? 'postgres://fake/db' : undefined),
}));
// @mantle/db stays real: nothing here queries (the fanout path is not used).

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';

describe('needs_you_changed on the realtime bridge', () => {
  let stop: (() => Promise<void>) | null = null;
  afterAll(async () => {
    await stop?.();
  });

  it('reaches owner subscribers as `needs_you`, never the member stream', async () => {
    const rt = await import('./realtime');
    const owner: unknown[] = [];
    const member: unknown[] = [];
    const offOwner = await rt.subscribeRealtime((c) => owner.push(c));
    const offMember = await rt.subscribeSpaceItems((c) => member.push(c));
    stop = globalThis.__mantleRealtime?.stop ?? null;

    const fire = h.handlers.get('needs_you_changed');
    expect(fire).toBeTypeOf('function');
    fire!(OWNER);
    fire!(''); // a payload with no owner is dropped
    expect(owner).toEqual([{ ownerId: OWNER, type: 'needs_you', id: '' }]);
    expect(member).toEqual([]);
    offOwner();
    offMember();
  });

  it('/api/realtime sends it to the same owner only', async () => {
    vi.doMock('@/lib/auth', () => ({
      getOwnerOr401: vi.fn(async () => ({ id: OWNER, actor: { id: OWNER } })),
    }));
    const { GET } = await import('@/app/api/realtime/route');
    const ac = new AbortController();
    const res = await GET(new Request('http://x/api/realtime', { signal: ac.signal }));
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
