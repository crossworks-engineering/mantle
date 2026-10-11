// The "needs you" phone push: only an ARRIVAL pushes (the same NOTIFY fires
// when something clears), each arrival once, to ACTIVE ADMIN devices only
// (listAdminSubscriptions; the store has no brain-wide list), with fixed text
// only. Since W5c it carries provider outages and parked extractions (the
// review and team request pushes went). All I/O is mocked.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAlert } from '@mantle/client-types';

vi.mock('@mantle/db', () => ({
  db: {},
  agents: {},
  assistantMessages: {},
  parkedExtractions: vi.fn(async () => ({ count: 0, newest: null })),
}));
vi.mock('@mantle/tools', () => ({ countPending: vi.fn(), listPendingCalls: vi.fn() }));
vi.mock('@mantle/content', () => ({
  loadProfilePreferences: vi.fn(),
  loadProviderAlerts: vi.fn(),
}));
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
import { needsYouArrivals, needsYouMessage, rememberArrivals } from './needs-you';
import { loadProviderAlerts } from '@mantle/content';
import { sealToDevice } from './seal';
import { relayNotify } from './relay-client';
import { getPushInstance, getPushPrefs, listAdminSubscriptions } from './store';

const NOW = Date.parse('2026-09-28T18:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

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

describe('parked extractions (W1 audit, LOW 4)', () => {
  it('a new parked extraction arrives once, as a count with no title', () => {
    const seen = new Set<string>();
    const a = needsYouArrivals([], seen, NOW, { count: 3, newest: ago(60_000) });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'parked', count: 3 });
    const m = needsYouMessage(a[0]!);
    expect(m.title).toBe('Extraction parked');
    expect(m.body).toContain('3 items');
    expect(m.deepLink).toBe('/debug/integrity');
    rememberArrivals(seen, a);
    expect(needsYouArrivals([], seen, NOW, { count: 3, newest: ago(60_000) })).toEqual([]);
  });

  it('none parked, or parked long ago, pushes nothing', () => {
    expect(needsYouArrivals([], new Set(), NOW, { count: 0, newest: null })).toEqual([]);
    expect(needsYouArrivals([], new Set(), NOW, { count: 1, newest: ago(3_600_000) })).toEqual([]);
  });
});

describe('provider outages (no credits, 2026-10-04)', () => {
  it('a new outage is an arrival, pushed once', () => {
    const seen = new Set<string>();
    const a = needsYouArrivals([outage()], seen, NOW);
    expect(a.map((x) => x.kind)).toEqual(['provider']);
    rememberArrivals(seen, a);
    expect(needsYouArrivals([outage()], seen, NOW)).toEqual([]);
  });

  it('a transient outage that shows after 10 min still pushes; an hour-old one does not', () => {
    expect(needsYouArrivals([outage({ since: ago(11 * 60_000) })], new Set(), NOW)).toHaveLength(1);
    expect(needsYouArrivals([outage({ since: ago(60 * 60_000) })], new Set(), NOW)).toEqual([]);
  });

  it('the message is the fixed reason and the count waiting, and links to the fix', () => {
    const [a] = needsYouArrivals([outage()], new Set(), NOW);
    expect(needsYouMessage(a!)).toEqual({
      title: 'Embeddings are failing',
      body: 'The provider account has no credits or quota left. 30 items wait.',
      deepLink: '/settings/embedding',
    });
    const [b] = needsYouArrivals([outage({ subject: 'extraction', waiting: 1 })], new Set(), NOW);
    expect(needsYouMessage(b!)).toMatchObject({
      title: 'Extraction is failing',
      body: 'The provider account has no credits or quota left. 1 item waits.',
      deepLink: '/settings/ai-workers',
    });
  });

  it('the seen set stays bounded', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) {
      rememberArrivals(seen, needsYouArrivals([outage({ since: ago(i) })], new Set(), NOW));
    }
    expect(seen.size).toBe(500);
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
    vi.mocked(loadProviderAlerts).mockResolvedValue([outage()]);
  });

  it('pushes an arrival to admin devices only, fixed text, never provider text', async () => {
    const res = await pushNeedsYou('owner', new Set(), NOW);
    expect(res).toEqual({ attempted: 1, delivered: 1, dropped: 0 });
    expect(listAdminSubscriptions).toHaveBeenCalledWith('owner');
    expect(vi.mocked(sealToDevice).mock.calls.map((c) => c[0])).toEqual(['pk1']);
    const sent = JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1]) as Record<string, unknown>;
    expect(sent).toEqual({
      v: 1,
      t: 'Embeddings are failing',
      b: 'The provider account has no credits or quota left. 30 items wait.',
      deepLink: '/settings/embedding',
      ts: NOW,
      // Multi-login routing: this brain, and the admin the device is for.
      brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
      loginId: 'admin-1',
    });
    expect(vi.mocked(relayNotify).mock.calls[0]![2]).toMatchObject({ collapseKey: 'needs-you' });
  });

  it('pushes each arrival once, and nothing when an outage only cleared', async () => {
    const seen = new Set<string>();
    await pushNeedsYou('owner', seen, NOW);
    expect((await pushNeedsYou('owner', seen, NOW)).skipped).toBe('no_message');
    vi.mocked(loadProviderAlerts).mockResolvedValue([]);
    expect((await pushNeedsYou('owner', seen, NOW)).skipped).toBe('no_message');
    expect(relayNotify).toHaveBeenCalledTimes(1);
  });

  it('respects the approvals toggle and a missing relay', async () => {
    vi.mocked(getPushPrefs).mockResolvedValue({ assistantMessages: true, approvals: false });
    expect((await pushNeedsYou('owner', new Set(), NOW)).skipped).toBe('disabled');
    vi.mocked(getPushInstance).mockResolvedValue(null);
    expect((await pushNeedsYou('owner', new Set(), NOW)).skipped).toBe('not_connected');
    expect(loadProviderAlerts).not.toHaveBeenCalled();
    expect(relayNotify).not.toHaveBeenCalled();
  });

  it('no admin device, no push', async () => {
    vi.mocked(listAdminSubscriptions).mockResolvedValue([]);
    expect((await pushNeedsYou('owner', new Set(), NOW)).skipped).toBe('no_devices');
    expect(relayNotify).not.toHaveBeenCalled();
  });
});
