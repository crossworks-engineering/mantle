// The "needs you" phone push: only an ARRIVAL pushes (the same NOTIFY fires
// when something leaves a queue), each arrival once, to ACTIVE ADMIN devices
// only (listAdminSubscriptions; the store has no brain-wide list), with the item's
// title and author and never its content. All I/O is mocked.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeedsYou, ProviderAlert } from '@mantle/client-types';

vi.mock('@mantle/db', () => ({
  db: {},
  agents: {},
  assistantMessages: {},
  parkedExtractions: vi.fn(async () => ({ count: 0, newest: null })),
}));
vi.mock('@mantle/tools', () => ({ countPending: vi.fn(), listPendingCalls: vi.fn() }));
vi.mock('@mantle/content', () => ({ loadProfilePreferences: vi.fn(), loadNeedsYou: vi.fn() }));
vi.mock('./seal', () => ({ sealToDevice: vi.fn(), publicKeyValid: () => true }));
vi.mock('../auth/tokens', () => ({ derivedSecret: () => Buffer.from('test-secret') }));
vi.mock('./relay-client', () => ({ relayNotify: vi.fn() }));
vi.mock('../brain-identity', () => ({
  brainIdOrNull: async () => '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
}));
vi.mock('./store', () => ({
  getPushInstance: vi.fn(),
  getPushPrefs: vi.fn(),
  listAdminSubscriptions: vi.fn(),
  markPushed: vi.fn(),
  deleteSubscriptionByRoutingToken: vi.fn(),
}));

import { pushNeedsYou } from './notify';
import {
  NEEDS_YOU_ARRIVAL_WINDOW_MS,
  arrivalKey,
  needsYouArrivals,
  needsYouMessage,
  reviewDeepLink,
  rememberArrivals,
} from './needs-you';
import { loadNeedsYou } from '@mantle/content';
import { sealToDevice } from './seal';
import { relayNotify } from './relay-client';
import { getPushInstance, getPushPrefs, listAdminSubscriptions } from './store';

const NOW = Date.parse('2026-09-28T18:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const needsYou = (over: Partial<NeedsYou> = {}): NeedsYou => ({
  review: {
    submitted: 1,
    leftBehind: 0,
    newest: { id: 'item-1', type: 'note', title: 'Pump spec', from: 'Mia Member', at: ago(5_000) },
  },
  requests: { open: 0, newest: null },
  total: 1,
  ...over,
});

describe('needsYouArrivals', () => {
  it('a newest item that just started waiting is an arrival', () => {
    const a = needsYouArrivals(needsYou(), new Set(), NOW);
    expect(a).toEqual([{ kind: 'review', item: needsYou().review.newest }]);
  });

  it('an old newest item is not (a recall, return or accept leaves an old newest)', () => {
    const n = needsYou();
    n.review.newest!.at = ago(NEEDS_YOU_ARRIVAL_WINDOW_MS + 1);
    expect(needsYouArrivals(n, new Set(), NOW)).toEqual([]);
  });

  it('an arrival already pushed is not pushed again', () => {
    const seen = new Set<string>();
    const first = needsYouArrivals(needsYou(), seen, NOW);
    rememberArrivals(seen, first);
    expect(needsYouArrivals(needsYou(), seen, NOW)).toEqual([]);
  });

  it('a recalled and resubmitted item arrives again (a new wait)', () => {
    const seen = new Set<string>();
    rememberArrivals(seen, needsYouArrivals(needsYou(), seen, NOW));
    const again = needsYou();
    again.review.newest!.at = ago(1_000);
    expect(needsYouArrivals(again, seen, NOW)).toHaveLength(1);
  });

  it('nothing waiting is nothing to push', () => {
    const empty = needsYou({
      review: { submitted: 0, leftBehind: 0, newest: null },
      total: 0,
    });
    expect(needsYouArrivals(empty, new Set(), NOW)).toEqual([]);
  });

  it('a request and a review arriving together come newest first', () => {
    const n = needsYou({
      requests: {
        open: 1,
        newest: { id: 'task-1', title: 'Fix the date', from: 'Pat', at: ago(1_000) },
      },
      total: 2,
    });
    expect(needsYouArrivals(n, new Set(), NOW).map((a) => a.kind)).toEqual(['request', 'review']);
  });

  it('the seen set stays bounded', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 700; i++) {
      rememberArrivals(seen, [
        { kind: 'review', item: { id: `i${i}`, title: '', from: '', at: 'x' } },
      ]);
    }
    expect(seen.size).toBe(500);
    expect(
      seen.has(arrivalKey({ kind: 'review', item: { id: 'i699', title: '', from: '', at: 'x' } })),
    ).toBe(true);
  });
});

describe('reviewDeepLink', () => {
  it('opens the item in its own workspace, Pages for a kind it does not know', () => {
    const at = ago(0);
    expect(reviewDeepLink({ id: 'a b', type: 'page', title: '', from: '', at })).toBe(
      '/pages?review=a%20b',
    );
    expect(reviewDeepLink({ id: 'x', type: 'table', title: '', from: '', at })).toBe(
      '/tables?review=x',
    );
    expect(reviewDeepLink({ id: 'x', type: 'draw', title: '', from: '', at })).toBe(
      '/draw?review=x',
    );
    expect(reviewDeepLink({ id: 'x', type: 'file', title: '', from: '', at })).toBe(
      '/files?review=x',
    );
    expect(reviewDeepLink({ id: 'x', title: '', from: '', at })).toBe('/pages?review=x');
  });
});

describe('parked extractions (W1 audit, LOW 4)', () => {
  const none = { ...needsYou(), review: { submitted: 0, leftBehind: 0, newest: null }, total: 0 };

  it('a new parked extraction arrives once, as a count with no title', () => {
    const seen = new Set<string>();
    const a = needsYouArrivals(none, seen, NOW, undefined, { count: 3, newest: ago(60_000) });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'parked', count: 3 });
    const m = needsYouMessage(a[0]!, 3);
    expect(m.title).toBe('Extraction parked');
    expect(m.body).toContain('3 items');
    expect(m.deepLink).toBe('/debug/integrity');
    rememberArrivals(seen, a);
    expect(needsYouArrivals(none, seen, NOW, undefined, { count: 3, newest: ago(60_000) })).toEqual(
      [],
    );
  });

  it('none parked, or parked long ago, pushes nothing', () => {
    expect(needsYouArrivals(none, new Set(), NOW, undefined, { count: 0, newest: null })).toEqual(
      [],
    );
    expect(
      needsYouArrivals(none, new Set(), NOW, undefined, { count: 1, newest: ago(3_600_000) }),
    ).toEqual([]);
  });
});

describe('needsYouMessage', () => {
  it('names the title and the member, how many wait, and where to go', () => {
    const [a] = needsYouArrivals(needsYou({ total: 3 }), new Set(), NOW);
    expect(needsYouMessage(a!, 3)).toEqual({
      title: 'Waiting for your review',
      body: '"Pump spec" from Mia Member (3 waiting)',
      deepLink: '/notes?review=item-1',
    });
    const req = {
      kind: 'request' as const,
      item: { id: 't', title: 'Fix it', from: 'Pat', at: ago(0) },
    };
    expect(needsYouMessage(req, 1)).toEqual({
      title: 'New team request',
      body: '"Fix it" from Pat',
      deepLink: '/team-admin?view=requests',
    });
  });
});

describe('provider outages (no credits, 2026-10-04)', () => {
  const outage = (over: Partial<ProviderAlert> = {}): ProviderAlert => ({
    subject: 'embedding',
    code: 'quota',
    permanent: true,
    reason: 'The provider account has no credits or quota left.',
    provider: 'openai',
    model: 'text-embedding-3-large',
    since: ago(30_000),
    paused: true,
    nextProbeAt: null,
    waiting: 30,
    ...over,
  });
  const quiet = needsYou({
    review: { submitted: 0, leftBehind: 0, newest: null },
    total: 1,
  });

  it('a new outage is an arrival, pushed once', () => {
    const n = { ...quiet, providers: [outage()] };
    const seen = new Set<string>();
    const a = needsYouArrivals(n, seen, NOW);
    expect(a.map((x) => x.kind)).toEqual(['provider']);
    rememberArrivals(seen, a);
    expect(needsYouArrivals(n, seen, NOW)).toEqual([]);
  });

  it('a transient outage that shows after 10 min still pushes; an hour-old one does not', () => {
    expect(
      needsYouArrivals(
        { ...quiet, providers: [outage({ since: ago(11 * 60_000) })] },
        new Set(),
        NOW,
      ),
    ).toHaveLength(1);
    expect(
      needsYouArrivals(
        { ...quiet, providers: [outage({ since: ago(60 * 60_000) })] },
        new Set(),
        NOW,
      ),
    ).toEqual([]);
  });

  it('the message is the fixed reason and the count waiting, and links to the fix', () => {
    const [a] = needsYouArrivals({ ...quiet, providers: [outage()] }, new Set(), NOW);
    expect(needsYouMessage(a!, 1)).toEqual({
      title: 'Embeddings are failing',
      body: 'The provider account has no credits or quota left. 30 items wait.',
      deepLink: '/settings/embedding',
    });
    const [b] = needsYouArrivals(
      { ...quiet, providers: [outage({ subject: 'extraction', waiting: 1 })] },
      new Set(),
      NOW,
    );
    expect(needsYouMessage(b!, 1)).toMatchObject({
      title: 'Extraction is failing',
      body: 'The provider account has no credits or quota left. 1 item waits.',
      deepLink: '/settings/ai-workers',
    });
  });
});

describe('pushNeedsYou', () => {
  const admins = [
    {
      id: 'd1',
      routingToken: 'r1',
      publicKey: 'pk1',
      platform: 'ios' as const,
      label: null,
      loginId: 'admin-1',
    },
  ];
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPushInstance).mockResolvedValue({
      instanceToken: 't',
      relayInstanceId: 'i',
      relayUrl: 'https://relay.example',
    });
    vi.mocked(getPushPrefs).mockResolvedValue({ assistantMessages: true, approvals: true });
    vi.mocked(listAdminSubscriptions).mockResolvedValue(admins);
    vi.mocked(sealToDevice).mockResolvedValue('ciphertext');
    vi.mocked(relayNotify).mockResolvedValue({ ok: true, status: 200 });
    vi.mocked(loadNeedsYou).mockResolvedValue(needsYou());
  });

  it('pushes an arrival to admin devices only, title and author, never content', async () => {
    const res = await pushNeedsYou('owner', new Set(), NOW);
    expect(res).toEqual({ attempted: 1, delivered: 1, dropped: 0 });
    expect(listAdminSubscriptions).toHaveBeenCalledWith('owner');
    expect(vi.mocked(sealToDevice).mock.calls.map((c) => c[0])).toEqual(['pk1']);
    const sent = JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1]) as Record<string, unknown>;
    expect(sent).toEqual({
      v: 1,
      t: 'Waiting for your review',
      b: '"Pump spec" from Mia Member',
      deepLink: '/notes?review=item-1',
      ts: NOW,
      // Multi-login routing: this brain, and the admin the device is for.
      brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
      loginId: 'admin-1',
    });
    expect(vi.mocked(relayNotify).mock.calls[0]![2]).toMatchObject({ collapseKey: 'needs-you' });
  });

  it('pushes each arrival once, and nothing when a queue only shrank', async () => {
    const seen = new Set<string>();
    await pushNeedsYou('owner', seen, NOW);
    expect((await pushNeedsYou('owner', seen, NOW)).skipped).toBe('no_message');
    // The item was accepted: the queue is empty.
    vi.mocked(loadNeedsYou).mockResolvedValue(
      needsYou({ review: { submitted: 0, leftBehind: 0, newest: null }, total: 0 }),
    );
    expect((await pushNeedsYou('owner', seen, NOW)).skipped).toBe('no_message');
    expect(relayNotify).toHaveBeenCalledTimes(1);
  });

  it('respects the approvals toggle and a missing relay', async () => {
    vi.mocked(getPushPrefs).mockResolvedValue({ assistantMessages: true, approvals: false });
    expect((await pushNeedsYou('owner', new Set(), NOW)).skipped).toBe('disabled');
    vi.mocked(getPushInstance).mockResolvedValue(null);
    expect((await pushNeedsYou('owner', new Set(), NOW)).skipped).toBe('not_connected');
    expect(loadNeedsYou).not.toHaveBeenCalled();
    expect(relayNotify).not.toHaveBeenCalled();
  });

  it('no admin device, no push', async () => {
    vi.mocked(listAdminSubscriptions).mockResolvedValue([]);
    expect((await pushNeedsYou('owner', new Set(), NOW)).skipped).toBe('no_devices');
    expect(relayNotify).not.toHaveBeenCalled();
  });
});
