/**
 * GET /api/member/realtime sends a member only the changes they may care
 * about: items in their own space, and items shared with the team (or just
 * unshared). Another member's private item never reaches them, not even its
 * id. The change feed is faked (no database); the route, its filter and the
 * SSE stream are the real code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpaceItemChange } from '@mantle/content';

const MY_SPACE = '66666666-6666-4666-8666-666666666666';
const OTHER_SPACE = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  feed: null as ((c: SpaceItemChange) => void) | null,
  unsubscribed: 0,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMemberOr401: vi.fn(async () => ({
    role: 'member',
    loginId: '22222222-2222-4222-8222-222222222222',
    anchorId: '33333333-3333-4333-8333-333333333333',
    spaceId: MY_SPACE,
    email: 'pat@example.invalid',
    displayName: 'Pat',
    contactId: null,
  })),
  memberLoginActive: vi.fn(async () => true),
  sessionCookieExpiryMs: vi.fn(async () => null),
}));

vi.mock('@/lib/realtime', () => ({
  subscribeSpaceItems: vi.fn(async (cb: (c: SpaceItemChange) => void) => {
    h.feed = cb;
    return () => {
      h.unsubscribed += 1;
      h.feed = null;
    };
  }),
}));

afterEach(() => {
  h.feed = null;
});

/** The `data:` events the stream carried, once `until` of them arrived. */
async function readEvents(res: Response, until: number): Promise<unknown[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const events = () =>
    text
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as unknown);
  while (events().length < until) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader.cancel();
  return events();
}

describe('GET /api/member/realtime', () => {
  it('passes own and team changes, drops another member’s private ones', async () => {
    const { GET } = await import('./route');
    const ac = new AbortController();
    const res = await GET(new Request('http://x/api/member/realtime', { signal: ac.signal }));
    expect(res.status).toBe(200);
    // The subscription starts when the stream does.
    const reading = readEvents(res, 3);
    await vi.waitFor(() => expect(h.feed).not.toBeNull());
    const feed = h.feed!;

    feed({ id: 'own-private', spaceId: MY_SPACE, kind: 'saved', team: false });
    feed({ id: 'theirs-private', spaceId: OTHER_SPACE, kind: 'created', team: false });
    feed({ id: 'theirs-deleted', spaceId: OTHER_SPACE, kind: 'deleted', team: false });
    feed({ id: 'theirs-team', spaceId: OTHER_SPACE, kind: 'state', team: true });
    feed({ id: 'own-team', spaceId: MY_SPACE, kind: 'deleted', team: true });

    const events = await reading;
    ac.abort();
    expect(events).toEqual([
      { type: 'space_item', id: 'own-private', kind: 'saved', own: true },
      { type: 'space_item', id: 'theirs-team', kind: 'state', own: false },
      { type: 'space_item', id: 'own-team', kind: 'deleted', own: true },
    ]);
    expect(JSON.stringify(events)).not.toContain('theirs-private');
    expect(JSON.stringify(events)).not.toContain('theirs-deleted');
  });
});
