/**
 * The setup screen through the real app (createApp: the gate, the route
 * policies, the rate limits) on a real migrated Postgres, with a stand-in
 * provider on a loopback port (docs/oidc-sign-in.md):
 *
 *  - mode off: the status says off and reads nothing, every write is closed,
 *    no row is made;
 *  - setup: only an Admin user reaches the screen; a member, no session and an
 *    API key do not;
 *  - the secret: asks the password (a wrong one saves nothing and is audited;
 *    the rest of that step: sso-setup-password.test.ts), is stored sealed,
 *    never comes back, and the Test sends it to the provider;
 *  - the SCIM token: asked the same way, shown once, its hash kept, works at
 *    once at /scim/v2, keeps working after the lock, and a new one replaces it;
 *  - the .env wins over both;
 *  - the lock: optional and required are read-only;
 *  - a return from setup to required records nothing;
 *  - the row at a bare read and a write through oidcWrite, on the runtime role
 *    where the lane runs one, in a route's login exit and in SCIM's public one.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/oidc/sso-setup.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureAdminUsers,
  ensureTestAnchor,
  runWorkspacesSwitch,
  superuserClient,
} from '@mantle/db/test-support';

const URL_ = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;

describe.skipIf(!URL_)('the setup screen through the app', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let provider: Server;
  let issuer = '';
  const tokenCalls: string[] = [];
  let tokenAnswer: 'ok' | 'refuse' = 'ok';

  const tag = `sso-${randomUUID().slice(0, 8)}`;
  const admin = randomUUID();
  const member = randomUUID();
  const PASSWORD = 'first password 1';
  const SECRET = `the-client-secret-${tag}`;
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let ip = 0;
  let cookie = '';
  let memberCookie = '';

  const call = (
    path: string,
    init: { method?: string; cookie?: string; bearer?: string; body?: unknown } = {},
  ) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${ip % 250}`,
      'x-forwarded-proto': 'https',
    };
    if (init.cookie) headers.cookie = init.cookie;
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    return Promise.resolve(
      app.request(path, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  };
  const json = async (res: Response) => (await res.json()) as Row;
  const signIn = async (id: string) => {
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: { email: emailOf(id), password: PASSWORD },
    });
    const c = res.headers
      .getSetCookie()
      .find((x) => x.startsWith('mantle_session='))
      ?.split(';')[0];
    expect(c, await res.clone().text()).toBeTruthy();
    return c!;
  };
  const rows = () => sql<Row[]>`select * from sso_setup`;
  const auditOf = async (action: string, want = 1) => {
    let found: Row[] = [];
    for (let i = 0; i < 60; i++) {
      found = await sql<Row[]>`select actor_id, action, detail, path from audit_log
                                where action = ${action} and actor_id = ${admin}`;
      if (found.length >= want) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    return found;
  };
  const putSecret = (secret: string, password = PASSWORD) =>
    call('/api/users/sso-setup', { method: 'PUT', cookie, body: { secret, password } });
  const makeToken = (password = PASSWORD) =>
    call('/api/users/sso-setup/scim-token', { method: 'POST', cookie, body: { password } });
  const scimProbe = (token: string) => call('/scim/v2/ServiceProviderConfig', { bearer: token });

  beforeAll(async () => {
    provider = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url?.endsWith('/.well-known/openid-configuration')) {
        return send(200, {
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        tokenCalls.push(body);
        if (tokenAnswer === 'refuse') return send(401, { error: 'invalid_client' });
        return send(200, { access_token: 'a', token_type: 'bearer' });
      });
      return undefined;
    });
    await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
    issuer = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/realm`;

    scratch = await createMigratedScratchDatabase(URL_!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    // The viewer roles' passwords come from that key, which the run may have
    // set to the short test key: seal under MANTLE_MASTER_KEY_NEXT then.
    if (Buffer.from(process.env.MANTLE_MASTER_KEY, 'base64').length !== 32) {
      process.env.MANTLE_MASTER_KEY_NEXT ??= Buffer.alloc(32, 7).toString('base64');
    }
    process.env.SESSION_SECRET = 'sso-setup-db-test-secret-at-least-32-chars';
    process.env.MANTLE_PUBLIC_URL = 'https://brain.example.invalid';
    process.env.MANTLE_OIDC_ISSUER = issuer;
    process.env.MANTLE_OIDC_CLIENT_ID = 'mantle';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_OIDC_MODE;
    delete process.env.MANTLE_OIDC_CLIENT_SECRET;
    delete process.env.MANTLE_SCIM_TOKEN_HASH;
    m = await import('@mantle/db');
    sql = superuserClient(scratch.url) as unknown as typeof sql;
    await ensureTestAnchor(sql);
    const pw = bcrypt.hashSync(PASSWORD, 4);
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${admin}, ${emailOf(admin)}, ${pw}, 'admin'),
      (${member}, ${emailOf(member)}, ${pw}, 'member')`;
    await runWorkspacesSwitch(scratch.url);
    await ensureAdminUsers(sql as never, [admin]);
    const { createApp } = await import('../../server/app');
    app = await createApp();
    cookie = await signIn(admin);
    memberCookie = await signIn(member);
  }, 120_000);

  afterAll(async () => {
    for (const k of [
      'MANTLE_MASTER_KEY_NEXT',
      'MANTLE_OIDC_MODE',
      'MANTLE_OIDC_ISSUER',
      'MANTLE_OIDC_CLIENT_ID',
      'MANTLE_OIDC_CLIENT_SECRET',
      'MANTLE_SCIM_TOKEN_HASH',
      'MANTLE_PUBLIC_URL',
    ]) {
      delete process.env[k];
    }
    await new Promise((r) => provider?.close(r));
    await (sql as unknown as { end?: () => Promise<void> } | undefined)?.end?.();
    await m?.closeDb();
    await scratch?.drop();
  });

  beforeEach(() => {
    process.env.MANTLE_OIDC_MODE = 'setup';
    delete process.env.MANTLE_OIDC_CLIENT_SECRET;
    delete process.env.MANTLE_SCIM_TOKEN_HASH;
    tokenCalls.length = 0;
    tokenAnswer = 'ok';
  });

  it('mode off: the status says off, every write is closed, no row is made', async () => {
    process.env.MANTLE_OIDC_MODE = 'off';
    const status = await call('/api/users/sso-setup', { cookie });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ mode: 'off' });
    for (const res of [
      await putSecret(SECRET),
      await makeToken(),
      await call('/api/users/sso-setup/test', { method: 'POST', cookie }),
    ]) {
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ code: 'setup-closed' });
    }
    expect(await rows()).toEqual([]);
    expect((await scimProbe('anything')).status).toBe(404);
  });

  it('only an Admin user reaches the screen', async () => {
    expect((await call('/api/users/sso-setup')).status).toBe(401);
    expect((await call('/api/users/sso-setup', { cookie: memberCookie })).status).toBe(403);
    expect(
      (
        await call('/api/users/sso-setup', {
          method: 'PUT',
          cookie: memberCookie,
          body: { secret: SECRET, password: PASSWORD },
        })
      ).status,
    ).toBe(403);
    // An API key, even the Admin's own: these rows are not in /api/v1.
    const made = await call('/api/access-keys', {
      method: 'POST',
      cookie,
      body: { name: tag, access: 'read_write', areas: ['pages'], password: PASSWORD },
    });
    expect(made.status).toBe(201);
    const { secret: key } = (await made.json()) as { secret: string };
    expect((await call('/api/users/sso-setup', { bearer: key })).status).toBe(401);
    expect(
      (
        await call('/api/users/sso-setup/scim-token', {
          method: 'POST',
          bearer: key,
          body: { password: PASSWORD },
        })
      ).status,
    ).toBe(401);
    expect(await rows()).toEqual([]);
  });

  it('the status names the .env values and no secret', async () => {
    const res = await call('/api/users/sso-setup', { cookie });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await json(res)).toMatchObject({
      mode: 'setup',
      issuer,
      clientId: 'mantle',
      redirectUri: 'https://brain.example.invalid/api/auth/oidc/callback',
      scimUrl: 'https://brain.example.invalid/scim/v2',
      envMissing: [],
      secret: 'none',
      scim: 'none',
    });
  });

  it('the Test with no secret says so, and calls no provider', async () => {
    const res = await call('/api/users/sso-setup/test', { method: 'POST', cookie });
    expect(await json(res)).toEqual({ outcome: 'no-secret' });
    expect(tokenCalls).toEqual([]);
  });

  it('a wrong password saves nothing and is audited, with no value', async () => {
    const res = await putSecret(SECRET, 'not the password');
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ code: 'password' });
    expect(body).not.toContain(SECRET);
    expect(await rows()).toEqual([]);
    const [row] = await auditOf('auth.login_failed');
    expect(row!.detail).toMatchObject({ channel: 'sso-setup', reason: 'password' });
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('a bad body answers without echoing the secret', async () => {
    const long = 'x'.repeat(1025);
    const res = await call('/api/users/sso-setup', {
      method: 'PUT',
      cookie,
      body: { secret: long, password: PASSWORD },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(long);
    const blank = await putSecret('   ');
    expect(blank.status).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it('the secret is stored sealed, never comes back, and the Test sends it', async () => {
    const res = await putSecret(`  ${SECRET}  `);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({
      secret: 'row',
      secretSet: { by: emailOf(admin) },
    });

    const [row] = await rows();
    const sealed = row!.secret_enc as Buffer;
    expect(sealed.toString('latin1')).not.toContain(SECRET);
    expect(row!.secret_set_by).toBe(admin);
    const { open } = await import('@mantle/crypto');
    expect(open(Buffer.from(sealed), m.SSO_SECRET_AAD)).toBe(SECRET);
    expect(() => open(Buffer.from(sealed), 'another:binding')).toThrow();

    const [audit] = await auditOf('auth.sso_setup_secret_set');
    expect(audit!.detail).toEqual({ field: 'secret' });
    expect(JSON.stringify(audit)).not.toContain(SECRET);

    const status = await (await call('/api/users/sso-setup', { cookie })).text();
    expect(status).not.toContain(SECRET);
    expect(status).not.toContain(sealed.toString('base64'));

    const test = await call('/api/users/sso-setup/test', { method: 'POST', cookie });
    expect(await json(test)).toEqual({ outcome: 'ok' });
    expect(new URLSearchParams(tokenCalls[0]).get('client_secret')).toBe(SECRET);

    tokenAnswer = 'refuse';
    const refused = await call('/api/users/sso-setup/test', { method: 'POST', cookie });
    expect(await json(refused)).toEqual({ outcome: 'secret-refused' });
  });

  it('the SCIM token is shown once, works at once, and survives the lock', async () => {
    const wrong = await makeToken('not the password');
    expect(wrong.status).toBe(403);
    const res = await makeToken();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { token } = (await res.json()) as { token: string };
    const [row] = await rows();
    expect(row!.scim_token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row!.scim_set_by).toBe(admin);
    const [audit] = await auditOf('auth.sso_setup_scim_token_made');
    expect(audit!.detail).toEqual({ field: 'scim-token' });
    expect(JSON.stringify(audit)).not.toContain(token);

    const status = await (await call('/api/users/sso-setup', { cookie })).text();
    expect(status).not.toContain(token);
    expect(status).not.toContain(row!.scim_token_hash as string);
    expect(JSON.parse(status)).toMatchObject({ scim: 'row', scimSet: { by: emailOf(admin) } });

    expect((await scimProbe(token)).status).toBe(200);
    expect((await scimProbe(`${token}x`)).status).toBe(401);

    process.env.MANTLE_OIDC_MODE = 'optional';
    expect((await scimProbe(token)).status).toBe(200);
    process.env.MANTLE_OIDC_MODE = 'required';
    expect((await scimProbe(token)).status).toBe(200);
    // Mode off stops row SCIM too, and the .env stop does in every mode.
    process.env.MANTLE_OIDC_MODE = 'off';
    expect((await scimProbe(token)).status).toBe(404);
    process.env.MANTLE_OIDC_MODE = 'optional';
    process.env.MANTLE_SCIM_TOKEN_HASH = 'off';
    expect((await scimProbe(token)).status).toBe(404);
    delete process.env.MANTLE_SCIM_TOKEN_HASH;

    process.env.MANTLE_OIDC_MODE = 'setup';
    const next = (await (await makeToken()).json()) as { token: string };
    expect(next.token).not.toBe(token);
    expect((await scimProbe(next.token)).status).toBe(200);
    expect((await scimProbe(token)).status).toBe(401);
  });

  it('a value in the .env wins, and the screen says so', async () => {
    process.env.MANTLE_OIDC_CLIENT_SECRET = 'from-the-env';
    const put = await putSecret('another');
    expect(put.status).toBe(409);
    expect(await json(put)).toMatchObject({ code: 'env-wins' });
    for (const value of ['off', 'cd'.repeat(32), 'not-a-hash']) {
      process.env.MANTLE_SCIM_TOKEN_HASH = value;
      const res = await makeToken();
      expect(res.status, value).toBe(409);
      expect(await json(res)).toMatchObject({ code: 'env-wins' });
    }
    process.env.MANTLE_SCIM_TOKEN_HASH = 'off';
    expect(await json(await call('/api/users/sso-setup', { cookie }))).toMatchObject({
      secret: 'env',
      scim: 'env-off',
    });
  });

  it('optional is locked: it reads, and nothing writes', async () => {
    process.env.MANTLE_OIDC_MODE = 'optional';
    const [before] = await rows();
    const status = await call('/api/users/sso-setup', { cookie });
    expect(await json(status)).toMatchObject({ mode: 'optional', secret: 'row', scim: 'row' });
    for (const res of [
      await putSecret('a-locked-secret'),
      await makeToken(),
      await call('/api/users/sso-setup/test', { method: 'POST', cookie }),
    ]) {
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({ code: 'setup-closed' });
    }
    const [after] = await rows();
    expect(after).toEqual(before);
  });

  it('required is locked too, for the original account, which keeps its password', async () => {
    process.env.MANTLE_OIDC_MODE = 'optional';
    await sql`update auth.users set password_hash = ${bcrypt.hashSync(PASSWORD, 4)}
               where is_owner = true`;
    const [owner] = await sql<Row[]>`select email from auth.users where is_owner = true`;
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: { email: owner!.email, password: PASSWORD },
    });
    const ownerCookie = res.headers
      .getSetCookie()
      .find((x) => x.startsWith('mantle_session='))
      ?.split(';')[0];
    expect(ownerCookie).toBeTruthy();
    process.env.MANTLE_OIDC_MODE = 'required';
    const [before] = await rows();
    const status = await call('/api/users/sso-setup', { cookie: ownerCookie });
    expect(await json(status)).toMatchObject({ mode: 'required', secret: 'row', scim: 'row' });
    const put = await call('/api/users/sso-setup', {
      method: 'PUT',
      cookie: ownerCookie,
      body: { secret: 'a-locked-secret', password: PASSWORD },
    });
    expect(put.status).toBe(403);
    expect(await json(put)).toMatchObject({ code: 'setup-closed' });
    const [after] = await rows();
    expect(after).toEqual(before);
  });

  it('setup records no mode, so a return to required is no switch', async () => {
    await sql`insert into oidc_mode_state (id, mode) values (true, 'required')
              on conflict (id) do update set mode = 'required'`;
    const epoch = async () =>
      (await sql<Row[]>`select session_epoch from auth.users where id = ${member}`)[0]!
        .session_epoch;
    const before = await epoch();
    process.env.MANTLE_OIDC_MODE = 'setup';
    const { oidcBootCheck } = await import('./boot');
    const { runAsSystem } = m;
    await runAsSystem('test:oidc-check', () => oidcBootCheck());
    const [state] = await sql<Row[]>`select mode from oidc_mode_state`;
    expect(state!.mode).toBe('required');
    process.env.MANTLE_OIDC_MODE = 'required';
    await runAsSystem('test:oidc-check', () => oidcBootCheck());
    expect(await epoch()).toBe(before);
  });
});
