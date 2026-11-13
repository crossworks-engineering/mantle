/**
 * Company sign-in for the Control Center's own box ("this box"): POST
 * /api/fleet/sso with `boxId: 'self'` (or `boxIds: ['self']`), through the
 * real app (createApp: the gate, the route policy, the rate limit, the
 * password step) on a real migrated Postgres (docs/oidc-sign-in.md, "From
 * the Control Center"; docs/control-center.md). The route runs the box's
 * own case code in process (sso-channel.ts runSsoCase), so these are the
 * fleet path's refusals, asked of this box:
 *
 *  - a .env mode line wins (env-wins), `off` included, and nothing is written;
 *  - one step only: no skip, no same step;
 *  - the tenant and the client ID only in setup;
 *  - on a live box a new secret is saved only when its Test passes;
 *  - the full run off, setup, set, test, optional, required as a CC Admin;
 *    the raise into required ends the sessions the rule refuses, once;
 *  - the scope line does not apply: the person is at this box;
 *  - refused: no session, a member, an API key, a wrong password, a box that
 *    is not a Control Center (404);
 *  - no value of the secret in any answer, audit row or log line.
 *
 * A stand-in provider on a loopback port answers the Test; the platform
 * fetch to the Entra issuer the tenant names is sent there.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/control/sso-self.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureAdminUsers,
  ensureTestAnchor,
  runWorkspacesSwitch,
  superuserClient,
} from '@mantle/db/test-support';

const URL_ = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;
const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const ENTRA = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const ENV_KEYS = [
  'MANTLE_IS_CONTROL_CENTER',
  'MANTLE_CONTROL_CENTER',
  'MANTLE_CONTROL_CENTER_KEY',
  'MANTLE_CONTROL_CENTER_SCOPE',
  'MANTLE_PUBLIC_URL',
  'MANTLE_OIDC_MODE',
  'MANTLE_OIDC_ISSUER',
  'MANTLE_OIDC_CLIENT_ID',
  'MANTLE_OIDC_CLIENT_SECRET',
  'MANTLE_DETACHED_DEV',
];

describe.skipIf(!URL_)("company sign-in for the Control Center's own box", () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let config: typeof import('@mantle/config');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let provider: Server;
  let loopback = '';
  const realFetch = globalThis.fetch;

  const tag = `ssoself-${randomUUID().slice(0, 8)}`;
  const PASSWORD = 'first password 1';
  // In every secret: no answer, row or log line may hold it.
  const SECRET_WORD = `sekrit${randomUUID().slice(0, 8)}`;
  // The secret the stand-in provider takes, and one it refuses.
  const GOOD = `good-${SECRET_WORD}`;
  const BAD = `bad-${SECRET_WORD}`;
  let anchor = '';
  const admin2 = randomUUID();
  const member = randomUUID();
  const linked = randomUUID();
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let ip = 0;
  let cookie = '';
  let admin2Cookie = '';
  let memberCookie = '';
  const logged: string[] = [];

  const env = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
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
  const sso = (body: Row, as = cookie) =>
    call('/api/fleet/sso', { method: 'POST', cookie: as, body });
  /** The one answer of an ask for this box. */
  const self = async (body: Row) => {
    const res = await sso(body);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).not.toContain(SECRET_WORD);
    const r = JSON.parse(text) as { answers: Row[]; pending: string[]; gone: string[] };
    expect(r.pending).toEqual([]);
    expect(r.gone).toEqual([]);
    expect(r.answers).toHaveLength(1);
    expect(r.answers[0]).toMatchObject({ boxId: 'self', kind: 'sso' });
    return r.answers[0] as Row & { output: Row };
  };
  const status = async () =>
    ((await self({ do: 'status', boxIds: ['self'] })).output.status ?? {}) as Row;
  const raise = (mode: string, password = PASSWORD) =>
    self({ do: 'mode', boxId: 'self', mode, password });
  const set = (vals: Row, password = PASSWORD) =>
    self({ do: 'set', boxId: 'self', ...vals, password });
  const row = async () => (await sql<Row[]>`select * from sso_setup`)[0] ?? null;
  const rowMode = async () => ((await row())?.mode as string | null | undefined) ?? null;
  const opened = async () => {
    const r = await row();
    if (!r?.secret_enc) return null;
    const { open } = await import('@mantle/crypto');
    return open(r.secret_enc as Buffer, m.SSO_SECRET_AAD);
  };
  const epochs = async () =>
    Object.fromEntries(
      (
        await sql<Row[]>`select id, session_epoch from auth.users
          where id in (${anchor}, ${admin2}, ${member}, ${linked})`
      ).map((r) => [r.id as string, Number(r.session_epoch)]),
    );
  const auditRows = async (action: string, want: number) => {
    let found: Row[] = [];
    for (let i = 0; i < 60; i++) {
      found = await sql<Row[]>`select actor_id, action, detail from audit_log
                                where action = ${action} order by created_at`;
      if (found.length >= want) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    return found;
  };
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

  beforeAll(async () => {
    provider = createServer((req, res) => {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url?.endsWith('/.well-known/openid-configuration')) {
        return send(200, {
          issuer: ENTRA,
          authorization_endpoint: `${ENTRA}/auth`,
          token_endpoint: `${ENTRA}/token`,
          jwks_uri: `${ENTRA}/jwks`,
        });
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (body.includes(encodeURIComponent(GOOD))) {
          return send(200, { access_token: 'a', token_type: 'bearer' });
        }
        return send(401, { error: 'invalid_client' });
      });
      return undefined;
    });
    await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
    loopback = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/realm`;
    // The Test's platform fetch to the tenant's issuer goes to the stand-in.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(ENTRA)) return realFetch(input, init);
      const to = loopback + url.slice(ENTRA.length);
      return input instanceof Request
        ? realFetch(new Request(to, input), init)
        : realFetch(to, init);
    });
    // Every log line, to prove no secret reaches one.
    for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const orig = console[k].bind(console);
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(' '));
        orig(...a);
      });
    }
    for (const stream of [process.stdout, process.stderr]) {
      const orig = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        logged.push(String(chunk));
        return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }

    scratch = await createMigratedScratchDatabase(URL_!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    if (Buffer.from(process.env.MANTLE_MASTER_KEY, 'base64').length !== 32) {
      process.env.MANTLE_MASTER_KEY_NEXT ??= Buffer.alloc(32, 5).toString('base64');
    }
    process.env.SESSION_SECRET = 'sso-self-db-test-secret-at-least-32-chars';
    for (const k of ENV_KEYS) delete process.env[k];
    env({ MANTLE_IS_CONTROL_CENTER: 'on', MANTLE_PUBLIC_URL: 'https://cc.example.invalid' });
    m = await import('@mantle/db');
    config = await import('@mantle/config');
    sql = superuserClient(scratch.url) as unknown as typeof sql;
    // The original account is the CC Admin who sets this box up: under
    // required its password sessions stay (the anchor's rule).
    anchor = await ensureTestAnchor(sql);
    const pw = bcrypt.hashSync(PASSWORD, 4);
    await sql`update auth.users set email = ${emailOf(anchor)}, password_hash = ${pw}
              where id = ${anchor}`;
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${admin2}, ${emailOf(admin2)}, ${pw}, 'admin'),
      (${member}, ${emailOf(member)}, ${pw}, 'member'),
      (${linked}, ${emailOf(linked)}, ${pw}, 'member')`;
    await sql`insert into oidc_signin_links (login_id, issuer, subject)
      values (${linked}, ${ENTRA}, 'sub-linked')`;
    await runWorkspacesSwitch(scratch.url);
    await ensureAdminUsers(sql as never, [admin2]);
    const { createApp } = await import('../../server/app');
    app = await createApp();
    cookie = await signIn(anchor);
    admin2Cookie = await signIn(admin2);
    memberCookie = await signIn(member);
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const k of [...ENV_KEYS, 'MANTLE_MASTER_KEY_NEXT']) delete process.env[k];
    config?.setOidcRow({});
    await new Promise((r) => provider?.close(r));
    await (sql as unknown as { end?: () => Promise<void> } | undefined)?.end?.();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('refused: no session, a member, an API key, a box that is not a Control Center', async () => {
    const asks: Row[] = [
      { do: 'status', boxIds: ['self'] },
      { do: 'mode', boxId: 'self', mode: 'setup', password: PASSWORD },
      { do: 'set', boxId: 'self', secret: GOOD, password: PASSWORD },
    ];
    for (const body of asks) {
      expect((await call('/api/fleet/sso', { method: 'POST', body })).status).toBe(401);
      expect((await sso(body, memberCookie)).status).toBe(403);
    }
    // An API key, even the original account's own: no key reaches the route.
    const made = await call('/api/access-keys', {
      method: 'POST',
      cookie,
      body: { name: tag, access: 'read_write', areas: ['pages'], password: PASSWORD },
    });
    expect(made.status).toBe(201);
    const { secret: key } = (await made.json()) as { secret: string };
    for (const body of asks) {
      const res = await call('/api/fleet/sso', { method: 'POST', bearer: key, body });
      expect(res.status).toBe(401);
    }
    // Not a Control Center: as if the route were not there.
    env({ MANTLE_IS_CONTROL_CENTER: undefined });
    for (const body of asks) expect((await sso(body)).status).toBe(404);
    env({ MANTLE_IS_CONTROL_CENTER: 'on' });
    expect(await row()).toBeNull();
  });

  it("'self' stands alone and by its shape; a wrong password raises and saves nothing", async () => {
    for (const body of [
      { do: 'status', boxIds: ['self', randomUUID()] },
      { do: 'status', boxIds: ['SELF'] },
      { do: 'mode', boxId: 'self', mode: 'off', password: PASSWORD },
      { do: 'set', boxId: 'this', secret: GOOD, password: PASSWORD },
    ]) {
      expect((await sso(body)).status, JSON.stringify(body)).toBe(400);
    }
    const wrong = await sso({ do: 'mode', boxId: 'self', mode: 'setup', password: 'not it' });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ code: 'password' });
    const wrongSet = await sso({ do: 'set', boxId: 'self', secret: GOOD, password: 'not it' });
    expect(wrongSet.status).toBe(403);
    expect(await row()).toBeNull();
  });

  it('a .env mode line wins, off included: env-wins, and nothing is written', async () => {
    for (const line of ['off', 'setup', 'optional', 'required']) {
      env({ MANTLE_OIDC_MODE: line });
      for (const mode of ['setup', 'optional', 'required']) {
        const a = await raise(mode);
        expect(a, `${line} ${mode}`).toMatchObject({
          name: 'sso_mode',
          ok: false,
          reason: 'env-wins',
          output: { ok: false, reason: 'env-wins', status: { mode: line, modeFrom: 'env' } },
        });
      }
    }
    env({ MANTLE_OIDC_MODE: undefined });
    expect(await rowMode()).toBeNull();
    // The refused raises have their rows, with the result.
    const rows = await auditRows('fleet.sso_mode', 12);
    expect(rows).toHaveLength(12);
    for (const r of rows) {
      expect(r).toMatchObject({
        actor_id: anchor,
        detail: { boxId: 'self', result: { ok: false, reason: 'env-wins' } },
      });
    }
  });

  it('mode off: the status says off; a save and a Test are refused; one step only', async () => {
    expect(await status()).toMatchObject({ mode: 'off', modeFrom: 'none', linked: null });
    expect(await set({ tenant: TENANT })).toMatchObject({ ok: false, reason: 'mode' });
    expect(await set({ secret: GOOD })).toMatchObject({ ok: false, reason: 'mode' });
    expect(await self({ do: 'test', boxIds: ['self'] })).toMatchObject({
      name: 'sso_test',
      ok: false,
      reason: 'mode',
    });
    expect(await raise('optional')).toMatchObject({ ok: false, output: { from: 'off' } });
    expect(await raise('required')).toMatchObject({ ok: false, output: { from: 'off' } });
    expect(await row()).toBeNull();
  });

  it('the scope line does not apply to this box: the full run off to optional', async () => {
    env({ MANTLE_CONTROL_CENTER_SCOPE: 'none' });
    expect(await raise('setup')).toMatchObject({ ok: true, output: { from: 'off' } });
    expect(await rowMode()).toBe('setup');
    expect(config.oidcModeWord()).toBe('setup');
    expect(await raise('setup')).toMatchObject({ ok: false, reason: 'mode' });
    expect(await raise('required')).toMatchObject({ ok: false, reason: 'mode' });
    // The three values, staged in setup (no Test then), the secret sealed
    // with this box's own key.
    const saved = await set({ tenant: TENANT.toUpperCase(), clientId: CLIENT, secret: GOOD });
    expect(saved).toMatchObject({ name: 'sso_set', ok: true });
    expect(saved.output.test).toBeUndefined();
    expect(await row()).toMatchObject({ issuer: ENTRA, client_id: CLIENT });
    expect(await opened()).toBe(GOOD);
    expect(await status()).toMatchObject({
      mode: 'setup',
      modeFrom: 'row',
      tenant: TENANT,
      issuerFrom: 'row',
      clientIdFrom: 'row',
      secret: 'row',
      missing: [],
    });
    // The Test runs with the saved values.
    expect(await self({ do: 'test', boxIds: ['self'] })).toMatchObject({
      ok: true,
      output: { test: 'ok' },
    });
    expect(await raise('optional')).toMatchObject({ ok: true, output: { from: 'setup' } });
    expect(await status()).toMatchObject({ mode: 'optional', linked: 1 });
    env({ MANTLE_CONTROL_CENTER_SCOPE: undefined });
  });

  it('on a live box: no tenant or client; a secret only when its Test passes', async () => {
    expect(await set({ tenant: TENANT })).toMatchObject({ ok: false, reason: 'mode' });
    expect(await set({ clientId: CLIENT })).toMatchObject({ ok: false, reason: 'mode' });
    const failed = await set({ secret: BAD });
    expect(failed).toMatchObject({
      ok: false,
      reason: 'test',
      output: { reason: 'test', test: 'secret-refused' },
    });
    expect(await opened()).toBe(GOOD);
    // A .env value wins: refused, and the row keeps its own.
    env({ MANTLE_OIDC_CLIENT_SECRET: 'from-env' });
    expect(await set({ secret: GOOD })).toMatchObject({ ok: false, reason: 'env-wins' });
    env({ MANTLE_OIDC_CLIENT_SECRET: undefined });
    const again = await set({ secret: GOOD });
    expect(again).toMatchObject({ ok: true, output: { test: 'ok' } });
    expect(await opened()).toBe(GOOD);
  });

  it('optional to required ends the sessions the rule refuses, once; the original account stays', async () => {
    const before = await epochs();
    expect(await raise('required')).toMatchObject({ ok: true, output: { from: 'optional' } });
    expect(await rowMode()).toBe('required');
    const after = await epochs();
    // The original account keeps its password sessions; every other ends.
    expect(after[anchor]).toBe(before[anchor]);
    for (const id of [admin2, member, linked]) expect(after[id]).toBeGreaterThan(before[id]!);
    expect([401, 403]).toContain(
      (await sso({ do: 'status', boxIds: ['self'] }, admin2Cookie)).status,
    );
    // Required is the top: no step further, and nothing ends again.
    expect(await raise('required')).toMatchObject({ ok: false, reason: 'mode' });
    expect(await status()).toMatchObject({ mode: 'required', modeFrom: 'row' });
    expect(await epochs()).toEqual(after);
  });

  it('no value of the secret in any answer, audit row, row text or log line', async () => {
    const sets = await auditRows('fleet.sso_set', 1);
    expect(sets.length).toBeGreaterThan(0);
    expect(sets).toContainEqual(
      expect.objectContaining({
        actor_id: anchor,
        detail: expect.objectContaining({
          boxId: 'self',
          fields: ['tenant', 'clientId', 'secret'],
          result: { ok: true, reason: null },
        }),
      }),
    );
    // A refused save names its reason, and the Test's code when one ran.
    expect(sets).toContainEqual(
      expect.objectContaining({
        detail: expect.objectContaining({
          fields: ['secret'],
          result: { ok: false, reason: 'test', test: 'secret-refused' },
        }),
      }),
    );
    const [audit] = await sql<Row[]>`select coalesce(string_agg(detail::text, ' '), '') as t
                                     from audit_log`;
    expect(String(audit!.t)).not.toContain(SECRET_WORD);
    const [setup] = await sql<Row[]>`select row_to_json(s)::text as t from sso_setup s`;
    expect(String(setup!.t)).not.toContain(SECRET_WORD);
    // The capture saw the run's own lines, so an empty capture cannot pass.
    expect(logged.join('\n')).toContain('company sign-in');
    expect(logged.join('\n')).not.toContain(SECRET_WORD);
  });
});
