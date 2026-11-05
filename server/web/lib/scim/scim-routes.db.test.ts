/**
 * SCIM through the real app (createApp: the gate, the route policies, the
 * rate limits) on a real migrated Postgres, as an identity provider calls
 * it (docs/scim.md):
 *
 *  - off: every route answers 404, nothing is written;
 *  - create: a member login with no password and no workspace, never an
 *    admin; it cannot sign in with a password; a second create of the same
 *    userName (or the original account's) is a 409;
 *  - the userName filter finds a login made by hand (the one match on a
 *    name), never the original account;
 *  - PATCH active "False" (Entra's shape) is the users area's disable: the
 *    login's session, device bearer, API key and MCP grant all end, and the
 *    audit row names SCIM; the email is kept when the provider renames it;
 *  - DELETE is a disable: the login and what it made stay;
 *  - an Admin user is disabled too; the original account is never seen;
 *  - the leaver report lists what is left, with every credential ended;
 *  - the SCIM rate limit answers 429 past 600 a minute from one address.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/scim/scim-routes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asSuperuser,
  createMigratedScratchDatabase,
  ensureAdminUsers,
  ensureTestAnchor,
  runWorkspacesSwitch,
  superuserClient,
} from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;

const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

describe.skipIf(!URL)('SCIM through the app', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let anchor = '';
  let token = '';
  let hash = '';
  const tag = `scim-${randomUUID().slice(0, 8)}`;
  const pat = randomUUID(); // a member made by hand: found by userName, disabled
  const dan = randomUUID(); // a member deleted by the provider
  const ada = randomUUID(); // an Admin user, disabled by the provider
  const PASSWORD = 'first password 1';
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let ip = 0;

  const call = (
    path: string,
    init: {
      method?: string;
      token?: string | null;
      body?: unknown;
      cookie?: string;
      ip?: string;
    } = {},
  ) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/scim+json',
      'x-forwarded-for': init.ip ?? `198.51.100.${ip % 250}`,
      'x-forwarded-proto': 'https',
    };
    const t = init.token === undefined ? token : init.token;
    if (t !== null) headers.authorization = `Bearer ${t}`;
    if (init.cookie) headers.cookie = init.cookie;
    return Promise.resolve(
      app.request(path, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  };
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
  const disable = (value: unknown = 'False') => ({
    schemas: [PATCH_OP],
    Operations: [{ op: 'Replace', path: 'active', value }],
  });
  const login = async (id: string) =>
    (
      await sql<Row[]>`select id, role, password_hash, is_owner, disabled_at, session_epoch,
                              display_name, email
                         from auth.users where id = ${id}`
    )[0];
  const auditRows = async (targetId: string, action: string) => {
    for (let i = 0; i < 40; i++) {
      const rows = await sql<Row[]>`select actor_email, actor_id, action, detail from audit_log
                                     where action = ${action} and detail->>'targetId' = ${targetId}`;
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
    return [];
  };
  const passwordSignIn = (id: string) =>
    Promise.resolve(
      app.request('/api/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `203.0.113.${(ip += 1) % 250}`,
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ email: emailOf(id), password: PASSWORD }),
      }),
    );
  const sessionOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith('mantle_session='))
      ?.split(';')[0];
  /** Whether the session still passes the gate (a member route). */
  const memberProbe = (cookie: string) =>
    Promise.resolve(
      app.request('/api/member/push/preferences', {
        headers: { cookie, 'x-forwarded-proto': 'https' },
      }),
    ).then((r) => (r.status === 401 || r.status === 403 ? r.status : 'past'));

  /** A device bearer, an API key and an MCP grant of `id`, all live. */
  const giveCredentials = async (id: string) => {
    const client = randomUUID();
    await sql`insert into mobile_tokens (id, user_id, label, expires_at)
              values (${randomUUID()}, ${id}, ${tag}, now() + interval '1 day')`;
    await sql`insert into access_keys (name, login_id, key_prefix, key_hash, access)
              values (${tag}, ${id}, ${`mtlk_${id.slice(0, 4)}`}, ${`h-${id}`}, 'read')`;
    await sql`insert into oauth_clients (id, client_name, redirect_uris)
              values (${client}, ${tag}, '{https://client.example/cb}')`;
    await sql`insert into oauth_access_tokens (token_hash, owner_id, actor_id, client_id, expires_at)
              values (${`t-${id}`}, ${anchor}, ${id}, ${client}, now() + interval '1 hour')`;
  };
  const liveCredentials = async (id: string) =>
    (
      await sql<Row[]>`select
        (select count(*)::int from mobile_tokens where user_id = ${id} and revoked_at is null) as devices,
        (select count(*)::int from access_keys where login_id = ${id} and revoked_at is null) as keys,
        (select count(*)::int from oauth_access_tokens where actor_id = ${id} and revoked_at is null) as grants`
    )[0];

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'scim-routes-db-test-secret-at-least-32-chars';
    process.env.MANTLE_PUBLIC_URL = 'https://brain.example.invalid';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_OIDC_MODE;
    delete process.env.MANTLE_SCIM_TOKEN_HASH;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    anchor = await ensureTestAnchor(sql);
    const pw = bcrypt.hashSync(PASSWORD, 4);
    await asSuperuser()`insert into auth.users (id, email, password_hash, role) values
      (${pat}, ${emailOf(pat)}, ${pw}, 'member'),
      (${dan}, ${emailOf(dan)}, ${pw}, 'member'),
      (${ada}, ${emailOf(ada)}, ${pw}, 'admin')`;
    await runWorkspacesSwitch(scratch.url);
    const su = superuserClient(scratch.url);
    try {
      await ensureAdminUsers(su, [ada]);
    } finally {
      await su.end();
    }
    const { newScimToken } = await import('./settings');
    ({ token, hash } = newScimToken());
    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    delete process.env.MANTLE_SCIM_TOKEN_HASH;
    delete process.env.MANTLE_PUBLIC_URL;
    await m?.closeDb();
    await scratch?.drop();
  });

  it('off: every route answers 404 and nothing is written', async () => {
    delete process.env.MANTLE_SCIM_TOKEN_HASH;
    for (const [path, method, body] of [
      ['/scim/v2/Users', 'GET', undefined],
      ['/scim/v2/Users', 'POST', { userName: `${tag}-off@example.com` }],
      [`/scim/v2/Users/${pat}`, 'PATCH', disable()],
      [`/scim/v2/Users/${pat}`, 'DELETE', undefined],
      ['/scim/v2/ServiceProviderConfig', 'GET', undefined],
    ] as const) {
      const res = await call(path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
    expect((await login(pat))!.disabled_at).toBeNull();
    const [n] = await sql<Row[]>`select
      (select count(*)::int from scim_users) as scim,
      (select count(*)::int from auth.users where email = ${`${tag}-off@example.com`}) as made`;
    expect(n).toEqual({ scim: 0, made: 0 });
  });

  it('on: a wrong token is a 401', async () => {
    process.env.MANTLE_SCIM_TOKEN_HASH = hash;
    expect((await call('/scim/v2/Users', { token: `${token}x` })).status).toBe(401);
    expect((await call('/scim/v2/Users', { token: null })).status).toBe(401);
  });

  let made = '';
  it('create: a member login with no password and no workspace', async () => {
    process.env.MANTLE_SCIM_TOKEN_HASH = hash;
    const email = `${tag}-new@example.com`;
    const res = await call('/scim/v2/Users', {
      method: 'POST',
      body: {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        externalId: `${tag}-ext-new`,
        userName: email.toUpperCase(),
        active: true,
        displayName: 'New Person',
        name: { givenName: 'New', familyName: 'Person' },
        // Asking for an admin changes nothing: SCIM never makes one.
        roles: [{ value: 'admin' }],
      },
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    made = body.id as string;
    expect(body).toMatchObject({
      userName: email,
      externalId: `${tag}-ext-new`,
      displayName: 'New Person',
      active: true,
    });
    expect(res.headers.get('location')).toBe(`https://brain.example.invalid/scim/v2/Users/${made}`);
    expect(await login(made)).toMatchObject({
      role: 'member',
      password_hash: '',
      is_owner: false,
      disabled_at: null,
      email,
    });
    const [ws] = await sql<
      Row[]
    >`select count(*)::int as n from workspace_users where login_id = ${made}`;
    expect(ws!.n).toBe(0);
    const [link] = await sql<Row[]>`select external_id from scim_users where login_id = ${made}`;
    expect(link).toEqual({ external_id: `${tag}-ext-new` });
    const [audit] = await auditRows(made, 'user.create');
    expect(audit).toMatchObject({ actor_email: 'scim', actor_id: null });
    expect((audit!.detail as Row).via).toBe('scim');
    // No password: it cannot sign in with one.
    const signIn = await Promise.resolve(
      app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({ email, password: '' }),
      }),
    );
    expect(signIn.status).not.toBe(200);
  });

  it('create: the same userName, the original account and an externalId in use are 409s', async () => {
    process.env.MANTLE_SCIM_TOKEN_HASH = hash;
    const [owner] = await sql<Row[]>`select email from auth.users where id = ${anchor}`;
    for (const body of [
      { userName: `${tag}-new@example.com` },
      { userName: owner!.email },
      { userName: `${tag}-other@example.com`, externalId: `${tag}-ext-new` },
    ]) {
      const res = await call('/scim/v2/Users', { method: 'POST', body });
      expect(res.status).toBe(409);
      expect((await json(res)).scimType).toBe('uniqueness');
    }
  });

  it('the userName filter finds a login made by hand, never the original account', async () => {
    process.env.MANTLE_SCIM_TOKEN_HASH = hash;
    const q = (f: string) => call(`/scim/v2/Users?filter=${encodeURIComponent(f)}`);
    const hit = await json(await q(`userName eq "${emailOf(pat).toUpperCase()}"`));
    expect(hit.totalResults).toBe(1);
    expect((hit.Resources as Row[])[0]).toMatchObject({ id: pat, active: true });
    const [owner] = await sql<Row[]>`select email from auth.users where id = ${anchor}`;
    expect((await json(await q(`userName eq "${owner!.email as string}"`))).totalResults).toBe(0);
    expect((await call(`/scim/v2/Users/${anchor}`)).status).toBe(404);
    expect(
      (await call(`/scim/v2/Users/${anchor}`, { method: 'PATCH', body: disable() })).status,
    ).toBe(404);
    expect((await login(anchor))!.disabled_at).toBeNull();
    // The list never holds the original account.
    const all = await json(await call('/scim/v2/Users?count=200'));
    expect((all.Resources as Row[]).map((r) => r.id)).not.toContain(anchor);
    // A read links nothing.
    const [n] = await sql<Row[]>`select count(*)::int as n from scim_users where login_id = ${pat}`;
    expect(n!.n).toBe(0);
  });

  it('PATCH active "False" ends every session, key and grant, and names SCIM', async () => {
    process.env.MANTLE_SCIM_TOKEN_HASH = hash;
    const signedIn = await passwordSignIn(pat);
    expect(signedIn.status).toBe(200);
    const cookie = sessionOf(signedIn)!;
    expect(await memberProbe(cookie)).toBe('past');
    await giveCredentials(pat);
    expect(await liveCredentials(pat)).toEqual({ devices: 1, keys: 1, grants: 1 });
    const before = (await login(pat))!.session_epoch as number;

    const res = await call(`/scim/v2/Users/${pat}`, {
      method: 'PATCH',
      body: {
        schemas: [PATCH_OP],
        Operations: [
          // A rename in the provider rides along: the email is kept.
          { op: 'Replace', path: 'userName', value: `${tag}-renamed@example.com` },
          { op: 'Add', path: 'externalId', value: `${tag}-ext-pat` },
          { op: 'Replace', path: 'active', value: 'False' },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      id: pat,
      active: false,
      userName: emailOf(pat),
      externalId: `${tag}-ext-pat`,
    });
    const after = (await login(pat))!;
    expect(after.disabled_at).not.toBeNull();
    expect(after.email).toBe(emailOf(pat));
    expect(after.session_epoch as number).toBeGreaterThan(before);
    expect(await liveCredentials(pat)).toEqual({ devices: 0, keys: 0, grants: 0 });
    expect([401, 403]).toContain(await memberProbe(cookie));
    // The provider's mark: SCIM manages the login now.
    const [link] = await sql<Row[]>`select external_id from scim_users where login_id = ${pat}`;
    expect(link).toEqual({ external_id: `${tag}-ext-pat` });
    const [audit] = await auditRows(pat, 'user.update');
    expect(audit).toMatchObject({ actor_email: 'scim' });
    expect(audit!.detail).toMatchObject({
      via: 'scim',
      changes: { disabled: true, externalId: `${tag}-ext-pat` },
      sessionsEnded: true,
      userNameKept: true,
    });
    // The externalId filter finds it now.
    const found = await json(
      await call(`/scim/v2/Users?filter=${encodeURIComponent(`externalId eq "${tag}-ext-pat"`)}`),
    );
    expect(found.totalResults).toBe(1);
  });

  it('PATCH active true enables it again; the same PATCH twice changes nothing more', async () => {
    process.env.MANTLE_SCIM_TOKEN_HASH = hash;
    const on = await call(`/scim/v2/Users/${pat}`, {
      method: 'PATCH',
      body: { schemas: [PATCH_OP], Operations: [{ op: 'replace', value: { active: true } }] },
    });
    expect(on.status).toBe(200);
    expect((await json(on)).active).toBe(true);
    expect((await login(pat))!.disabled_at).toBeNull();
    const off1 = await call(`/scim/v2/Users/${pat}`, { method: 'PATCH', body: disable(false) });
    const epoch = (await login(pat))!.session_epoch;
    const off2 = await call(`/scim/v2/Users/${pat}`, { method: 'PATCH', body: disable('false') });
    expect([off1.status, off2.status]).toEqual([200, 200]);
    expect((await login(pat))!.session_epoch).toBe(epoch);
  });

  it('DELETE is a disable: the login and what it made stay', async () => {
    process.env.MANTLE_SCIM_TOKEN_HASH = hash;
    const item = randomUUID();
    await sql`insert into nodes (id, owner_id, type, title, path, login_id)
              values (${item}, ${anchor}, 'note', ${`${tag} note`}, 'notes', ${dan})`;
    await giveCredentials(dan);
    const res = await call(`/scim/v2/Users/${dan}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await login(dan))!.disabled_at).not.toBeNull();
    expect(await liveCredentials(dan)).toEqual({ devices: 0, keys: 0, grants: 0 });
    const [kept] = await sql<Row[]>`select count(*)::int as n from nodes where id = ${item}`;
    expect(kept!.n).toBe(1);
    // Still there for the provider, inactive.
    expect((await json(await call(`/scim/v2/Users/${dan}`))).active).toBe(false);
    const [audit] = await auditRows(dan, 'user.update');
    expect(audit!.detail).toMatchObject({ via: 'scim', deleted: true });

    // The leaver report: nothing can act as the login, its own rows stay.
    const { leaverReport } = await import('@/lib/leaver-report');
    const report = await leaverReport(dan);
    expect(report).toMatchObject({
      login: { id: dan, scim: { managed: true } },
      live: { apiKeys: 0, mcpGrants: 0, devices: 0 },
      ownRows: 1,
    });
  });

  it('an Admin user the provider blocks is disabled too', async () => {
    process.env.MANTLE_SCIM_TOKEN_HASH = hash;
    await giveCredentials(ada);
    const res = await call(`/scim/v2/Users/${ada}`, { method: 'PATCH', body: disable() });
    expect(res.status).toBe(200);
    expect((await login(ada))!.disabled_at).not.toBeNull();
    expect(await liveCredentials(ada)).toEqual({ devices: 0, keys: 0, grants: 0 });
  });

  it('a bad body or a PATCH it cannot read is a SCIM 400 and changes nothing', async () => {
    process.env.MANTLE_SCIM_TOKEN_HASH = hash;
    const target = made;
    for (const body of [
      { schemas: [PATCH_OP], Operations: [{ op: 'replace', path: 'active', value: 'maybe' }] },
      { schemas: [PATCH_OP], Operations: [] },
      'not json',
    ]) {
      const res = await call(`/scim/v2/Users/${target}`, { method: 'PATCH', body });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/scim+json');
    }
    expect((await login(target))!.disabled_at).toBeNull();
    expect((await call('/scim/v2/Users/not-a-uuid')).status).toBe(404);
  });

  it('takes its own rate limit: 600 a minute from one address, then 429', async () => {
    process.env.MANTLE_SCIM_TOKEN_HASH = hash;
    const from = '192.0.2.77';
    const answers: number[] = [];
    for (let i = 0; i < 601; i++) {
      answers.push((await call('/scim/v2/Users', { token: 'wrong', ip: from })).status);
    }
    expect(answers.slice(0, 600).every((s) => s === 401)).toBe(true);
    expect(answers[600]).toBe(429);
    // Another address is not held.
    expect((await call('/scim/v2/ServiceProviderConfig')).status).toBe(200);
  }, 60_000);
});
