// Tests for the push send path — the gating decisions and the seal→relay→prune
// delivery loop in notify.ts. This is the code that decides whether a
// notification leaves the box at all (per-trigger toggles, push-notifications.md
// §10), so every skip reason and its ordering is pinned. (Quiet hours were
// removed — docs/reminder-delivery-routing.md §C.)
//
// All I/O is mocked: the store (DB), seal (crypto), the relay client (network),
// countPending (@mantle/tools), and the raw drizzle `db` used by latestOutbound.
// No DB or network is touched.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// drizzle's and/desc/eq are only argument-builders for the (mocked) db here.
vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ __and: a }),
  desc: (x: unknown) => x,
  eq: (...a: unknown[]) => ({ __eq: a }),
}));

// A tiny chainable `db` stub: every builder method returns the same chain, and
// awaiting it yields the next queued result set (FIFO). latestOutbound issues
// two queries (agents, then messages), so we queue one array per query.
const dbState = vi.hoisted(() => ({ queue: [] as unknown[][] }));
vi.mock('@mantle/db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
    chain['then'] = (resolve: (v: unknown[]) => void) => resolve(dbState.queue.shift() ?? []);
    return chain;
  };
  return {
    db: { select: () => makeChain() },
    agents: {
      id: 'agents.id',
      name: 'agents.name',
      ownerId: 'agents.ownerId',
      slug: 'agents.slug',
    },
    assistantMessages: {
      text: 'am.text',
      ownerId: 'am.ownerId',
      agentId: 'am.agentId',
      direction: 'am.direction',
      createdAt: 'am.createdAt',
    },
  };
});

vi.mock('@mantle/tools', () => ({ countPending: vi.fn() }));
vi.mock('@mantle/content', () => ({ loadProfilePreferences: vi.fn() }));
vi.mock('./seal', () => ({ sealToDevice: vi.fn() }));
vi.mock('./relay-client', () => ({ relayNotify: vi.fn() }));
vi.mock('./store', () => ({
  getPushInstance: vi.fn(),
  getPushPrefs: vi.fn(),
  listSubscriptions: vi.fn(),
  markPushed: vi.fn(),
  deleteSubscriptionByRoutingToken: vi.fn(),
}));

import { pushOutbound, pushApproval } from './notify';
import { countPending } from '@mantle/tools';
import { loadProfilePreferences } from '@mantle/content';
import { sealToDevice } from './seal';
import { relayNotify } from './relay-client';
import {
  getPushInstance,
  getPushPrefs,
  listSubscriptions,
  markPushed,
  deleteSubscriptionByRoutingToken,
} from './store';

const INSTANCE = {
  instanceToken: 'itok',
  relayInstanceId: 'iid',
  relayUrl: 'https://relay.example',
};
const PREFS = { assistantMessages: true, approvals: true };
const device = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'dev-1',
  routingToken: 'route-1',
  publicKey: 'pk-1',
  platform: 'ios' as const,
  label: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbState.queue = [];
  // Sensible "everything allowed" defaults; individual tests override.
  vi.mocked(getPushInstance).mockResolvedValue(INSTANCE);
  vi.mocked(getPushPrefs).mockResolvedValue(PREFS);
  vi.mocked(listSubscriptions).mockResolvedValue([device()]);
  vi.mocked(sealToDevice).mockResolvedValue('ciphertext');
  vi.mocked(relayNotify).mockResolvedValue({ ok: true, status: 200 });
  vi.mocked(countPending).mockResolvedValue(1);
  // Approvals only push when the operator's last channel is the companion app.
  // Default to that here; the wrong-channel case overrides.
  vi.mocked(loadProfilePreferences).mockResolvedValue({
    reminderChannel: 'mobile',
  } as Awaited<ReturnType<typeof loadProfilePreferences>>);
});

describe('pushOutbound — gating', () => {
  it('skips not_connected when there is no relay instance', async () => {
    vi.mocked(getPushInstance).mockResolvedValue(null);
    const res = await pushOutbound('owner', 'ada');
    expect(res).toEqual({ attempted: 0, delivered: 0, dropped: 0, skipped: 'not_connected' });
    expect(relayNotify).not.toHaveBeenCalled();
    expect(listSubscriptions).not.toHaveBeenCalled();
  });

  it('skips disabled when the assistant-messages trigger is off (before touching devices)', async () => {
    vi.mocked(getPushPrefs).mockResolvedValue({ ...PREFS, assistantMessages: false });
    const res = await pushOutbound('owner', 'ada');
    expect(res.skipped).toBe('disabled');
    expect(listSubscriptions).not.toHaveBeenCalled();
  });

  it('skips no_devices when the owner has no enrolled devices', async () => {
    vi.mocked(listSubscriptions).mockResolvedValue([]);
    const res = await pushOutbound('owner', 'ada');
    expect(res.skipped).toBe('no_devices');
    expect(relayNotify).not.toHaveBeenCalled();
  });

  it('skips no_message when the agent has no outbound turn (agent missing)', async () => {
    dbState.queue = [[]]; // agents query → empty
    const res = await pushOutbound('owner', 'ada');
    expect(res.skipped).toBe('no_message');
    expect(relayNotify).not.toHaveBeenCalled();
  });

  it('skips no_message when the agent exists but has no outbound message', async () => {
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], []]; // agent found, no message
    const res = await pushOutbound('owner', 'ada');
    expect(res.skipped).toBe('no_message');
  });
});

describe('pushOutbound — delivery', () => {
  it('seals + delivers the latest outbound turn and marks it pushed', async () => {
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hello there' }]];
    const res = await pushOutbound('owner', 'ada');

    expect(res).toEqual({ attempted: 1, delivered: 1, dropped: 0 });
    expect(markPushed).toHaveBeenCalledWith('dev-1');

    // Sealed plaintext is the §6 payload, addressed to the right deep link.
    const plaintext = vi.mocked(sealToDevice).mock.calls[0]![1];
    expect(JSON.parse(plaintext)).toMatchObject({
      v: 1,
      t: 'Ada',
      b: 'hello there',
      agentSlug: 'ada',
      deepLink: '/chat/ada',
    });
    // Relay call carries the device routing token + collapseKey = agent slug.
    expect(relayNotify).toHaveBeenCalledWith('https://relay.example', 'itok', {
      routingToken: 'route-1',
      ciphertext: 'ciphertext',
      collapseKey: 'ada',
    });
  });

  it('collapses whitespace and truncates the teaser to 140 chars with an ellipsis', async () => {
    const long = 'A'.repeat(200);
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: `  ${long}  ` }]];
    await pushOutbound('owner', 'ada');

    const body = JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1]).b as string;
    expect(body.length).toBe(140);
    expect(body.endsWith('…')).toBe(true);
    expect(body.startsWith('A')).toBe(true);
  });

  it('prunes a device the relay reports unregistered (410) instead of delivering', async () => {
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi' }]];
    vi.mocked(relayNotify).mockResolvedValue({ ok: false, status: 410, unregistered: true });
    const res = await pushOutbound('owner', 'ada');

    expect(res).toEqual({ attempted: 1, delivered: 0, dropped: 1 });
    expect(deleteSubscriptionByRoutingToken).toHaveBeenCalledWith('route-1');
    expect(markPushed).not.toHaveBeenCalled();
  });

  it('a single device with a bad public key does not break the others', async () => {
    vi.mocked(listSubscriptions).mockResolvedValue([
      device({ id: 'bad', routingToken: 'route-bad', publicKey: 'broken' }),
      device({ id: 'good', routingToken: 'route-good', publicKey: 'pk-good' }),
    ]);
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi' }]];
    vi.mocked(sealToDevice).mockRejectedValueOnce(new Error('bad key')).mockResolvedValueOnce('ct');

    const res = await pushOutbound('owner', 'ada');
    expect(res).toEqual({ attempted: 2, delivered: 1, dropped: 0 });
    expect(relayNotify).toHaveBeenCalledTimes(1); // only the good device reached the relay
  });
});

describe('pushApproval', () => {
  it('skips not_connected with no relay instance', async () => {
    vi.mocked(getPushInstance).mockResolvedValue(null);
    expect((await pushApproval('owner')).skipped).toBe('not_connected');
  });

  it('skips disabled when the approvals trigger is off', async () => {
    vi.mocked(getPushPrefs).mockResolvedValue({ ...PREFS, approvals: false });
    expect((await pushApproval('owner')).skipped).toBe('disabled');
    expect(countPending).not.toHaveBeenCalled();
  });

  it('skips wrong_channel when the operator is not on the mobile channel', async () => {
    vi.mocked(loadProfilePreferences).mockResolvedValue({
      reminderChannel: 'telegram',
    } as Awaited<ReturnType<typeof loadProfilePreferences>>);
    expect((await pushApproval('owner')).skipped).toBe('wrong_channel');
    // Bails before touching devices — the Telegram card is the notification.
    expect(listSubscriptions).not.toHaveBeenCalled();
    expect(relayNotify).not.toHaveBeenCalled();
  });

  it('skips wrong_channel when reminderChannel is unset (defaults to Telegram)', async () => {
    vi.mocked(loadProfilePreferences).mockResolvedValue(
      {} as Awaited<ReturnType<typeof loadProfilePreferences>>,
    );
    expect((await pushApproval('owner')).skipped).toBe('wrong_channel');
  });

  it('skips no_devices when the owner has no devices', async () => {
    vi.mocked(listSubscriptions).mockResolvedValue([]);
    expect((await pushApproval('owner')).skipped).toBe('no_devices');
  });

  it('skips no_message when nothing is pending', async () => {
    vi.mocked(countPending).mockResolvedValue(0);
    expect((await pushApproval('owner')).skipped).toBe('no_message');
    expect(relayNotify).not.toHaveBeenCalled();
  });

  it('delivers a singular nudge collapsed on "approvals"', async () => {
    vi.mocked(countPending).mockResolvedValue(1);
    const res = await pushApproval('owner');
    expect(res).toEqual({ attempted: 1, delivered: 1, dropped: 0 });

    expect(JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1])).toMatchObject({
      v: 1,
      t: 'Mantle',
      b: 'An action needs your approval.',
      deepLink: '/pending',
    });
    expect(vi.mocked(relayNotify).mock.calls[0]![2]).toMatchObject({ collapseKey: 'approvals' });
  });

  it('pluralises the nudge body when more than one is pending', async () => {
    vi.mocked(countPending).mockResolvedValue(3);
    await pushApproval('owner');
    const body = JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1]).b as string;
    expect(body).toBe('3 actions need your approval.');
  });
});
