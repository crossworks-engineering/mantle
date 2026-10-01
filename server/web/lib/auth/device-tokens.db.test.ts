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
  let logins: typeof import('../client-logins');
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
  /** An open emailed code for the client, written as the worker stores it.
   *  Not through createClientEmailCode: its brain-wide daily cap is shared
   *  with every test file on this database (client-codes.db.test.ts fills
   *  it on purpose), and what this file tests is the redeem. A device-mode
   *  code is stored under the id DERIVED from the app's (deviceRequestId),
   *  a browser's under the cookie's id itself. */
  const mailedCode = async (name: string, mode: 'device' | 'browser' = 'device') => {
    const requestId = randomUUID();
    const stored = mode === 'device' ? logins.deviceRequestId(requestId) : requestId;
    const code = content.generateClientCode();
    const [login] = await sql<Row[]>`select id from auth.users where email = ${emailOf(name)}`;
    await sql`insert into client_signin_codes
                (owner_id, login_id, kind, code_hash, request_id, request_ip, expires_at)
              values (${anchor}, ${login!.id as string}, 'email',
                      ${content.hashClientCode(stored, code)}, ${stored},
                      ${`198.51.100.${(ip += 1) % 250}`}, now() + interval '10 minutes')`;
    return { requestId, code };
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
    const { requestId, code } = await mailedCode(name, 'browser');
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
  const refresh = (bearer: string) => call('/api/auth/token/refresh', { method: 'POST', bearer });
  /** Bring a device token close to its end, so a refresh rotates it (one
   *  with more than 23 days left is answered with itself). */
  const nearExpiry = (deviceId: string) =>
    sql`update mobile_tokens set expires_at = now() + interval '5 days' where id = ${deviceId}`;
  const liveTokens = async (login: string) =>
    Number(
      (
        await sql<Row[]>`select count(*)::int as n from mobile_tokens
                         where user_id = ${login} and revoked_at is null and expires_at > now()`
      )[0]!.n,
    );
  /** A login made for one test, with a password. */
  const addLogin = async (name: string, role: 'admin' | 'member'): Promise<string> => {
    const id = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role, display_name)
              values (${id}, ${emailOf(name)}, ${bcrypt.hashSync(PASSWORD, 4)}, ${role}, ${name})`;
    made.push(id);
    return id;
  };
  const audited = async (action: string, actorId: string) => {
    for (let i = 0; i < 100; i += 1) {
      const rows = await sql<Row[]>`
        select detail from audit_log where action = ${action} and actor_id = ${actorId}`;
      if (rows.length) return rows;
      await new Promise((r) => setTimeout(r, 20));
    }
    return [];
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'device-tokens-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./tokens');
    content = await import('@mantle/content');
    logins = await import('../client-logins');
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
    // The device's id in a browser cookie opens nothing either.
    const asCookie = await verify({ email: emailOf('ben'), code }, `mantle_code_req=${requestId}`);
    expect(asCookie.status).toBe(401);
    const ok = await verify({ email: emailOf('ben'), code, requestId });
    expect(ok.status).toBe(200);
    // One use.
    expect((await verify({ email: emailOf('ben'), code, requestId })).status).toBe(401);
  });

  it("a browser's code cannot be turned into a device token, and a page cannot use device mode", async () => {
    const id = await addClient('web');
    const verify = (body: Json, headers: Record<string, string> = {}) => {
      ip += 1;
      return app.request('/api/auth/client-code/verify', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `203.0.113.${ip % 250}`,
          ...headers,
        },
        body: JSON.stringify(body),
      });
    };
    // A code asked for by a browser (its id is the cookie's), sent in the
    // BODY: the device lookup uses a derived id, so it finds no code.
    const web = await mailedCode('web', 'browser');
    const crossed = await verify({
      email: emailOf('web'),
      code: web.code,
      requestId: web.requestId,
    });
    expect(crossed.status).toBe(401);
    // Device mode from a page (an Origin or a Sec-Fetch header): refused.
    const dev = await mailedCode('web');
    const pages: Array<Record<string, string>> = [
      { origin: 'http://localhost' },
      { 'sec-fetch-site': 'same-origin' },
    ];
    for (const headers of pages) {
      const res = await verify(
        { email: emailOf('web'), code: dev.code, requestId: dev.requestId },
        headers,
      );
      expect(res.status).toBe(403);
      expect((await json(res)).reason).toBe('device-only');
    }
    expect(await liveTokens(id)).toBe(0);
    // The same code from the app still works (the refusals burned nothing).
    const ok = await verify({ email: emailOf('web'), code: dev.code, requestId: dev.requestId });
    expect(ok.status).toBe(200);
    // The token row was written with the redeem: one live device, signed in now.
    const [tok] = await sql<Row[]>`
      select signed_in_at, label from mobile_tokens where user_id = ${id} and revoked_at is null`;
    expect(tok!.signed_in_at).not.toBeNull();
    expect(tok!.label).toBe('Mobile device');
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

  it('refresh answers a token with plenty of life left with itself: nothing rotates', async () => {
    const id = await addClient('zed');
    const phone = await clientPhone('zed');
    for (let i = 0; i < 3; i += 1) {
      const res = await refresh(phone.token);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await json(res);
      expect(body).toMatchObject({ token: phone.token, deviceId: phone.deviceId, role: 'client' });
      expect(body.expiresIn as number).toBeGreaterThan(29 * DAY);
    }
    const rows = await sql<Row[]>`select id from mobile_tokens where user_id = ${id}`;
    expect(rows).toHaveLength(1);
    expect(await clientProbe({ bearer: phone.token })).toBe(400);
  });

  it('refresh rotates a client token: same epoch, at most 30 days, the old one dead', async () => {
    const id = await addClient('fay');
    const phone = await clientPhone('fay');
    await nearExpiry(phone.deviceId);
    const before = Math.floor(Date.now() / 1000);
    const res = await refresh(phone.token);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ role: 'client', expiresIn: 30 * DAY });
    expect(body.deviceId).not.toBe(phone.deviceId);
    const claims = tokens.verifyMobileToken(body.token as string)!;
    expect(claims).toMatchObject({ uid: id, ep: 0 });
    expect(claims.exp).toBeLessThanOrEqual(before + 30 * DAY + 60);
    expect(await clientProbe({ bearer: body.token as string })).toBe(400);
    expect(await clientProbe({ bearer: phone.token })).toBe(401);
    // The sign-in time travels with the rotation; the old row says where it went.
    const [oldRow] = await sql<Row[]>`
      select signed_in_at, rotated_to from mobile_tokens where id = ${phone.deviceId}`;
    const [newRow] = await sql<Row[]>`
      select signed_in_at from mobile_tokens where id = ${body.deviceId as string}`;
    expect(oldRow!.rotated_to).toBe(body.deviceId);
    expect(new Date(newRow!.signed_in_at as string).getTime()).toBe(
      new Date(oldRow!.signed_in_at as string).getTime(),
    );
    // The old token, presented again at once (a lost answer retried): a
    // plain 401, and the new token still works.
    expect((await refresh(phone.token)).status).toBe(401);
    expect(await clientProbe({ bearer: body.token as string })).toBe(400);
  });

  it("a client's device is refreshed for at most 90 days from the code that signed it in", async () => {
    const id = await addClient('cap');
    const phone = await clientPhone('cap');
    // 85 days in: it rotates, but the new token ends at the cap, not 30 days on.
    await nearExpiry(phone.deviceId);
    await sql`update mobile_tokens set signed_in_at = now() - interval '85 days'
              where id = ${phone.deviceId}`;
    const late = await json(await refresh(phone.token));
    expect(late.expiresIn as number).toBeLessThanOrEqual(5 * DAY);
    expect(late.expiresIn as number).toBeGreaterThan(4 * DAY);
    const claims = tokens.verifyMobileToken(late.token as string)!;
    expect(claims.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 5 * DAY + 60);
    expect(await clientProbe({ bearer: late.token as string })).toBe(400);
    // Past 90 days: no refresh, and the app is told to sign in again.
    await sql`update mobile_tokens set signed_in_at = now() - interval '91 days'
              where id = ${late.deviceId as string}`;
    const over = await refresh(late.token as string);
    expect(over.status).toBe(401);
    expect(await json(over)).toEqual({ error: 'unauthorized', reason: 'sign-in-expired' });
    expect((await audited('auth.token_refresh_failed', id)).length).toBeGreaterThan(0);
    // A member has no such cap.
    const m1 = await json(await deviceLogin(emailOf('member')));
    await nearExpiry(m1.deviceId as string);
    await sql`update mobile_tokens set signed_in_at = now() - interval '400 days'
              where id = ${m1.deviceId as string}`;
    expect((await refresh(m1.token as string)).status).toBe(200);
  });

  it('a rotated token presented again is reuse: it ends the login sessions, and is logged', async () => {
    const id = await addClient('thf');
    const phone = await clientPhone('thf');
    const browser = await clientBrowser('thf');
    await nearExpiry(phone.deviceId);
    // A thief holding a copy refreshes first.
    const stolen = await json(await refresh(phone.token));
    expect(await clientProbe({ bearer: stolen.token as string })).toBe(400);
    // Later the real phone presents the token it still holds.
    await sql`update mobile_tokens set revoked_at = now() - interval '10 minutes'
              where id = ${phone.deviceId}`;
    const again = await refresh(phone.token);
    expect(again.status).toBe(401);
    // Everything of the login ended: the thief's token and the browser too.
    expect(await clientProbe({ bearer: stolen.token as string })).toBe(401);
    expect(await clientProbe({ cookie: browser })).toBe(401);
    expect(await liveTokens(id)).toBe(0);
    const rows = await audited('auth.token_reuse', id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ reason: 'rotated-token-presented-again' });

    // The same for a member (every role).
    const mem = await addLogin('reuse-member', 'member');
    const m1 = await json(await deviceLogin(emailOf('reuse-member')));
    await nearExpiry(m1.deviceId as string);
    const m2 = await json(await refresh(m1.token as string));
    await sql`update mobile_tokens set revoked_at = now() - interval '10 minutes'
              where id = ${m1.deviceId as string}`;
    expect((await refresh(m1.token as string)).status).toBe(401);
    expect(await memberProbe({ bearer: m2.token as string })).toBe(401);
    expect((await audited('auth.token_reuse', mem)).length).toBe(1);
    // A token revoked by a sign-out (not by rotation) is no reuse: nothing ends.
    const m3 = await json(await deviceLogin(emailOf('reuse-member')));
    const m4 = await json(await deviceLogin(emailOf('reuse-member')));
    await call('/api/auth/mobile-logout', { method: 'POST', bearer: m3.token as string });
    await sql`update mobile_tokens set revoked_at = now() - interval '10 minutes'
              where id = ${m3.deviceId as string}`;
    expect((await refresh(m3.token as string)).status).toBe(401);
    expect(await memberProbe({ bearer: m4.token as string })).toBe(400);
  });

  it('a refresh racing End sessions never leaves a live token', async () => {
    const id = await addLogin('racer', 'member');
    for (let round = 0; round < 12; round += 1) {
      const t = await json(await deviceLogin(emailOf('racer')));
      await nearExpiry(t.deviceId as string);
      const [refreshed] = await Promise.all([
        refresh(t.token as string),
        call(`/api/users/${id}`, { method: 'PATCH', cookie: asAdmin(), body: { signOut: true } }),
      ]);
      expect([200, 401]).toContain(refreshed.status);
      // Whichever went first: no token of the login survives End sessions.
      expect(await liveTokens(id), `round ${round}`).toBe(0);
      if (refreshed.status === 200) {
        const body = await json(refreshed);
        expect(await memberProbe({ bearer: body.token as string })).toBe(401);
      }
    }
  });

  it('refresh rotates a member token and names the role', async () => {
    const phone = await json(await deviceLogin(emailOf('member')));
    await nearExpiry(phone.deviceId as string);
    const res = await refresh(phone.token as string);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.role).toBe('member');
    expect(await memberProbe({ bearer: body.token as string })).toBe(400);
    expect(await memberProbe({ bearer: phone.token as string })).toBe(401);
  });

  // ── Dead tokens, limits, labels ─────────────────────────────────────────

  it('a token that is dead signs nobody out, and tells nobody who it is', async () => {
    const id = await addClient('old');
    const stale = await clientPhone('old');
    // The epoch moved on with the row still live (a verify racing End sessions).
    await sql`update auth.users set session_epoch = session_epoch + 1 where id = ${id}`;
    const fresh = await clientPhone('old');
    expect(await clientProbe({ bearer: fresh.token })).toBe(400);
    expect(
      (await call('/api/auth/mobile-logout', { method: 'POST', bearer: stale.token })).status,
    ).toBe(200);
    // Nothing ended: the stale token's row is untouched, the newer session lives.
    const [row] = await sql<
      Row[]
    >`select revoked_at from mobile_tokens where id = ${stale.deviceId}`;
    expect(row!.revoked_at).toBeNull();
    expect(await clientProbe({ bearer: fresh.token })).toBe(400);

    // An expired token (not revoked): the same, and whoami answers 401.
    const other = await clientPhone('old');
    await sql`update mobile_tokens set expires_at = now() - interval '1 minute'
              where id = ${other.deviceId}`;
    expect((await call('/api/auth/whoami', { bearer: other.token })).status).toBe(401);
    expect(
      (await call('/api/auth/mobile-logout', { method: 'POST', bearer: other.token })).status,
    ).toBe(200);
    expect(await clientProbe({ bearer: fresh.token })).toBe(400);
  });

  it('device-login refuses a disabled login like a wrong password, and clamps the device name', async () => {
    const id = await addLogin('gone-member', 'member');
    const named = await json(await deviceLogin(emailOf('gone-member'), PASSWORD, 'x'.repeat(200)));
    const [tok] = await sql<
      Row[]
    >`select label from mobile_tokens where id = ${named.deviceId as string}`;
    expect(tok!.label).toBe('x'.repeat(80));
    // An empty or a non-text name is no reason to refuse a good password.
    for (const deviceName of ['   ', 42]) {
      const res = await call('/api/auth/device-login', {
        method: 'POST',
        body: { email: emailOf('gone-member'), password: PASSWORD, deviceName },
      });
      expect(res.status, String(deviceName)).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    await sql`update auth.users set disabled_at = now() where id = ${id}`;
    const off = await deviceLogin(emailOf('gone-member'));
    expect(off.status).toBe(401);
    expect(await json(off)).toEqual({ error: 'Invalid email or password.' });
  });

  it('the token logins are limited per address: ten a minute, one bucket', async () => {
    const from = (path: string) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.77' },
        body: JSON.stringify({ email: emailOf('member'), password: 'wrong password' }),
      });
    for (let i = 0; i < 10; i += 1) {
      const path = i % 2 ? '/api/auth/device-login' : '/api/auth/mobile-login';
      expect((await from(path)).status).toBe(401);
    }
    const held = await from('/api/auth/device-login');
    expect(held.status).toBe(429);
    expect(held.headers.get('retry-after')).toBeTruthy();
    expect((await from('/api/auth/token')).status).toBe(429);
    // An IPv6 caller counts by its /64, not by each address in it.
    const v6 = (host: string) =>
      app.request('/api/auth/device-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `2001:db8:5:5::${host}` },
        body: JSON.stringify({ email: emailOf('member'), password: 'wrong password' }),
      });
    for (let i = 1; i <= 10; i += 1) expect((await v6(i.toString(16))).status).toBe(401);
    expect((await v6('ff')).status).toBe(429);
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
    await nearExpiry(phone.deviceId);
    const fresh = await json(await refresh(phone.token));
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

  it("an admin's phone enrols with its bearer; a browser session cannot enrol a device", async () => {
    const id = await addLogin('push-admin', 'admin');
    const cookie = `mantle_session=${tokens.buildSessionCookie(id).value}`;
    const body = { routingToken: `${tag}-adm1`, publicKey: 'pk', platform: 'ios' };
    const noBearer = await call('/api/push/subscriptions', { method: 'POST', cookie, body });
    expect(noBearer.status).toBe(400);
    expect(await json(noBearer)).toEqual({ error: 'bearer_required' });
    const phone = await json(await deviceLogin(emailOf('push-admin')));
    const ok = await call('/api/push/subscriptions', {
      method: 'POST',
      bearer: phone.token as string,
      body,
    });
    expect(ok.status).toBe(200);
    const [row] = await pushRows(id);
    expect(row).toMatchObject({ token_id: phone.deviceId, routing_token: `${tag}-adm1` });
    // The admin list shows admin devices, never a member's or a client's.
    const list = await json(await call('/api/push/subscriptions', { cookie }));
    const ids = (list.devices as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain(row!.id);
    const others = await sql<Row[]>`
      select ps.id from push_subscriptions ps join auth.users u on u.id = ps.login_id
       where u.role in ('member', 'client')`;
    for (const o of others) expect(ids).not.toContain(o.id);
  });

  it('devices from before tokens were recorded go with every revoke of their login', async () => {
    const id = await addLogin('legacy-admin', 'admin');
    const legacy = (label: string) =>
      sql`insert into push_subscriptions (owner_id, login_id, routing_token, public_key, platform)
          values (${anchor}, ${id}, ${`${tag}-${label}`}, 'pk', 'ios')`;
    const store = await import('../push/store');
    const listed = async () => (await store.listAdminSubscriptions(anchor, { loginId: id })).length;

    // 1. An admin revokes one of the login's devices (a lost phone).
    await legacy('lg1');
    const phone = await json(await deviceLogin(emailOf('legacy-admin')));
    expect(await listed()).toBe(1);
    const revoke = await call(`/api/users/${id}/devices/${phone.deviceId as string}`, {
      method: 'DELETE',
      cookie: asAdmin(),
    });
    expect(revoke.status).toBe(200);
    expect(await pushRows(id)).toHaveLength(0);
    expect(await listed()).toBe(0);

    // 2. End sessions.
    await legacy('lg2');
    const end = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { signOut: true },
    });
    expect(end.status).toBe(200);
    expect(await pushRows(id)).toHaveLength(0);

    // 3. The login changes its own password from the web.
    await legacy('lg3');
    const web = await call('/api/auth/login', {
      method: 'POST',
      body: { email: emailOf('legacy-admin'), password: PASSWORD },
    });
    const cookie = /mantle_session=([^;]*)/.exec(web.headers.get('set-cookie') ?? '')![1]!;
    const changed = await call('/api/auth/change-password', {
      method: 'POST',
      cookie: `mantle_session=${cookie}`,
      body: { oldPassword: PASSWORD, newPassword: 'another long password' },
    });
    expect(changed.status).toBe(200);
    expect(await pushRows(id)).toHaveLength(0);

    // 4. The phone signs out.
    await legacy('lg4');
    const again = await json(await deviceLogin(emailOf('legacy-admin'), 'another long password'));
    await call('/api/auth/mobile-logout', { method: 'POST', bearer: again.token as string });
    expect(await pushRows(id)).toHaveLength(0);
  });

  it('a password change from the phone keeps that phone and its device, and ends the others', async () => {
    const id = await addLogin('pw-member', 'member');
    const a = await json(await deviceLogin(emailOf('pw-member'), PASSWORD, 'A'));
    const b = await json(await deviceLogin(emailOf('pw-member'), PASSWORD, 'B'));
    await enrol('/api/member/push', a.token as string, `${tag}-pwa`);
    await enrol('/api/member/push', b.token as string, `${tag}-pwb`);
    const res = await call('/api/auth/change-password', {
      method: 'POST',
      bearer: a.token as string,
      body: { oldPassword: PASSWORD, newPassword: 'a second long password' },
    });
    expect(res.status).toBe(200);
    expect(await memberProbe({ bearer: a.token as string })).toBe(400);
    expect(await memberProbe({ bearer: b.token as string })).toBe(401);
    expect((await pushRows(id)).map((r) => r.routing_token)).toEqual([`${tag}-pwa`]);
  });

  it('a role change ends the tokens and removes the devices', async () => {
    const id = await addLogin('promoted', 'member');
    const phone = await json(await deviceLogin(emailOf('promoted')));
    await enrol('/api/member/push', phone.token as string, `${tag}-prm`);
    const { listLoginSubscriptions } = await import('../push/store');
    expect(await listLoginSubscriptions(anchor, id)).toHaveLength(1);
    const res = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { role: 'admin' },
    });
    expect(res.status).toBe(200);
    expect(await memberProbe({ bearer: phone.token as string })).toBe(401);
    expect(await pushRows(id)).toHaveLength(0);
    // Now an admin: never a target of a member's push, whatever it enrols.
    const adminPhone = await json(await deviceLogin(emailOf('promoted')));
    expect(adminPhone.role).toBe('admin');
    await call('/api/push/subscriptions', {
      method: 'POST',
      bearer: adminPhone.token as string,
      body: { routingToken: `${tag}-prm2`, publicKey: 'pk', platform: 'ios' },
    });
    expect(await listLoginSubscriptions(anchor, id)).toHaveLength(0);
  });

  it('the nightly reaper deletes tokens dead for 30 days, and nothing else', async () => {
    const id = await addLogin('reaped', 'member');
    const live = await json(await deviceLogin(emailOf('reaped'), PASSWORD, 'live'));
    const mk = async (label: string, set: ReturnType<typeof sql>) => {
      const t = await json(await deviceLogin(emailOf('reaped'), PASSWORD, label));
      await sql`update mobile_tokens set ${set} where id = ${t.deviceId as string}`;
      return t.deviceId as string;
    };
    const oldRevoked = await mk('old-revoked', sql`revoked_at = now() - interval '31 days'`);
    const newRevoked = await mk('new-revoked', sql`revoked_at = now() - interval '2 days'`);
    const oldExpired = await mk('old-expired', sql`expires_at = now() - interval '31 days'`);
    const newExpired = await mk('new-expired', sql`expires_at = now() - interval '2 days'`);
    await sql`insert into push_subscriptions
                (owner_id, login_id, token_id, routing_token, public_key, platform)
              values (${anchor}, ${id}, ${oldRevoked}, ${`${tag}-reap`}, 'pk', 'ios')`;
    const { reapDeviceTokens } = await import('./device-token-reap');
    const dry = await reapDeviceTokens({ dryRun: true });
    expect(dry.deleted).toBeGreaterThanOrEqual(2);
    expect(await sql`select 1 from mobile_tokens where id = ${oldRevoked}`).toHaveLength(1);
    await reapDeviceTokens();
    const left = (await sql<Row[]>`select id from mobile_tokens where user_id = ${id}`).map(
      (r) => r.id,
    );
    expect(left.sort()).toEqual([live.deviceId, newRevoked, newExpired].sort());
    expect(left).not.toContain(oldExpired);
    // The device the reaped token enrolled went with it.
    expect(await pushRows(id)).toHaveLength(0);
    expect(await memberProbe({ bearer: live.token as string })).toBe(400);
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
