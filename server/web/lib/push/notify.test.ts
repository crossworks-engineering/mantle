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
      assignedUserId: 'agents.assignedUserId',
    },
    assistantMessages: {
      text: 'am.text',
      ownerId: 'am.ownerId',
      agentId: 'am.agentId',
      direction: 'am.direction',
      status: 'am.status',
      channel: 'am.channel',
      data: 'am.data',
      createdAt: 'am.createdAt',
    },
    parkedExtractions: async () => ({ count: 0, newest: null }),
  };
});

vi.mock('@mantle/tools', () => ({ countPending: vi.fn(), listPendingCalls: vi.fn() }));
vi.mock('@mantle/content', () => ({ loadProfilePreferences: vi.fn() }));
// The real key check is seal.test.ts; here only 'broken' is not a key.
vi.mock('./seal', () => ({
  sealToDevice: vi.fn(),
  publicKeyValid: (k: string) => k !== 'broken',
}));
vi.mock('../auth/tokens', () => ({ derivedSecret: () => Buffer.from('test-secret') }));
vi.mock('./relay-client', () => ({ relayNotify: vi.fn() }));
vi.mock('../brain-identity', () => ({ brainIdOrNull: vi.fn() }));
vi.mock('./store', () => ({
  getPushInstance: vi.fn(),
  getPushPrefs: vi.fn(),
  listAdminSubscriptions: vi.fn(),
  markPushed: vi.fn(),
  deleteSubscriptionByRoutingToken: vi.fn(),
}));

import {
  opaqueCollapseKey,
  payloadForDevice,
  pushApproval,
  pushOutbound,
  reminderItemLink,
  wantsOutboundPush,
} from './notify';
import { brainIdOrNull } from '../brain-identity';
import { countPending, listPendingCalls } from '@mantle/tools';
import { loadProfilePreferences } from '@mantle/content';
import { sealToDevice } from './seal';
import { relayNotify } from './relay-client';
import {
  getPushInstance,
  getPushPrefs,
  listAdminSubscriptions,
  markPushed,
  deleteSubscriptionByRoutingToken,
} from './store';

const INSTANCE = {
  instanceToken: 'itok',
  relayInstanceId: 'iid',
  relayUrl: 'https://relay.example',
};
const PREFS = { assistantMessages: true, approvals: true };
const GOOD_KEY = 'pk-good';
const BRAIN_ID = '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f';
const device = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'dev-1',
  routingToken: 'route-1',
  publicKey: 'pk-1',
  platform: 'ios' as const,
  label: null,
  loginId: 'admin-1' as string | null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbState.queue = [];
  // Sensible "everything allowed" defaults; individual tests override.
  vi.mocked(getPushInstance).mockResolvedValue(INSTANCE);
  vi.mocked(brainIdOrNull).mockResolvedValue(BRAIN_ID);
  vi.mocked(getPushPrefs).mockResolvedValue(PREFS);
  vi.mocked(listAdminSubscriptions).mockResolvedValue([device()]);
  vi.mocked(sealToDevice).mockResolvedValue('ciphertext');
  vi.mocked(relayNotify).mockResolvedValue({ ok: true, status: 200 });
  vi.mocked(countPending).mockResolvedValue(1);
  // Default: an ordinary confirm-gated tool, not a runner question.
  vi.mocked(listPendingCalls).mockResolvedValue([]);
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
    expect(listAdminSubscriptions).not.toHaveBeenCalled();
  });

  it('skips disabled when the assistant-messages trigger is off (before touching devices)', async () => {
    vi.mocked(getPushPrefs).mockResolvedValue({ ...PREFS, assistantMessages: false });
    const res = await pushOutbound('owner', 'ada');
    expect(res.skipped).toBe('disabled');
    expect(listAdminSubscriptions).not.toHaveBeenCalled();
  });

  it('skips no_devices when no admin has an enrolled device', async () => {
    vi.mocked(listAdminSubscriptions).mockResolvedValue([]);
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi' }]];
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

  it('skips mcp_turn for a reply an MCP client wrote back (the owner is at the client)', async () => {
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi', channel: 'mcp' }]];
    const res = await pushOutbound('owner', 'ada');
    expect(res).toEqual({ attempted: 0, delivered: 0, dropped: 0, skipped: 'mcp_turn' });
    expect(listAdminSubscriptions).not.toHaveBeenCalled();
    expect(relayNotify).not.toHaveBeenCalled();
  });
});

describe('pushOutbound — who is told (admin devices only)', () => {
  it('an agent assigned to nobody goes to every active admin', async () => {
    dbState.queue = [[{ id: 'a1', name: 'Ada', assignedUserId: null }], [{ text: 'hi' }]];
    await pushOutbound('owner', 'ada');
    expect(listAdminSubscriptions).toHaveBeenCalledTimes(1);
    expect(listAdminSubscriptions).toHaveBeenCalledWith('owner', { loginId: null });
  });

  it('an agent assigned to one login goes to that login only', async () => {
    dbState.queue = [[{ id: 'a1', name: 'Ada', assignedUserId: 'login-b' }], [{ text: 'hi' }]];
    await pushOutbound('owner', 'ada');
    expect(listAdminSubscriptions).toHaveBeenCalledWith('owner', { loginId: 'login-b' });
  });

  it('the store has no list of every device on the brain to send to', async () => {
    // The trap this replaced: a brain-wide list handed an owner teaser to a
    // member's or a client's device. The real store is checked on Postgres
    // (push-targeting.db.test.ts); this pins that notify.ts imports none.
    const src = (await import('node:fs')).readFileSync(
      new URL('./notify.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/\blistSubscriptions\b/);
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
      brainId: BRAIN_ID,
      loginId: 'admin-1',
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

  it('shows a markdown reply as plain words: no heading, list, link, code or chip marks', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const replies: Array<[string, string]> = [
      ['## Summary\n\nThe **pump** spec is _ready_.', 'Summary The pump spec is ready.'],
      ['- first item\n- second item\n\n1. then this', 'first item second item then this'],
      ['See [the docs](https://example.invalid/a?b=1) now', 'See the docs now'],
      ['Run:\n```bash\npnpm verify\n```', 'Run: pnpm verify'],
      ['| Item | Qty |\n|---|---|\n| Pump | 2 |', 'Item Qty Pump 2'],
      [
        `Open [Pump spec](page:${id}) and ask [Ada](mention:entity:${id})`,
        'Open Pump spec and ask Ada',
      ],
    ];
    for (const [text, shown] of replies) {
      vi.mocked(sealToDevice).mockClear();
      dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text }]];
      await pushOutbound('owner', 'ada');
      const body = JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1]).b as string;
      expect(body, text).toBe(shown);
    }
  });

  it('cuts after the marks are gone, and never sends an empty teaser', async () => {
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: `# ${'**word** '.repeat(60)}` }]];
    await pushOutbound('owner', 'ada');
    const long = JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1]).b as string;
    expect(long).toHaveLength(140);
    expect(long).not.toMatch(/[*#]/);
    // A reply that is a picture and nothing else.
    vi.mocked(sealToDevice).mockClear();
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: '![](media:abc)' }]];
    await pushOutbound('owner', 'ada');
    expect(JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1]).b).toBe('New message');
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
    vi.mocked(listAdminSubscriptions).mockResolvedValue([
      device({ id: 'bad', routingToken: 'route-bad', publicKey: 'broken' }),
      device({ id: 'good', routingToken: 'route-good', publicKey: GOOD_KEY }),
    ]);
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi' }]];
    vi.mocked(sealToDevice).mockResolvedValue('ct');

    const res = await pushOutbound('owner', 'ada');
    // The stored key is not a key: pruned, it could never be sent to.
    expect(res).toEqual({ attempted: 2, delivered: 1, dropped: 1 });
    expect(vi.mocked(sealToDevice).mock.calls.map((c) => c[0])).toEqual([GOOD_KEY]);
    expect(relayNotify).toHaveBeenCalledTimes(1); // only the good device reached the relay
    expect(deleteSubscriptionByRoutingToken).toHaveBeenCalledWith('route-bad');
  });

  it('a seal that fails on a well-formed key (libsodium did not load) skips and never prunes', async () => {
    vi.mocked(listAdminSubscriptions).mockResolvedValue([
      device({ id: 'a', routingToken: 'route-a', publicKey: GOOD_KEY }),
      device({ id: 'b', routingToken: 'route-b', publicKey: GOOD_KEY }),
    ]);
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi' }]];
    vi.mocked(sealToDevice).mockRejectedValue(new Error('libsodium failed to load'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await pushOutbound('owner', 'ada');
    expect(res).toEqual({ attempted: 2, delivered: 0, dropped: 0 });
    expect(deleteSubscriptionByRoutingToken).not.toHaveBeenCalled();
    expect(relayNotify).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('prunes a device the relay says it does not know (unregistered), and keeps it on any other failure', async () => {
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi' }]];
    vi.mocked(relayNotify).mockResolvedValue({ ok: false, status: 404, unregistered: true });
    const res = await pushOutbound('owner', 'ada');
    expect(res).toEqual({ attempted: 1, delivered: 0, dropped: 1 });
    expect(deleteSubscriptionByRoutingToken).toHaveBeenCalledWith('route-1');

    vi.mocked(deleteSubscriptionByRoutingToken).mockClear();
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi' }]];
    vi.mocked(relayNotify).mockResolvedValue({ ok: false, status: 404, unregistered: false });
    const kept = await pushOutbound('owner', 'ada');
    expect(kept).toEqual({ attempted: 1, delivered: 0, dropped: 0 });
    expect(deleteSubscriptionByRoutingToken).not.toHaveBeenCalled();
  });

  it('walks at most MAX_DEVICES_PER_SEND devices in one send', async () => {
    const { MAX_DEVICES_PER_SEND } = await import('./notify');
    vi.mocked(listAdminSubscriptions).mockResolvedValue(
      Array.from({ length: MAX_DEVICES_PER_SEND + 40 }, (_, i) =>
        device({ id: `d${i}`, routingToken: `r${i}` }),
      ),
    );
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi' }]];
    await pushOutbound('owner', 'ada');
    expect(relayNotify).toHaveBeenCalledTimes(MAX_DEVICES_PER_SEND);
  });
});

describe('pushOutbound: an event reminder names the event', () => {
  it('adds itemLink for a turn the reminders worker recorded, keeping the chat deepLink', async () => {
    dbState.queue = [
      [{ id: 'a1', name: 'Ada' }],
      [{ text: 'Reminder: dentist', data: { reminder: { kind: 'event', id: 'evt-123' } } }],
    ];
    await pushOutbound('owner', 'ada');
    const sent = JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1]);
    expect(sent).toMatchObject({ deepLink: '/chat/ada', itemLink: '/events/evt-123' });
  });

  it('an ordinary reply carries no itemLink', async () => {
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi', data: { location: {} } }]];
    await pushOutbound('owner', 'ada');
    const sent = JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1]);
    expect(sent).not.toHaveProperty('itemLink');
  });
});

describe('reminderItemLink', () => {
  it('maps an event or a task reminder to its app path', () => {
    expect(reminderItemLink({ reminder: { kind: 'event', id: 'e-1' } })).toBe('/events/e-1');
    expect(reminderItemLink({ reminder: { kind: 'task', id: 't-1' } })).toBe('/tasks/t-1');
  });

  it('is null for anything else, and for an id that is not a plain token', () => {
    expect(reminderItemLink(null)).toBeNull();
    expect(reminderItemLink({})).toBeNull();
    expect(reminderItemLink({ reminder: { kind: 'note', id: 'n-1' } })).toBeNull();
    expect(reminderItemLink({ reminder: { kind: 'event', id: '../pending' } })).toBeNull();
    expect(reminderItemLink({ reminder: { kind: 'event', id: 42 } })).toBeNull();
    expect(reminderItemLink({ reminder: { kind: 'event', id: '' } })).toBeNull();
  });
});

describe('opaqueCollapseKey: what the relay sees of a login push key', () => {
  it('is 32 hex, per login, and not computable from the relay instance token', async () => {
    const { createHmac } = await import('node:crypto');
    const a = opaqueCollapseKey('login-a', 'chat');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(opaqueCollapseKey('login-a', 'chat')).toBe(a); // stable: it still collapses
    expect(opaqueCollapseKey('login-b', 'chat')).not.toBe(a); // per login
    expect(opaqueCollapseKey('login-a', 'review:1')).not.toBe(a);
    // The relay holds the instance token: the key must not be its HMAC.
    const relayCould = createHmac('sha256', INSTANCE.instanceToken)
      .update('chat')
      .digest('hex')
      .slice(0, 32);
    expect(a).not.toBe(relayCould);
  });
});

describe('wantsOutboundPush — which conversation_changed events push', () => {
  it('pushes a finished outbound turn', () => {
    expect(wantsOutboundPush({ direction: 'outbound', status: 'complete' })).toBe(true);
  });
  it('treats a payload without status (pre-0156 trigger) as complete', () => {
    expect(wantsOutboundPush({ direction: 'outbound' })).toBe(true);
  });
  it('ignores the pending placeholder the durable runner inserts at turn start', () => {
    expect(wantsOutboundPush({ direction: 'outbound', status: 'pending' })).toBe(false);
  });
  it('ignores a failed turn (there is no reply to teaser)', () => {
    expect(wantsOutboundPush({ direction: 'outbound', status: 'failed' })).toBe(false);
  });
  it('never pushes inbound rows', () => {
    expect(wantsOutboundPush({ direction: 'inbound', status: 'complete' })).toBe(false);
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
    expect(listAdminSubscriptions).not.toHaveBeenCalled();
    expect(relayNotify).not.toHaveBeenCalled();
  });

  it('skips wrong_channel when reminderChannel is unset (defaults to Telegram)', async () => {
    vi.mocked(loadProfilePreferences).mockResolvedValue(
      {} as Awaited<ReturnType<typeof loadProfilePreferences>>,
    );
    expect((await pushApproval('owner')).skipped).toBe('wrong_channel');
  });

  it('skips no_devices when the owner has no devices', async () => {
    vi.mocked(listAdminSubscriptions).mockResolvedValue([]);
    expect((await pushApproval('owner')).skipped).toBe('no_devices');
  });

  it('skips no_message when nothing is pending', async () => {
    vi.mocked(countPending).mockResolvedValue(0);
    expect((await pushApproval('owner')).skipped).toBe('no_message');
    expect(relayNotify).not.toHaveBeenCalled();
  });

  it('delivers a singular nudge collapsed on "approvals"', async () => {
    vi.mocked(countPending).mockResolvedValue(1);
    // Default: an ordinary confirm-gated tool, not a runner question.
    vi.mocked(listPendingCalls).mockResolvedValue([]);
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

  it('puts a runner QUESTION on the lock screen instead of the generic nudge', async () => {
    // A parked run is blocking until answered — knowing WHICH decision is
    // waiting is what makes it worth stopping for. "An action needs your
    // approval" is fine for a tool you'll see when you tap through.
    vi.mocked(listPendingCalls).mockResolvedValue([
      { toolSlug: 'ask_human', args: { question: 'Deploy to production?' } },
    ] as never);
    await pushApproval('owner');
    const body = JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1]).b as string;
    expect(body).toBe('A run needs your answer: Deploy to production?');
  });

  it('mentions the others when more than one is waiting', async () => {
    vi.mocked(countPending).mockResolvedValue(3);
    vi.mocked(listPendingCalls).mockResolvedValue([
      { toolSlug: 'ask_human', args: { question: 'Deploy to production?' } },
    ] as never);
    await pushApproval('owner');
    const body = JSON.parse(vi.mocked(sealToDevice).mock.calls[0]![1]).b as string;
    expect(body).toBe('Deploy to production? (+2 more waiting)');
  });
});

describe('every push names the brain and the login its device was enrolled for', () => {
  const sealedFor = () =>
    vi.mocked(sealToDevice).mock.calls.map(([publicKey, plaintext]) => ({
      publicKey,
      payload: JSON.parse(plaintext) as Record<string, unknown>,
    }));

  it('an owner teaser to two admins: each device gets its own login, the same brain', async () => {
    vi.mocked(listAdminSubscriptions).mockResolvedValue([
      device({ id: 'a', routingToken: 'route-a', publicKey: 'pk-a', loginId: 'admin-a' }),
      device({ id: 'b', routingToken: 'route-b', publicKey: 'pk-b', loginId: 'admin-b' }),
    ]);
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi' }]];
    await pushOutbound('owner', 'ada');
    const sent = sealedFor();
    expect(sent.map((s) => [s.publicKey, s.payload.loginId, s.payload.brainId])).toEqual([
      ['pk-a', 'admin-a', BRAIN_ID],
      ['pk-b', 'admin-b', BRAIN_ID],
    ]);
    // The brain is read once per send, not once per device.
    expect(brainIdOrNull).toHaveBeenCalledTimes(1);
    // Everything that was there before is still there (additive).
    for (const { payload } of sent) {
      expect(payload).toMatchObject({ v: 1, t: 'Ada', b: 'hi', agentSlug: 'ada' });
      expect(payload).toHaveProperty('deepLink', '/chat/ada');
      expect(payload).toHaveProperty('ts');
    }
  });

  it('an approval carries both', async () => {
    await pushApproval('owner');
    expect(sealedFor()[0]!.payload).toMatchObject({
      deepLink: '/pending',
      brainId: BRAIN_ID,
      loginId: 'admin-1',
    });
  });

  it('a brain id the database cannot give is left out, and the push still goes', async () => {
    vi.mocked(brainIdOrNull).mockResolvedValue(null);
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi' }]];
    const res = await pushOutbound('owner', 'ada');
    expect(res.delivered).toBe(1);
    const payload = sealedFor()[0]!.payload;
    expect(payload).not.toHaveProperty('brainId');
    expect(payload.loginId).toBe('admin-1');
  });

  it('a device row with no login (pre-0173) names no login: never a guessed one', async () => {
    vi.mocked(listAdminSubscriptions).mockResolvedValue([device({ loginId: null })]);
    dbState.queue = [[{ id: 'a1', name: 'Ada' }], [{ text: 'hi' }]];
    await pushOutbound('owner', 'ada');
    const payload = sealedFor()[0]!.payload;
    expect(payload).not.toHaveProperty('loginId');
    expect(payload.brainId).toBe(BRAIN_ID);
  });
});

describe('payloadForDevice', () => {
  const content = { v: 1 as const, t: 'T', b: 'B', deepLink: '/x', ts: 5 };

  it('adds the brain and the login to the content, and changes nothing else', () => {
    expect(payloadForDevice(content, BRAIN_ID, 'login-1')).toEqual({
      ...content,
      brainId: BRAIN_ID,
      loginId: 'login-1',
    });
  });

  it('leaves out what it cannot name', () => {
    expect(payloadForDevice(content, null, null)).toEqual(content);
  });

  it('the routing pair always comes from the send, never from the content', () => {
    const smuggled = { ...content, brainId: 'other-brain', loginId: 'other-login' };
    expect(payloadForDevice(smuggled, BRAIN_ID, 'login-1')).toMatchObject({
      brainId: BRAIN_ID,
      loginId: 'login-1',
    });
    expect(payloadForDevice(smuggled, null, null)).not.toHaveProperty('brainId');
    expect(payloadForDevice(smuggled, null, null)).not.toHaveProperty('loginId');
  });
});
