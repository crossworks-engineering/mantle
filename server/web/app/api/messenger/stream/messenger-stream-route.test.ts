/**
 * GET /api/messenger/stream (Messenger V1, plan page d8954876 section 7):
 * the member stream's guards on the messenger route. One login holds at
 * most MEMBER_STREAMS_PER_LOGIN streams (429 beyond); the login is checked
 * again on every heartbeat (a disabled one's stream closes) and the beat
 * marks it online; an event goes out as ids and a seq, never text; a stream
 * subscribes as its own login only. No database: the realtime bridge and
 * the content checks are stand-ins.
 */
import { describe, expect, it, vi } from 'vitest';

const LOGIN = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  usable: true,
  touched: 0,
  subscribedAs: [] as string[],
  emit: null as
    null | ((c: { c: string; seq: number | null; kind: string; actor: string | null }) => void),
  opts: null as null | { onPing?: () => Promise<boolean> | boolean },
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  anyLoginCaller: vi.fn(() => ({ loginId: LOGIN, brainId: LOGIN })),
  sessionCookieExpiryMs: vi.fn(async () => null),
}));
vi.mock('@/lib/messenger', () => ({
  messengerLoginUsable: vi.fn(async () => h.usable),
  touchLoginPresence: vi.fn(async () => {
    h.touched += 1;
  }),
}));
vi.mock('@/lib/sse', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/sse')>();
  return {
    ...orig,
    sseResponse: (req: Request, opts: Parameters<typeof orig.sseResponse>[1]) => {
      h.opts = opts;
      return orig.sseResponse(req, opts);
    },
  };
});
vi.mock('@/lib/realtime', () => ({
  subscribeMessenger: vi.fn(async (loginId: string, cb: NonNullable<typeof h.emit>) => {
    h.subscribedAs.push(loginId);
    h.emit = cb;
    return () => {};
  }),
}));

describe('GET /api/messenger/stream', () => {
  it('streams ids and a seq for its own login, re-checks the login, and caps the streams', async () => {
    const { GET } = await import('./route');
    const { MEMBER_STREAMS_PER_LOGIN } = await import('@/lib/member-streams');
    const ac = new AbortController();
    const res = await GET(new Request('http://x/api/messenger/stream', { signal: ac.signal }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    await reader.read(); // ': connected'
    expect(h.subscribedAs).toEqual([LOGIN]);
    h.emit!({ c: 'c1', seq: 7, kind: 'new', actor: 'someone' });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('"type":"message"');
    expect(JSON.parse(text.replace(/^data: /, '').trim())).toEqual({
      type: 'message',
      c: 'c1',
      seq: 7,
      kind: 'new',
    });

    // The cap: the first stream holds one; the rest up to the cap open, then 429.
    const extra: AbortController[] = [];
    for (let i = 1; i < MEMBER_STREAMS_PER_LOGIN; i++) {
      const a = new AbortController();
      extra.push(a);
      expect((await GET(new Request('http://x', { signal: a.signal }))).status).toBe(200);
    }
    expect((await GET(new Request('http://x'))).status).toBe(429);
    for (const a of extra) a.abort();
    await reader.cancel();
    ac.abort();
  });

  it('each heartbeat re-checks the login and marks it online; a disabled login closes', async () => {
    const before = h.touched;
    expect(await h.opts!.onPing!()).toBe(true);
    expect(h.touched).toBeGreaterThan(before);
    h.usable = false;
    expect(await h.opts!.onPing!()).toBe(false);
  });
});
