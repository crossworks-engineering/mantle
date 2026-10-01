// The "needs you" phone push: only an ARRIVAL pushes (the same NOTIFY fires
// when something leaves a queue), each arrival once, to ACTIVE ADMIN devices
// only (listAdminSubscriptions; the store has no brain-wide list), with the item's
// title and author and never its content. All I/O is mocked.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeedsYou } from '@mantle/client-types';

vi.mock('@mantle/db', () => ({ db: {}, agents: {}, assistantMessages: {} }));
vi.mock('@mantle/tools', () => ({ countPending: vi.fn(), listPendingCalls: vi.fn() }));
vi.mock('@mantle/content', () => ({ loadProfilePreferences: vi.fn(), loadNeedsYou: vi.fn() }));
vi.mock('./seal', () => ({ sealToDevice: vi.fn(), publicKeyValid: () => true }));
vi.mock('../auth/tokens', () => ({ derivedSecret: () => Buffer.from('test-secret') }));
vi.mock('./relay-client', () => ({ relayNotify: vi.fn() }));
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
    newest: { id: 'item-1', title: 'Pump spec', from: 'Mia Member', at: ago(5_000) },
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

describe('needsYouMessage', () => {
  it('names the title and the member, how many wait, and where to go', () => {
    const [a] = needsYouArrivals(needsYou({ total: 3 }), new Set(), NOW);
    expect(needsYouMessage(a!, 3)).toEqual({
      title: 'Waiting for your review',
      body: '"Pump spec" from Mia Member (3 waiting)',
      deepLink: '/team-admin?view=review',
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

describe('pushNeedsYou', () => {
  const admins = [
    { id: 'd1', routingToken: 'r1', publicKey: 'pk1', platform: 'ios' as const, label: null },
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
      deepLink: '/team-admin?view=review',
      ts: NOW,
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
