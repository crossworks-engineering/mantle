/**
 * WHO a push goes to, on a real migrated Postgres, through the real store and
 * the real send path (only the relay, the sealing and the brain-wide
 * singletons are stood in). This is the gate for members and clients on the
 * phone app (migration 0211):
 *
 *  - the owner's assistant teaser, an approval and a "needs you" notice go to
 *    the devices of ACTIVE ADMIN logins and to no other device: a member's
 *    device and a client's device, enrolled and live, never receive one;
 *  - an agent assigned to one admin pushes to that admin only;
 *  - a member's or a client's own push goes to that ONE login's devices,
 *    and only while the token that enrolled the device is live;
 *  - one phone belongs to one login, and a signed-out token takes its
 *    devices with it.
 *
 * Before 0211 pushOutbound and pushApproval listed every device of the brain.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/push/push-targeting.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  /** Every relay send: the routing token it was aimed at. */
  sent: [] as string[],
  /** What was sealed, by public key. */
  sealed: [] as Array<{ publicKey: string; payload: Record<string, unknown> }>,
  needsYou: null as unknown,
}));

// The relay and the sealing: record instead of sending.
vi.mock('./relay-client', () => ({
  relayNotify: vi.fn(async (_url: string, _token: string, args: { routingToken: string }) => {
    h.sent.push(args.routingToken);
    return { ok: true, status: 200 };
  }),
  relayDeleteDevice: vi.fn(async () => true),
  registerInstance: vi.fn(),
}));
vi.mock('./seal', () => ({
  sealToDevice: vi.fn(async (publicKey: string, plaintext: string) => {
    h.sealed.push({ publicKey, payload: JSON.parse(plaintext) as Record<string, unknown> });
    return 'ciphertext';
  }),
}));
// The brain-wide singletons (one row per database, shared by every test
// file): stood in. Everything about DEVICES is the real store.
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  getPushInstance: async () => ({
    instanceToken: 'itok',
    relayInstanceId: 'iid',
    relayUrl: 'https://relay.example.invalid',
  }),
  getPushPrefs: async () => ({ assistantMessages: true, approvals: true }),
}));
vi.mock('@mantle/tools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countPending: async () => 1,
  listPendingCalls: async () => [],
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadProfilePreferences: async () => ({ reminderChannel: 'mobile' }),
  loadNeedsYou: async () => h.needsYou,
}));

describe.skipIf(!URL)('push targeting: who a push goes to', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let store: typeof import('./store');
  let notify: typeof import('./notify');
  let loginNotify: typeof import('./login-notify');
  const tag = `ptarget-${randomUUID().slice(0, 8)}`;
  const brain = randomUUID();
  const otherBrain = randomUUID();
  const admin1 = randomUUID(); // a device from before 0211 (no token on record)
  const admin2 = randomUUID(); // a device with a live token
  const admin3 = randomUUID(); // a device whose token was revoked
  const goneAdmin = randomUUID(); // deactivated
  const member = randomUUID();
  const client = randomUUID();
  const logins = [admin1, admin2, admin3, goneAdmin, member, client];
  const agentAll = randomUUID();
  const agentOfAdmin2 = randomUUID();
  const rt = (label: string) => `${tag}-${label}`;

  const token = async (login: string, opts: { revoked?: boolean; expired?: boolean } = {}) => {
    const id = randomUUID();
    await sql`insert into mobile_tokens (id, user_id, label, expires_at, revoked_at)
              values (${id}, ${login}, ${tag},
                      ${opts.expired ? sql`now() - interval '1 minute'` : sql`now() + interval '30 days'`},
                      ${opts.revoked ? sql`now()` : null})`;
    return id;
  };
  const device = (owner: string, login: string | null, label: string, tokenId: string | null) =>
    sql`insert into push_subscriptions
          (owner_id, login_id, token_id, routing_token, public_key, platform, label)
        values (${owner}, ${login}, ${tokenId}, ${rt(label)}, ${`pk-${label}`}, 'ios', ${label})`;
  const labels = (rows: Array<{ label: string | null }>) => rows.map((r) => r.label).sort();
  const sentTo = () => [...h.sent].sort();

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    await m.ensureViewerRoles(sql, process.env.MANTLE_MASTER_KEY);
    store = await import('./store');
    notify = await import('./notify');
    loginNotify = await import('./login-notify');
    for (const [id, role] of [
      [admin1, 'admin'],
      [admin2, 'admin'],
      [admin3, 'admin'],
      [goneAdmin, 'admin'],
      [member, 'member'],
      [client, 'client'],
    ] as const) {
      await sql`insert into auth.users (id, email, password_hash, role)
                values (${id}, ${`${tag}-${id.slice(0, 8)}@example.invalid`}, 'x', ${role})`;
    }
    await sql`update auth.users set disabled_at = now() where id = ${goneAdmin}`;
    await device(brain, admin1, 'admin1-legacy', null);
    await device(brain, admin2, 'admin2-live', await token(admin2));
    await device(brain, admin3, 'admin3-revoked', await token(admin3, { revoked: true }));
    await device(brain, goneAdmin, 'gone-admin', await token(goneAdmin));
    await device(brain, member, 'member-live', await token(member));
    await device(brain, client, 'client-live', await token(client));
    await device(brain, null, 'no-login', null);
    await device(otherBrain, admin1, 'other-brain', null);

    await sql`insert into agents (id, owner_id, slug, name, model, system_prompt) values
      (${agentAll}, ${brain}, ${`${tag}-all`}, 'Ada', 'test/model', 'x'),
      (${agentOfAdmin2}, ${brain}, ${`${tag}-own`}, 'Own', 'test/model', 'x')`;
    await sql`update agents set assigned_user_id = ${admin2}, assigned_at = now()
              where id = ${agentOfAdmin2}`;
    for (const agent of [agentAll, agentOfAdmin2]) {
      await sql`insert into assistant_messages (owner_id, agent_id, direction, text, status)
                values (${brain}, ${agent}, 'outbound', 'OWNER SECRET: the quarterly numbers', 'complete')`;
    }
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from push_subscriptions where routing_token like ${`${tag}-%`}`;
    await sql`delete from assistant_messages where owner_id = ${brain}`;
    await sql`delete from agents where owner_id = ${brain}`;
    await sql`delete from mobile_tokens where user_id in ${sql(logins)}`;
    await sql`delete from push_login_prefs where login_id in ${sql(logins)}`;
    await sql`delete from spaces where login_id in ${sql(logins)}`;
    for (const id of logins) await sql`delete from auth.users where id = ${id}`;
    await m.closeDb();
  });

  beforeEach(() => {
    h.sent = [];
    h.sealed = [];
  });

  const ADMIN_DEVICES = [rt('admin1-legacy'), rt('admin2-live')].sort();

  it('the store offers no list of every device on the brain to send to', () => {
    expect(Object.keys(store)).not.toContain('listSubscriptions');
  });

  it("the owner's assistant teaser goes to active admin devices only", async () => {
    const res = await notify.pushOutbound(brain, `${tag}-all`);
    expect(res).toMatchObject({ attempted: 2, delivered: 2 });
    expect(sentTo()).toEqual(ADMIN_DEVICES);
    // The gate: a member device and a client device, both enrolled and
    // live, never receive the owner's teaser.
    expect(h.sent).not.toContain(rt('member-live'));
    expect(h.sent).not.toContain(rt('client-live'));
    expect(h.sealed.map((s) => s.publicKey).sort()).toEqual(['pk-admin1-legacy', 'pk-admin2-live']);
    expect(h.sealed.every((s) => String(s.payload.b).includes('OWNER SECRET'))).toBe(true);
  });

  it('an agent assigned to one admin pushes to that admin only', async () => {
    const res = await notify.pushOutbound(brain, `${tag}-own`);
    expect(res).toMatchObject({ attempted: 1, delivered: 1 });
    expect(sentTo()).toEqual([rt('admin2-live')]);
    // The assigned login is no longer an active admin: nobody, never "everyone".
    await sql`update auth.users set disabled_at = now() where id = ${admin2}`;
    h.sent = [];
    expect((await notify.pushOutbound(brain, `${tag}-own`)).skipped).toBe('no_devices');
    expect(h.sent).toEqual([]);
    await sql`update auth.users set disabled_at = null where id = ${admin2}`;
  });

  it('an approval goes to active admin devices only', async () => {
    const res = await notify.pushApproval(brain);
    expect(res).toMatchObject({ attempted: 2, delivered: 2 });
    expect(sentTo()).toEqual(ADMIN_DEVICES);
  });

  it('a "needs you" notice goes to active admin devices only', async () => {
    const at = new Date().toISOString();
    h.needsYou = {
      review: {
        submitted: 1,
        leftBehind: 0,
        newest: { id: randomUUID(), title: 'Pump spec', from: 'Mia', at },
      },
      requests: { open: 0, newest: null },
      total: 1,
    };
    const res = await notify.pushNeedsYou(brain, new Set());
    expect(res).toMatchObject({ attempted: 2, delivered: 2 });
    expect(sentTo()).toEqual(ADMIN_DEVICES);
  });

  it('lists for a member or a client only its own live devices', async () => {
    expect(labels(await store.listLoginSubscriptions(brain, member))).toEqual(['member-live']);
    expect(labels(await store.listLoginSubscriptions(brain, client))).toEqual(['client-live']);
    // An admin is never a target of a login push, whatever its devices.
    for (const admin of [admin1, admin2, admin3]) {
      expect(await store.listLoginSubscriptions(brain, admin)).toEqual([]);
    }
    // Another brain's id lists nothing.
    expect(await store.listLoginSubscriptions(otherBrain, member)).toEqual([]);
  });

  it("a member's own push reaches that member's device and no other", async () => {
    const res = await loginNotify.pushToLogin({
      loginId: member,
      role: 'member',
      ownerId: brain,
      kind: 'chat',
      title: 'Tess',
      body: 'for the member',
      deepLink: '/portal/chat',
      collapseKey: 'chat',
    });
    expect(res).toMatchObject({ attempted: 1, delivered: 1 });
    expect(h.sent).toEqual([rt('member-live')]);
    h.sent = [];
    await loginNotify.pushToLogin({
      loginId: client,
      role: 'client',
      ownerId: brain,
      kind: 'comment',
      title: 'New comment',
      body: 'for the client',
      deepLink: '/portal/shared/x',
      collapseKey: 'comment:x',
    });
    expect(h.sent).toEqual([rt('client-live')]);
  });

  it('a login toggle switches its own kind off, and nobody else', async () => {
    await store.updateLoginPushPrefs(member, { chatReplies: false });
    const chat = {
      role: 'member' as const,
      ownerId: brain,
      kind: 'chat' as const,
      title: 't',
      body: 'b',
      deepLink: '/portal/chat',
      collapseKey: 'chat',
    };
    expect((await loginNotify.pushToLogin({ ...chat, loginId: member })).skipped).toBe('disabled');
    expect(
      (await loginNotify.pushToLogin({ ...chat, loginId: client, role: 'client' })).delivered,
    ).toBe(1);
    expect(await store.getLoginPushPrefs(member)).toEqual({
      chatReplies: false,
      reviewResults: true,
      comments: true,
    });
    await store.updateLoginPushPrefs(member, { chatReplies: true });
  });

  it('a device is pushed to only while the token that enrolled it is live', async () => {
    const [row] = await sql<{ token_id: string }[]>`
      select token_id from push_subscriptions where routing_token = ${rt('member-live')}`;
    const tokenId = row!.token_id;
    const listed = async () => labels(await store.listLoginSubscriptions(brain, member));

    await sql`update mobile_tokens set revoked_at = now() where id = ${tokenId}`;
    expect(await listed()).toEqual([]);
    await sql`update mobile_tokens set revoked_at = null, expires_at = now() - interval '1 second'
              where id = ${tokenId}`;
    expect(await listed()).toEqual([]);
    await sql`update mobile_tokens set expires_at = now() + interval '30 days' where id = ${tokenId}`;
    expect(await listed()).toEqual(['member-live']);

    // A device with no token on record (never possible through the routes
    // for a member), or with another login's token: not listed.
    await sql`update push_subscriptions set token_id = null where routing_token = ${rt('member-live')}`;
    expect(await listed()).toEqual([]);
    const foreign = await token(client);
    await sql`update push_subscriptions set token_id = ${foreign}
              where routing_token = ${rt('member-live')}`;
    expect(await listed()).toEqual([]);
    await sql`update push_subscriptions set token_id = ${tokenId}
              where routing_token = ${rt('member-live')}`;
    expect(await listed()).toEqual(['member-live']);

    // A deactivated member: nothing, though the token row is still live.
    await sql`update auth.users set disabled_at = now() where id = ${member}`;
    expect(await listed()).toEqual([]);
    await sql`update auth.users set disabled_at = null where id = ${member}`;
  });

  it("an admin's settings list never shows a member's or a client's device", async () => {
    const list = labels(await store.listAdminDeviceList(brain));
    expect(list).toEqual(
      ['admin1-legacy', 'admin2-live', 'admin3-revoked', 'gone-admin', 'no-login'].sort(),
    );
    expect(labels(await store.listOwnDevices(member))).toEqual(['member-live']);
    expect(labels(await store.listOwnDevices(client))).toEqual(['client-live']);
  });

  it('one phone belongs to one login: enrolling its routing token again replaces the row', async () => {
    const phone = rt('shared-phone');
    const first = await store.insertSubscription({
      ownerId: brain,
      loginId: member,
      tokenId: await token(member),
      routingToken: phone,
      publicKey: 'pk-phone',
      platform: 'android',
      label: 'shared-phone',
    });
    // The same phone, now signed in as the client.
    const second = await store.insertSubscription({
      ownerId: brain,
      loginId: client,
      tokenId: await token(client),
      routingToken: phone,
      publicKey: 'pk-phone',
      platform: 'android',
      label: 'shared-phone',
    });
    expect(second.id).not.toBe(first.id);
    const rows = await sql<{ login_id: string }[]>`
      select login_id from push_subscriptions where routing_token = ${phone}`;
    expect(rows.map((r) => r.login_id)).toEqual([client]);
    expect(labels(await store.listLoginSubscriptions(brain, member))).toEqual(['member-live']);
    // A login removes only its own device.
    expect(await store.deleteOwnSubscription(member, second.id)).toBeNull();
    expect(await store.deleteOwnSubscription(client, second.id)).toBe(phone);
  });

  it('a token that signs out takes the devices it enrolled with it', async () => {
    const jti = await token(member);
    await store.insertSubscription({
      ownerId: brain,
      loginId: member,
      tokenId: jti,
      routingToken: rt('second-phone'),
      publicKey: 'pk-second',
      platform: 'ios',
      label: 'second-phone',
    });
    expect(await store.deleteTokenSubscriptions(jti)).toEqual([rt('second-phone')]);
    expect(labels(await store.listOwnDevices(member))).toEqual(['member-live']);
    // The admins' rows without a token are never touched by it.
    expect(labels(await store.listAdminSubscriptions(brain))).toEqual(
      ['admin1-legacy', 'admin2-live'].sort(),
    );
  });
});
