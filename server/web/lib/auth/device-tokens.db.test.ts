/**
 * The phone app's device tokens for all three roles, end to end on a real
 * migrated Postgres, through the real app (createApp):
 *
 *  - POST /api/auth/device-login signs an admin or a member in and names the
 *    role; the frozen /api/auth/mobile-login is unchanged (admins only, no
 *    role in the answer); a client email never opens with a password;
 *  - the emailed client code in device mode answers a device token: 30 days,
 *    held to the login's session epoch, listed under the login's devices;
 *  - a member token reaches member routes only, a client token client routes
 *    only, and GET /api/auth/whoami tells each which shell is its own;
 *  - every way a client token ends: the device is revoked, an admin ends the
 *    sessions, the login is disabled, the client signs out in the browser,
 *    the client signs out on the phone (which ends its browser session too);
 *  - refresh rotates a token of each role; a client's keeps the epoch and
 *    the 30 days, and the push devices follow the new token;
 *  - a member or a client enrols, lists and removes only its own push
 *    devices, and a sign-out removes them;
 *  - the unread count and the read cursor of the login's own chat thread.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/auth/device-tokens.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

// Never the network: an unpair tells the relay only when this database holds
// a relay identity, which another test file may have left.
vi.mock('../push/relay-client', () => ({
  relayNotify: vi.fn(async () => ({ ok: true, status: 200 })),
  relayDeleteDevice: vi.fn(async () => true),
  registerInstance: vi.fn(async () => {
    throw new Error('no relay in tests');
  }),
}));

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

describe.skipIf(!URL)('device tokens for an admin, a member and a client', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('./tokens');
  let content: typeof import('@mantle/content');
  const tag = `dtok-${randomUUID().slice(0, 8)}`;
  const admin = randomUUID();
  const member = randomUUID();
  const made: string[] = [];
  const PASSWORD = 'a long enough password';
  const emailOf = (s: string) => `${tag}-${s}@example.com`;
  let anchor = '';
  let ip = 0;
  const DAY = 24 * 60 * 60;

  const call = async (
    path: string,
    init: { method?: string; cookie?: string; bearer?: string; body?: unknown } = {},
  ) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // A fresh address per call keeps the per-IP limits out of the way.
      'x-forwarded-for': `203.0.113.${ip % 250}`,
    };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    return app.request(path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  };
  const json = async (res: Response) => (await res.json()) as Json;
  const asAdmin = () => `mantle_session=${tokens.buildSessionCookie(admin).value}`;
  const clientProbe = (auth: { cookie?: string; bearer?: string }) =>
    call('/api/client/shared/not-a-uuid', auth).then((r) => r.status);
  const memberProbe = (auth: { cookie?: string; bearer?: string }) =>
    call('/api/member/space/not-a-uuid', auth).then((r) => r.status);
  const deviceLogin = (email: string, password = PASSWORD, deviceName?: string) =>
    call('/api/auth/device-login', { method: 'POST', body: { email, password, deviceName } });

  /** A client login (made directly: adding one through the admin routes is
   *  client-session.db.test.ts's subject). */
  const addClient = async (name: string): Promise<string> => {
    const id = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role, display_name)
              values (${id}, ${emailOf(name)}, 'x', 'client', ${name})`;
    made.push(id);
    return id;
  };
  /** The emailed code, as the worker would mail it. */
  const mailedCode = async (name: string) => {
    const requestId = randomUUID();
    const d = await content.createClientEmailCode({
      email: emailOf(name),
      requestId,
      ip: `198.51.100.${(ip += 1) % 250}`,
      requestedAt: new Date().toISOString(),
    });
    expect(d.kind).toBe('send');
    return { requestId, code: d.kind === 'send' ? d.code : '' };
  };
  /** Sign a client in on a phone: the device token and its device id. */
  const clientPhone = async (name: string, deviceName = 'Client phone') => {
    const { requestId, code } = await mailedCode(name);
    const res = await call('/api/auth/client-code/verify', {
      method: 'POST',
      body: { email: emailOf(name), code, requestId, deviceName },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = await json(res);
    return { token: body.token as string, deviceId: body.deviceId as string, body };
  };
  /** Sign a client in in a browser (the cookie flow of the same code). */
  const clientBrowser = async (name: string) => {
    const { requestId, code } = await mailedCode(name);
    const res = await call('/api/auth/client-code/verify', {
      method: 'POST',
      cookie: `mantle_code_req=${requestId}`,
      body: { email: emailOf(name), code },
    });
    expect(res.status).toBe(200);
    const set = /mantle_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '');
    return `mantle_session=${set![1]}`;
  };
  const enrol = (base: string, bearer: string, routingToken: string) =>
    call(`${base}/subscriptions`, {
      method: 'POST',
      bearer,
      body: { routingToken, publicKey: 'pk', platform: 'ios', label: routingToken },
    });
  const pushRows = (login: string) =>
    sql<Row[]>`select id, token_id, routing_token from push_subscriptions
               where login_id = ${login} order by created_at`;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'device-tokens-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./tokens');
    content = await import('@mantle/content');
    anchor = await ensureTestAnchor(sql);
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await sql`insert into auth.users (id, email, password_hash, role, display_name) values
      (${admin}, ${emailOf('admin')}, ${hash}, 'admin', 'Ada Admin'),
      (${member}, ${emailOf('member')}, ${hash}, 'member', 'Mia Member')`;
    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    const all = [...made, admin, member];
    await sql`delete from push_subscriptions where login_id in ${sql(all)}`;
    await sql`delete from audit_log where actor_email like ${`${tag}%`}`;
    await sql`delete from client_signin_codes where login_id in ${sql(all)}`;
    await sql`delete from team_messages where login_id in ${sql(all)}`;
    await sql`delete from mobile_tokens where user_id in ${sql(all)}`;
    await sql`delete from spaces where login_id in ${sql(all)}`;
    await sql`delete from auth.users where id in ${sql(all)}`;
  });

  // ── Admin and member: device-login ──────────────────────────────────────

  it('device-login signs a member in, names the role, and the token reaches member routes only', async () => {
    const res = await deviceLogin(emailOf('member'), PASSWORD, 'Mia phone');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = await json(res);
    expect(body).toMatchObject({ role: 'member', loginId: member, expiresIn: 30 * DAY });
    const bearer = body.token as string;
    expect(await memberProbe({ bearer })).toBe(400); // past the member gate
    for (const path of ['/api/shell', '/api/client/shell', '/api/push/subscriptions']) {
      const refused = await call(path, { bearer });
      expect(refused.status, path).toBe(403);
      expect((await json(refused)).reason, path).toBe('member-login');
    }
    expect(await json(await call('/api/auth/whoami', { bearer }))).toEqual({
      role: 'member',
      loginId: member,
      email: emailOf('member'),
      displayName: 'Mia Member',
      shell: '/api/member/shell',
      pushBase: '/api/member/push',
    });
    // Listed under the login's devices, and revocable there.
    const devices = await json(await call(`/api/users/${member}/devices`, { cookie: asAdmin() }));
    const listed = (devices.devices as Array<{ id: string; label: string }>).find(
      (d) => d.id === body.deviceId,
    );
    expect(listed?.label).toBe('Mia phone');
    const revoke = await call(`/api/users/${member}/devices/${body.deviceId}`, {
      method: 'DELETE',
      cookie: asAdmin(),
    });
    expect(revoke.status).toBe(200);
    expect(await memberProbe({ bearer })).toBe(401);
    expect((await call('/api/auth/whoami', { bearer })).status).toBe(401);
  });

  it('device-login signs an admin in; a wrong password and a client email are the same 401', async () => {
    const res = await deviceLogin(emailOf('admin'));
    const body = await json(res);
    expect(body).toMatchObject({ role: 'admin', loginId: admin });
    const who = await json(await call('/api/auth/whoami', { bearer: body.token as string }));
    expect(who).toMatchObject({ role: 'admin', shell: '/api/shell', pushBase: '/api/push' });
    // Past the admin gate (a malformed id is the handler's own 400).
    expect(
      (await call('/api/admin/space/not-a-uuid', { bearer: body.token as string })).status,
    ).toBe(400);

    const wrong = await deviceLogin(emailOf('member'), 'not the password');
    expect(wrong.status).toBe(401);
    // A client has no password; even one set by hand never opens it.
    const id = await addClient('pw');
    await sql`update auth.users set password_hash = ${bcrypt.hashSync(PASSWORD, 4)} where id = ${id}`;
    const client = await deviceLogin(emailOf('pw'));
    expect(client.status).toBe(401);
    expect(await json(client)).toEqual(await json(wrong));
    const none = await sql<Row[]>`select id from mobile_tokens where user_id = ${id}`;
    expect(none).toHaveLength(0);
  });

  it('the frozen mobile-login is unchanged: admins only, no role in the answer', async () => {
    const adminRes = await call('/api/auth/mobile-login', {
      method: 'POST',
      body: { email: emailOf('admin'), password: PASSWORD },
    });
    expect(adminRes.status).toBe(200);
    const body = await json(adminRes);
    expect(Object.keys(body).sort()).toEqual(['deviceId', 'expiresAt', 'expiresIn', 'token']);
    expect(body.expiresIn).toBe(365 * DAY);
    const memberRes = await call('/api/auth/mobile-login', {
      method: 'POST',
      body: { email: emailOf('member'), password: PASSWORD },
    });
    expect(memberRes.status).toBe(403);
    expect((await json(memberRes)).reason).toBe('member-login');
  });

  // ── Client: the emailed code in device mode ─────────────────────────────

  it('the emailed code in device mode gives a 30-day device token for client routes only', async () => {
    const id = await addClient('ada');
    const before = Math.floor(Date.now() / 1000);
    const phone = await clientPhone('ada', 'Ada phone');
    expect(phone.body).toMatchObject({ ok: true, role: 'client', loginId: id });
    expect(phone.body.expiresIn).toBe(30 * DAY);
    const claims = tokens.verifyMobileToken(phone.token)!;
    expect(claims.ep).toBe(0);
    expect(claims.exp).toBeLessThanOrEqual(before + 30 * DAY + 60);
    const bearer = phone.token;

    expect(await clientProbe({ bearer })).toBe(400); // past the client gate
    const shell = await call('/api/client/shell', { bearer });
    expect(shell.status).toBe(200);
    expect(await json(await call('/api/auth/whoami', { bearer }))).toEqual({
      role: 'client',
      loginId: id,
      email: emailOf('ada'),
      displayName: 'ada',
      shell: '/api/client/shell',
      pushBase: '/api/client/push',
    });
    for (const path of ['/api/shell', '/api/member/shell', '/api/member/chat']) {
      const refused = await call(path, { bearer });
      expect(refused.status, path).toBe(403);
      expect((await json(refused)).reason, path).toBe('client-login');
    }

    // Pictures: the client's byte routes take the bearer, or the shell's
    // asset token; a member's byte route takes neither.
    const at = encodeURIComponent((await json(shell)).assetToken as string);
    expect((await call('/api/client/files/not-a-uuid', { bearer })).status).toBe(400);
    expect((await call(`/api/client/files/not-a-uuid?at=${at}`)).status).toBe(400);
    expect((await call('/api/member/files/not-a-uuid', { bearer })).status).toBe(401);
    expect((await call(`/api/member/files/not-a-uuid?at=${at}`)).status).toBe(401);

    // The code was one use, and the device is listed under the login.
    const devices = await json(await call(`/api/users/${id}/devices`, { cookie: asAdmin() }));
    expect((devices.devices as Array<{ id: string }>).map((d) => d.id)).toEqual([phone.deviceId]);
  });

  it('a device-mode verify needs the request id the app was given', async () => {
    await addClient('ben');
    const { requestId, code } = await mailedCode('ben');
    const verify = (body: Json, cookie?: string) =>
      call('/api/auth/client-code/verify', { method: 'POST', body, cookie });
    // Another request id, or a malformed one with the right cookie: refused.
    const other = await verify({ email: emailOf('ben'), code, requestId: randomUUID() });
    expect(other.status).toBe(401);
    const bad = await verify(
      { email: emailOf('ben'), code, requestId: 'nope' },
      `mantle_code_req=${requestId}`,
    );
    expect(bad.status).toBe(401);
    const ok = await verify({ email: emailOf('ben'), code, requestId });
    expect(ok.status).toBe(200);
    // One use.
    expect((await verify({ email: emailOf('ben'), code, requestId })).status).toBe(401);
  });

  it('an admin revoking the device, ending the sessions or disabling the login ends the token', async () => {
    const id = await addClient('cy');
    const first = await clientPhone('cy');
    expect(await clientProbe({ bearer: first.token })).toBe(400);
    const revoke = await call(`/api/users/${id}/devices/${first.deviceId}`, {
      method: 'DELETE',
      cookie: asAdmin(),
    });
    expect(revoke.status).toBe(200);
    expect(await clientProbe({ bearer: first.token })).toBe(401);

    const second = await clientPhone('cy');
    const end = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { signOut: true },
    });
    expect(end.status).toBe(200);
    expect(await clientProbe({ bearer: second.token })).toBe(401);
    // It cannot refresh its way back in.
    expect(
      (await call('/api/auth/token/refresh', { method: 'POST', bearer: second.token })).status,
    ).toBe(401);

    const third = await clientPhone('cy');
    const off = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { disabled: true },
    });
    expect(off.status).toBe(200);
    expect(await clientProbe({ bearer: third.token })).toBe(401);
  });

  it('a token is held to the session epoch even when its row is live', async () => {
    const id = await addClient('eve');
    const phone = await clientPhone('eve');
    // The epoch moves on with no token revoked (no path does this today; the
    // session layer must not depend on that).
    await sql`update auth.users set session_epoch = session_epoch + 1 where id = ${id}`;
    const [row] = await sql<
      Row[]
    >`select revoked_at from mobile_tokens where id = ${phone.deviceId}`;
    expect(row!.revoked_at).toBeNull();
    expect(await clientProbe({ bearer: phone.token })).toBe(401);
    expect(
      (await call('/api/auth/token/refresh', { method: 'POST', bearer: phone.token })).status,
    ).toBe(401);
    // A client token minted without the epoch (never by the sign-in) is no token.
    const jti = randomUUID();
    const bare = tokens.buildMobileToken(id, jti, 3600);
    await sql`insert into mobile_tokens (id, user_id, label, expires_at)
              values (${jti}, ${id}, ${tag}, ${bare.expiresAt.toISOString()})`;
    expect(await clientProbe({ bearer: bare.value })).toBe(401);
  });

  it("the client's sign-out in the browser ends its phone, and the phone's ends its browser", async () => {
    await addClient('di');
    const phone = await clientPhone('di');
    const browser = await clientBrowser('di');
    expect(await clientProbe({ bearer: phone.token })).toBe(400);
    expect(await clientProbe({ cookie: browser })).toBe(400);
    // The browser signs out (a plain sign-out: a client's ends everything).
    expect((await call('/api/auth/logout', { method: 'POST', cookie: browser })).status).toBe(200);
    expect(await clientProbe({ bearer: phone.token })).toBe(401);

    const phone2 = await clientPhone('di');
    const tablet = await clientPhone('di', 'Tablet');
    const browser2 = await clientBrowser('di');
    const out = await call('/api/auth/mobile-logout', { method: 'POST', bearer: phone2.token });
    expect(out.status).toBe(200);
    expect(await clientProbe({ bearer: phone2.token })).toBe(401);
    expect(await clientProbe({ bearer: tablet.token })).toBe(401);
    expect(await clientProbe({ cookie: browser2 })).toBe(401);
    // A dead token signs nobody out: the answer is the same 200, nothing ends.
    const phone3 = await clientPhone('di');
    expect(
      (await call('/api/auth/mobile-logout', { method: 'POST', bearer: phone2.token })).status,
    ).toBe(200);
    expect(await clientProbe({ bearer: phone3.token })).toBe(400);
  });

  it("a member's phone sign-out ends that device only", async () => {
    const phone = await json(await deviceLogin(emailOf('member'), PASSWORD, 'Phone'));
    const tablet = await json(await deviceLogin(emailOf('member'), PASSWORD, 'Tablet'));
    const out = await call('/api/auth/mobile-logout', {
      method: 'POST',
      bearer: phone.token as string,
    });
    expect(out.status).toBe(200);
    expect(await memberProbe({ bearer: phone.token as string })).toBe(401);
    expect(await memberProbe({ bearer: tablet.token as string })).toBe(400);
  });

  // ── Refresh ─────────────────────────────────────────────────────────────

  it('refresh rotates a client token: same epoch, at most 30 days, the old one dead', async () => {
    const id = await addClient('fay');
    const phone = await clientPhone('fay');
    const before = Math.floor(Date.now() / 1000);
    const res = await call('/api/auth/token/refresh', { method: 'POST', bearer: phone.token });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ role: 'client', expiresIn: 30 * DAY });
    expect(body.deviceId).not.toBe(phone.deviceId);
    const claims = tokens.verifyMobileToken(body.token as string)!;
    expect(claims).toMatchObject({ uid: id, ep: 0 });
    expect(claims.exp).toBeLessThanOrEqual(before + 30 * DAY + 60);
    expect(await clientProbe({ bearer: body.token as string })).toBe(400);
    expect(await clientProbe({ bearer: phone.token })).toBe(401);
    // The old token cannot be rotated twice.
    expect(
      (await call('/api/auth/token/refresh', { method: 'POST', bearer: phone.token })).status,
    ).toBe(401);
  });

  it('refresh rotates a member token and names the role', async () => {
    const phone = await json(await deviceLogin(emailOf('member')));
    const res = await call('/api/auth/token/refresh', {
      method: 'POST',
      bearer: phone.token as string,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.role).toBe('member');
    expect(await memberProbe({ bearer: body.token as string })).toBe(400);
    expect(await memberProbe({ bearer: phone.token as string })).toBe(401);
  });

  // ── Push devices of a member and a client ───────────────────────────────

  it('a member and a client enrol, list and remove only their own devices', async () => {
    const clientId = await addClient('gus');
    const mPhone = await json(await deviceLogin(emailOf('member'), PASSWORD, 'Push phone'));
    const cPhone = await clientPhone('gus');
    const mBearer = mPhone.token as string;

    const mine = await enrol('/api/member/push', mBearer, `${tag}-m1`);
    expect(mine.status).toBe(200);
    const theirs = await enrol('/api/client/push', cPhone.token, `${tag}-c1`);
    expect(theirs.status).toBe(200);
    const [mRow] = await pushRows(member);
    expect(mRow).toMatchObject({ token_id: mPhone.deviceId, routing_token: `${tag}-m1` });
    const [cRow] = await pushRows(clientId);
    expect(cRow).toMatchObject({ token_id: cPhone.deviceId });
    const [owner] = await sql<
      Row[]
    >`select owner_id from push_subscriptions where id = ${mRow!.id as string}`;
    expect(owner!.owner_id).toBe(anchor);

    // Each lists only its own, metadata only.
    const mList = await json(await call('/api/member/push/subscriptions', { bearer: mBearer }));
    expect(mList).toEqual({
      devices: [{ id: mRow!.id, platform: 'ios', label: `${tag}-m1`, current: true }],
    });
    const cList = await json(
      await call('/api/client/push/subscriptions', { bearer: cPhone.token }),
    );
    expect((cList.devices as Array<{ id: string }>).map((d) => d.id)).toEqual([cRow!.id]);

    // A role's routes are its own: the other role is refused at the gate.
    expect((await call('/api/client/push/subscriptions', { bearer: mBearer })).status).toBe(403);
    expect((await call('/api/member/push/subscriptions', { bearer: cPhone.token })).status).toBe(
      403,
    );
    // And a login cannot remove another login's device.
    const cross = await call(`/api/client/push/subscriptions/${mRow!.id as string}`, {
      method: 'DELETE',
      bearer: cPhone.token,
    });
    expect(cross.status).toBe(404);
    expect(await pushRows(member)).toHaveLength(1);

    // The enrol step needs the bearer: a browser session is told so.
    const browser = await clientBrowser('gus');
    const noBearer = await call('/api/client/push/subscriptions', {
      method: 'POST',
      cookie: browser,
      body: { routingToken: `${tag}-c2`, publicKey: 'pk', platform: 'ios' },
    });
    expect(noBearer.status).toBe(400);
    expect(await json(noBearer)).toEqual({ error: 'bearer_required' });

    // Its own toggles.
    const prefs = await call('/api/client/push/preferences', {
      method: 'PUT',
      bearer: cPhone.token,
      body: { comments: false, approvals: false },
    });
    expect(await json(prefs)).toEqual({ chatReplies: true, reviewResults: true, comments: false });
    expect(await json(await call('/api/member/push/preferences', { bearer: mBearer }))).toEqual({
      chatReplies: true,
      reviewResults: true,
      comments: true,
    });

    // Remove its own.
    const gone = await call(`/api/member/push/subscriptions/${mRow!.id as string}`, {
      method: 'DELETE',
      bearer: mBearer,
    });
    expect(gone.status).toBe(200);
    expect(await pushRows(member)).toHaveLength(0);
  });

  it('the devices follow a refreshed token, and a sign-out removes them', async () => {
    const clientId = await addClient('hal');
    const phone = await clientPhone('hal');
    expect((await enrol('/api/client/push', phone.token, `${tag}-h1`)).status).toBe(200);
    const fresh = await json(
      await call('/api/auth/token/refresh', { method: 'POST', bearer: phone.token }),
    );
    const [row] = await pushRows(clientId);
    expect(row!.token_id).toBe(fresh.deviceId);
    const { listLoginSubscriptions } = await import('../push/store');
    expect(await listLoginSubscriptions(anchor, clientId)).toHaveLength(1);
    // The client signs out on the phone: the device row goes with it.
    await call('/api/auth/mobile-logout', { method: 'POST', bearer: fresh.token as string });
    expect(await pushRows(clientId)).toHaveLength(0);

    // A member's device goes with ITS token; the member's other device stays.
    const a = await json(await deviceLogin(emailOf('member'), PASSWORD, 'A'));
    const b = await json(await deviceLogin(emailOf('member'), PASSWORD, 'B'));
    await enrol('/api/member/push', a.token as string, `${tag}-ma`);
    await enrol('/api/member/push', b.token as string, `${tag}-mb`);
    await call('/api/auth/mobile-logout', { method: 'POST', bearer: a.token as string });
    expect((await pushRows(member)).map((r) => r.routing_token)).toEqual([`${tag}-mb`]);
    // The admin ends the member's sessions: every token-bound device goes.
    const end = await call(`/api/users/${member}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { signOut: true },
    });
    expect(end.status).toBe(200);
    expect(await pushRows(member)).toHaveLength(0);
  });

  // ── Unread ──────────────────────────────────────────────────────────────

  it('the unread count and the read cursor of the own chat thread', async () => {
    const clientId = await addClient('ivy');
    const phone = await clientPhone('ivy');
    const bearer = phone.token;
    const reply = (text: string) =>
      content.appendTeamMessage({
        ownerId: anchor,
        contactId: null,
        loginId: clientId,
        direction: 'outbound',
        text,
      });
    await reply('before the app was installed');
    const first = await json(await call('/api/client/chat/unread', { bearer }));
    expect(first.unread).toBe(0);
    await reply('one');
    await reply('two');
    expect((await json(await call('/api/client/chat/unread', { bearer }))).unread).toBe(2);
    const bad = await call('/api/client/chat/read', {
      method: 'POST',
      bearer,
      body: { at: 'yesterday' },
    });
    expect(bad.status).toBe(400);
    const read = await call('/api/client/chat/read', { method: 'POST', bearer, body: {} });
    expect(read.status).toBe(200);
    expect((await json(read)).unread).toBe(0);
    // Another login's thread never counts, and a member has its own route.
    const m1 = await json(await deviceLogin(emailOf('member')));
    const mine = await json(await call('/api/member/chat/unread', { bearer: m1.token as string }));
    expect(mine.unread).toBe(0);
    expect((await call('/api/member/chat/unread', { bearer })).status).toBe(403);
    expect((await call('/api/client/chat/unread', { bearer: m1.token as string })).status).toBe(
      403,
    );
  });
});
