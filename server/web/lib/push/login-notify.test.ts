// The send path for a member's or a client's own pushes (login-notify.ts):
// one message goes to the devices of the ONE login it is for, behind that
// login's own toggle, with the additive payload fields the phone app routes
// on. All I/O is mocked; who the store lists for a login is proven on
// Postgres (push-targeting.db.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginNoticeMessage } from '@mantle/content';

vi.mock('@mantle/db', () => ({ db: {}, agents: {}, assistantMessages: {} }));
vi.mock('@mantle/tools', () => ({ countPending: vi.fn(), listPendingCalls: vi.fn() }));
vi.mock('@mantle/content', () => ({
  loadProfilePreferences: vi.fn(),
  loadNeedsYou: vi.fn(),
  chatReplyNotice: vi.fn(),
  reviewResultNotice: vi.fn(),
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
  getLoginPushPrefs: vi.fn(),
  listAdminSubscriptions: vi.fn(),
  listLoginSubscriptions: vi.fn(),
  markPushed: vi.fn(),
  deleteSubscriptionByRoutingToken: vi.fn(),
}));

import { chatReplyNotice, reviewResultNotice } from '@mantle/content';
import { pushChatReply, pushReviewResult, pushToLogin } from './login-notify';
import { sealToDevice } from './seal';
import { relayNotify } from './relay-client';
import {
  getLoginPushPrefs,
  getPushInstance,
  listAdminSubscriptions,
  listLoginSubscriptions,
} from './store';

const NOW = Date.parse('2026-10-01T09:00:00Z');
const ALL_ON = { chatReplies: true, reviewResults: true };
const BRAIN_ID = '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f';
const device = (n: string, loginId = 'login-m') => ({
  id: `d-${n}`,
  routingToken: `r-${n}`,
  publicKey: `pk-${n}`,
  platform: 'ios' as const,
  label: null,
  loginId,
});
const message = (over: Partial<LoginNoticeMessage> = {}): LoginNoticeMessage => ({
  loginId: 'login-m',
  role: 'member',
  ownerId: 'brain',
  kind: 'chat',
  title: 'Tess',
  body: 'Here is the answer.',
  deepLink: '/portal/chat',
  collapseKey: 'chat',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPushInstance).mockResolvedValue({
    instanceToken: 't',
    relayInstanceId: 'i',
    relayUrl: 'https://relay.example',
  });
  vi.mocked(getLoginPushPrefs).mockResolvedValue(ALL_ON);
  vi.mocked(listLoginSubscriptions).mockResolvedValue([device('m')]);
  vi.mocked(sealToDevice).mockResolvedValue('ciphertext');
  vi.mocked(relayNotify).mockResolvedValue({ ok: true, status: 200 });
});

const sealed = (i = 0) =>
  JSON.parse(vi.mocked(sealToDevice).mock.calls[i]![1]) as Record<string, unknown>;

describe('pushToLogin', () => {
  it('sends to the devices of the one login it is for, and asks for no other list', async () => {
    const res = await pushToLogin(message(), NOW);
    expect(res).toEqual({ attempted: 1, delivered: 1, dropped: 0 });
    expect(listLoginSubscriptions).toHaveBeenCalledTimes(1);
    expect(listLoginSubscriptions).toHaveBeenCalledWith('brain', 'login-m');
    // Never the admins' devices.
    expect(listAdminSubscriptions).not.toHaveBeenCalled();
    expect(vi.mocked(sealToDevice).mock.calls.map((c) => c[0])).toEqual(['pk-m']);
    expect(sealed()).toEqual({
      v: 1,
      t: 'Tess',
      b: 'Here is the answer.',
      deepLink: '/portal/chat',
      ts: NOW,
      kind: 'chat',
      // The routing pair (multi-login): this brain, and the login the
      // device was enrolled for.
      brainId: BRAIN_ID,
      loginId: 'login-m',
    });
    // The collapse key goes out as a keyed hash: the relay and the push
    // provider see neither the kind of event nor an item id.
    const sent = vi.mocked(relayNotify).mock.calls[0]![2];
    expect(sent.routingToken).toBe('r-m');
    expect(sent.collapseKey).toMatch(/^[0-9a-f]{32}$/);
    expect(sent.collapseKey).not.toContain('chat');
  });

  it('the same event collapses on the same key, another event on another', async () => {
    const keyOf = async (collapseKey: string) => {
      vi.mocked(relayNotify).mockClear();
      await pushToLogin(message({ collapseKey }), NOW);
      return vi.mocked(relayNotify).mock.calls[0]![2].collapseKey;
    };
    const a = await keyOf('review:n1');
    expect(await keyOf('review:n1')).toBe(a);
    expect(await keyOf('review:n2')).not.toBe(a);
    expect(a).not.toContain('n1');
  });

  it('carries the item and the state on a review result', async () => {
    await pushToLogin(
      message({
        kind: 'review',
        title: 'Returned',
        body: '"Pump spec" was returned: add the units',
        deepLink: '/portal/items/n1',
        itemId: 'n1',
        state: 'returned',
        collapseKey: 'review:n1',
      }),
      NOW,
    );
    expect(sealed()).toMatchObject({
      kind: 'review',
      itemId: 'n1',
      state: 'returned',
      brainId: BRAIN_ID,
      loginId: 'login-m',
    });
    expect(vi.mocked(relayNotify).mock.calls[0]![2].collapseKey).not.toContain('n1');
  });

  it.each([
    ['chat', 'chatReplies'],
    ['review', 'reviewResults'],
  ] as const)('a %s push respects the login toggle %s', async (kind, pref) => {
    vi.mocked(getLoginPushPrefs).mockResolvedValue({ ...ALL_ON, [pref]: false });
    const res = await pushToLogin(message({ kind }), NOW);
    expect(res.skipped).toBe('disabled');
    expect(getLoginPushPrefs).toHaveBeenCalledWith('login-m');
    expect(listLoginSubscriptions).not.toHaveBeenCalled();
    expect(relayNotify).not.toHaveBeenCalled();
    // The other kind still goes.
    for (const other of ['chat', 'review'] as const) {
      if (other === kind) continue;
      expect((await pushToLogin(message({ kind: other }), NOW)).skipped).toBeUndefined();
    }
  });

  it('skips with no message, no relay, or no device', async () => {
    expect((await pushToLogin(null, NOW)).skipped).toBe('no_message');
    vi.mocked(listLoginSubscriptions).mockResolvedValue([]);
    expect((await pushToLogin(message(), NOW)).skipped).toBe('no_devices');
    vi.mocked(getPushInstance).mockResolvedValue(null);
    expect((await pushToLogin(message(), NOW)).skipped).toBe('not_connected');
    expect(relayNotify).not.toHaveBeenCalled();
  });
});

describe('the two events', () => {
  it('a chat reply pushes the message the content rules built', async () => {
    vi.mocked(chatReplyNotice).mockResolvedValue(message());
    const res = await pushChatReply({ kind: 'chat', loginId: 'login-m', id: 'msg-1' }, NOW);
    expect(res.delivered).toBe(1);
    expect(chatReplyNotice).toHaveBeenCalledWith({ kind: 'chat', loginId: 'login-m', id: 'msg-1' });
    // The rules said nobody is told (a stale row, an admin's thread): nothing.
    vi.mocked(chatReplyNotice).mockResolvedValue(null);
    expect(
      (await pushChatReply({ kind: 'chat', loginId: 'login-m', id: 'msg-2' }, NOW)).skipped,
    ).toBe('no_message');
  });

  it('a review result is one push for the whole bundle', async () => {
    vi.mocked(reviewResultNotice).mockResolvedValue(
      message({ kind: 'review', itemId: 'n1', state: 'accepted', collapseKey: 'review:n1' }),
    );
    const res = await pushReviewResult('login-m', 'accepted', ['n1', 'n2', 'n3'], NOW);
    expect(res).toEqual({ attempted: 1, delivered: 1, dropped: 0 });
    expect(reviewResultNotice).toHaveBeenCalledWith('login-m', 'accepted', ['n1', 'n2', 'n3']);
    expect(relayNotify).toHaveBeenCalledTimes(1);
  });
});
