// The push routes of a member or a client login (login-routes.ts), without a
// database: the enrol step needs the caller's OWN live device token, a
// client never registers the brain with the relay, and a login lists and
// removes only its own devices. The store and the relay are mocked.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const MEMBER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '12121212-1212-4212-8212-121212121212';
const ANCHOR = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  tokens: new Map<string, { userId: string; revokedAt: Date | null; expiresAt: Date }>(),
  instance: null as null | { instanceToken: string; relayInstanceId: string; relayUrl: string },
  registered: 0,
  inserted: [] as Array<Record<string, unknown>>,
  own: [] as Array<{ id: string; platform: string; label: string | null; tokenId: string | null }>,
  deleted: [] as Array<[string, string]>,
  prefs: { chatReplies: true, reviewResults: true, comments: true },
}));

vi.mock('@/lib/auth/login-row', () => ({
  loadBearerToken: async (jti: string) => h.tokens.get(jti) ?? null,
}));
vi.mock('./relay-client', () => ({
  registerInstance: vi.fn(async () => {
    h.registered += 1;
    return { instanceId: 'iid' };
  }),
  relayDeleteDevice: vi.fn(async () => true),
}));
vi.mock('./store', () => ({
  getPushInstance: vi.fn(async () => h.instance),
  savePushInstance: vi.fn(async (i: typeof h.instance) => {
    h.instance = i;
  }),
  insertSubscription: vi.fn(async (row: Record<string, unknown>) => {
    h.inserted.push(row);
    return { id: DEVICE_ID };
  }),
  listOwnDevices: vi.fn(async () => h.own),
  deleteOwnSubscription: vi.fn(async (loginId: string, id: string) => {
    h.deleted.push([loginId, id]);
    return id === DEVICE_ID ? 'routing-1' : null;
  }),
  getLoginPushPrefs: vi.fn(async () => h.prefs),
  updateLoginPushPrefs: vi.fn(async (_login: string, patch: Record<string, boolean>) => {
    h.prefs = { ...h.prefs, ...patch };
    return h.prefs;
  }),
}));

import { relayDeleteDevice } from './relay-client';
import {
  loginPushConnect,
  loginPushDevices,
  loginPushPrefs,
  loginPushPrefsUpdate,
  loginPushSubscribe,
  loginPushUnpair,
  type LoginPushCaller,
} from './login-routes';
import { buildMobileToken } from '@/lib/auth/tokens';

const member: LoginPushCaller = { role: 'member', loginId: MEMBER, anchorId: ANCHOR };
const client: LoginPushCaller = { role: 'client', loginId: CLIENT, anchorId: ANCHOR };

let savedSecret: string | undefined;
let savedKey: string | undefined;
beforeAll(() => {
  savedSecret = process.env.SESSION_SECRET;
  savedKey = process.env.MANTLE_MASTER_KEY;
  process.env.SESSION_SECRET = 'login-push-routes-secret-at-least-32-chars!!';
  process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
  if (savedKey === undefined) delete process.env.MANTLE_MASTER_KEY;
});

beforeEach(() => {
  vi.clearAllMocks();
  h.tokens.clear();
  h.instance = null;
  h.registered = 0;
  h.inserted = [];
  h.own = [];
  h.deleted = [];
  h.prefs = { chatReplies: true, reviewResults: true, comments: true };
});

/** A bearer for `login` with its token row; returns the header and the jti. */
const bearerFor = (login: string, row: { revoked?: boolean; userId?: string } = {}) => {
  const jti = randomUUID();
  const t = buildMobileToken(login, jti, 3600);
  h.tokens.set(jti, {
    userId: row.userId ?? login,
    revokedAt: row.revoked ? new Date() : null,
    expiresAt: t.expiresAt,
  });
  return { jti, header: `Bearer ${t.value}` };
};
const req = (method: string, body?: unknown, authorization?: string) =>
  new Request('https://brain.example.invalid/api/member/push/x', {
    method,
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ENROL = {
  routingToken: 'routing-1',
  publicKey: 'pk-1',
  platform: 'ios',
  label: ' My phone ',
};

describe('connect', () => {
  const body = { platform: 'android', osPushToken: 'os-token' };

  it('a member may be the first to register the brain with the relay', async () => {
    const res = await loginPushConnect(req('POST', body), member);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ticket: expect.any(String),
      relayUrl: expect.any(String),
    });
    expect(h.registered).toBe(1);
  });

  it('a client never registers it: 409 until push is set up, then a ticket', async () => {
    const off = await loginPushConnect(req('POST', body), client);
    expect(off.status).toBe(409);
    expect(await off.json()).toEqual({ error: 'push_not_set_up' });
    expect(h.registered).toBe(0);
    h.instance = { instanceToken: 't', relayInstanceId: 'iid', relayUrl: 'https://relay.example' };
    const on = await loginPushConnect(req('POST', body), client);
    expect(on.status).toBe(200);
    expect(h.registered).toBe(0);
  });

  it('refuses a body that is not a connect request', async () => {
    for (const bad of [{}, { platform: 'web', osPushToken: 'x' }, { platform: 'ios' }]) {
      expect((await loginPushConnect(req('POST', bad), member)).status).toBe(400);
    }
  });
});

describe('subscribe', () => {
  it('stores the device under the caller, its brain and the token it signed in with', async () => {
    const { jti, header } = bearerFor(MEMBER);
    const res = await loginPushSubscribe(req('POST', ENROL, header), member);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: DEVICE_ID });
    expect(h.inserted).toEqual([
      {
        ownerId: ANCHOR,
        loginId: MEMBER,
        tokenId: jti,
        routingToken: 'routing-1',
        publicKey: 'pk-1',
        platform: 'ios',
        label: 'My phone',
        relayDeviceId: null,
      },
    ]);
  });

  it('needs a live bearer of the caller: none, revoked or another login is refused', async () => {
    const cases = [
      undefined,
      bearerFor(MEMBER, { revoked: true }).header,
      bearerFor(CLIENT).header, // someone else's token in the header
      bearerFor(MEMBER, { userId: CLIENT }).header, // a row that names another login
      'Bearer not-a-token',
    ];
    for (const authorization of cases) {
      const res = await loginPushSubscribe(req('POST', ENROL, authorization), member);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bearer_required' });
    }
    expect(h.inserted).toHaveLength(0);
  });

  it('refuses a body without a routing token, a key or a platform', async () => {
    const { header } = bearerFor(CLIENT);
    for (const bad of [
      {},
      { ...ENROL, platform: 'web' },
      { ...ENROL, routingToken: '' },
      { ...ENROL, publicKey: 7 },
    ]) {
      const res = await loginPushSubscribe(req('POST', bad, header), client);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_body' });
    }
    expect(h.inserted).toHaveLength(0);
  });
});

describe('devices and toggles', () => {
  it('lists the caller own devices, metadata only, and marks the calling one', async () => {
    const { jti, header } = bearerFor(MEMBER);
    h.own = [
      { id: 'a', platform: 'ios', label: 'This phone', tokenId: jti },
      { id: 'b', platform: 'android', label: null, tokenId: 'another-token' },
    ];
    const res = await loginPushDevices(req('GET', undefined, header), member);
    expect(await res.json()).toEqual({
      devices: [
        { id: 'a', platform: 'ios', label: 'This phone', current: true },
        { id: 'b', platform: 'android', label: null, current: false },
      ],
    });
  });

  it('unpairs only a device of the caller', async () => {
    const ok = await loginPushUnpair(member, DEVICE_ID);
    expect(ok.status).toBe(200);
    expect(h.deleted).toEqual([[MEMBER, DEVICE_ID]]);
    const other = await loginPushUnpair(member, '55555555-5555-4555-8555-555555555555');
    expect(other.status).toBe(404);
    expect((await loginPushUnpair(member, 'not-an-id')).status).toBe(404);
    // The relay is told only when a device was removed (and push is set up).
    expect(relayDeleteDevice).not.toHaveBeenCalled();
    h.instance = { instanceToken: 't', relayInstanceId: 'iid', relayUrl: 'https://relay.example' };
    await loginPushUnpair(member, DEVICE_ID);
    expect(relayDeleteDevice).toHaveBeenCalledWith('https://relay.example', 't', 'routing-1');
  });

  it('reads and patches the caller own toggles; unknown fields are ignored', async () => {
    expect(await (await loginPushPrefs(client)).json()).toEqual({
      chatReplies: true,
      reviewResults: true,
      comments: true,
    });
    const res = await loginPushPrefsUpdate(
      req('PUT', { comments: false, chatReplies: 'no', assistantMessages: false }),
      client,
    );
    expect(await res.json()).toEqual({ chatReplies: true, reviewResults: true, comments: false });
    expect((await loginPushPrefsUpdate(req('PUT', [1]), client)).status).toBe(400);
  });
});
