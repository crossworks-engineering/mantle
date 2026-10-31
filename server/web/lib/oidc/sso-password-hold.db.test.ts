/**
 * The box password rule and company sign-in TOGETHER (docs/policy.md,
 * docs/oidc-sign-in.md), through the real app on a real migrated Postgres,
 * with MANTLE_POLICY_PASSWORD_MIN=12 and the provider stood in. Each
 * feature's own test clears only its own settings; this one sets both:
 *
 *  - required: a linked login's password is no way in, so no hold reaches
 *    it, unchecked or flagged: its SSO cookie, an API key, an MCP grant and
 *    a paired Telegram chat all pass, and a password typed for it (refused,
 *    sso-required) writes nothing;
 *  - optional: a held password cookie does not turn company sign-in's
 *    callback into a raw 401 or 403; an SSO session meets the change step
 *    (the password is still a way in) but never the recheck; a linked
 *    login's grant is not rechecked, an unlinked login's is.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/oidc/sso-password-hold.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  asSuperuser,
  createMigratedScratchDatabase,
  ensureTestAnchor,
  runWorkspacesSwitch,
} from '@mantle/db/test-support';

const ISSUER = 'https://idp.example.invalid/realms/company';
const h = vi.hoisted(() => ({ subject: 'sub-x' }));

vi.mock('./provider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authorizationUrl: async (_s: unknown, f: { state: string }) =>
    `${'https://idp.example.invalid/realms/company'}/auth?state=${f.state}`,
  identityFromCallback: async (_s: unknown, q: URLSearchParams, f: { state: string }) => {
    if (q.get('state') !== f.state) throw new Error('state mismatch');
    return {
      issuer: 'https://idp.example.invalid/realms/company',
      subject: h.subject,
      tid: null,
      oid: null,
    };
  },
}));

const URL = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const ENV_KEYS = [
  'MANTLE_POLICY_PASSWORD_MIN',
  'MANTLE_OIDC_MODE',
  'MANTLE_OIDC_ISSUER',
  'MANTLE_OIDC_CLIENT_ID',
  'MANTLE_OIDC_SESSION_HOURS',
  'MANTLE_PUBLIC_URL',
] as const;

describe.skipIf(!URL)('the password rule and company sign-in together', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('../auth/tokens');
  let hold: typeof import('./hold') | undefined;
  const saved: Record<string, string | undefined> = {};
  const tag = `ssopw-${randomUUID().slice(0, 8)}`;
  const lk = randomUUID(); // linked, its password never checked under the rule
  const wk = randomUUID(); // linked, a weak password
  const un = randomUUID(); // not linked, never checked
  const WEAK = 'password1234';
  const GOOD = 'blue kettle under the stairs';
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  const keys: Record<string, string> = {};
  const grants: Record<string, string> = {};
  let anchor = '';
  let account = '';
  let ip = 0;

  const call = (
    path: string,
    init: { method?: string; cookies?: (string | null)[]; bearer?: string; body?: unknown } = {},
  ) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': `192.0.2.${ip % 250}`,
      'x-forwarded-proto': 'https',
    };
    const jar = (init.cookies ?? []).filter((c): c is string => !!c);
    if (jar.length) headers.cookie = jar.join('; ');
    if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
    return Promise.resolve(
      app.request(path, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  };
  const cookie = (res: Response, name: string): string | null => {
    const c = res.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
    const v = c?.split(';')[0];
    return v && v !== `${name}=` ? v : null;
  };
  /** A member route past the gate: 'past', or the hold's code. */
  const probe = async (init: { cookies?: (string | null)[]; bearer?: string }) => {
    const r = await call(init.bearer ? '/api/v1/whoami' : '/api/member/push/preferences', init);
    if (r.status !== 401 && r.status !== 403) return 'past';
    const body = (await r.json()) as { code?: string };
    return body.code ?? String(r.status);
  };
  const epochOf = async (id: string) =>
    Number(
      (await sql<Row[]>`select session_epoch from auth.users where id = ${id}`)[0]!.session_epoch,
    );
  const ssoCookie = async (id: string) =>
    `mantle_session=${tokens.buildSessionCookie(id, { epoch: await epochOf(id), ttlSeconds: 3600, oidc: true }).value}`;
  const passwordCookie = async (id: string) =>
    `mantle_session=${tokens.buildSessionCookie(id, { epoch: await epochOf(id) }).value}`;
  const stateOf = async (id: string) =>
    (
      await sql<Row[]>`select must_change_password as flag, password_checked_min as checked
                         from auth.users where id = ${id}`
    )[0]!;
  const mcp = async (id: string) =>
    (await import('../mcp-auth')).resolveMcpCaller(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${grants[id]}` },
      }),
    );
  const telegram = async (id: string) =>
    (await import('@mantle/telegram')).chatLoginRefusal({
      ownerId: anchor,
      loginId: id,
      accountId: account,
      responderAgentId: null,
    });
  const setMode = (mode: string) => {
    process.env.MANTLE_OIDC_MODE = mode;
    // The gate's facts are kept a few seconds per login and issuer.
    hold?.forgetHolds();
  };
  /** Company sign-in, start to callback, with `jar` already in the browser. */
  const companySignIn = async (subject: string, jar: (string | null)[]) => {
    const go = await call('/api/auth/oidc/start?return=/', { cookies: jar });
    const flow = cookie(go, '__Host-mantle_oidc_flow');
    const state = new globalThis.URL(go.headers.get('location')!).searchParams.get('state')!;
    h.subject = subject;
    return call(`/api/auth/oidc/callback?code=c&state=${state}`, { cookies: [...jar, flow] });
  };

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'sso-password-hold-db-test-secret-32-chars';
    process.env.MANTLE_POLICY_PASSWORD_MIN = '12';
    process.env.MANTLE_PUBLIC_URL = 'https://brain.example.invalid';
    process.env.MANTLE_OIDC_ISSUER = ISSUER;
    process.env.MANTLE_OIDC_CLIENT_ID = 'mantle';
    delete process.env.MANTLE_OIDC_SESSION_HOURS;
    delete process.env.MANTLE_DETACHED_DEV;
    setMode('required');
    (await import('@mantle/config')).resetBoxPolicyForTests();
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('../auth/tokens');
    hold = await import('./hold');
    anchor = await ensureTestAnchor(sql);
    const su = asSuperuser();
    await su`insert into auth.users (id, email, password_hash, role) values
      (${lk}, ${emailOf(lk)}, ${bcrypt.hashSync(GOOD, 4)}, 'member'),
      (${wk}, ${emailOf(wk)}, ${bcrypt.hashSync(WEAK, 4)}, 'member'),
      (${un}, ${emailOf(un)}, ${bcrypt.hashSync(GOOD, 4)}, 'member')`;
    await runWorkspacesSwitch(scratch.url);
    await su`insert into oidc_signin_links (login_id, issuer, subject) values
      (${lk}, ${ISSUER}, 'sub-lk'), (${wk}, ${ISSUER}, 'sub-wk')`;

    // An API key and an MCP grant for each login.
    const { mintAccessKey } = await import('../access-keys');
    const client = randomUUID();
    await su`insert into oauth_clients (id, client_name, redirect_uris)
      values (${client}, ${`${tag} client`}, ${['https://client.example.invalid/cb']})`;
    for (const id of [lk, wk, un]) {
      const made = await mintAccessKey({
        name: `${tag} key`,
        loginId: id,
        access: 'read',
        areas: null,
        riskyTools: [],
        expiresAt: null,
        createdBy: id,
        maxLive: 5,
      });
      keys[id] = made!.key;
      grants[id] = `mtlmcp_at_${randomUUID().replace(/-/g, '')}`;
      await su`insert into oauth_access_tokens
          (token_hash, owner_id, actor_id, client_id, scope, expires_at, session_epoch)
        values (${sha(grants[id]!)}, ${anchor}, ${id}, ${client}, 'mcp',
                now() + interval '1 hour', ${await epochOf(id)})`;
    }

    // A Telegram bot whose assistant is in a workspace all three are users of.
    const [ws] = await su<Row>`insert into workspaces (owner_id, name, is_admin)
      values (${anchor}, ${tag}, false) returning id::text`;
    for (const id of [lk, wk, un]) {
      await su`insert into workspace_users (workspace_id, login_id, moderator)
        values (${ws!.id as string}, ${id}, false) on conflict do nothing`;
    }
    const agent = randomUUID();
    const channel = randomUUID();
    account = randomUUID();
    await su`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${agent}, ${anchor}, ${tag}, ${tag}, 'fake/model', 'p', 'responder', ${ws!.id as string})`;
    await su`insert into channels (id, owner_id, agent_id, type, display_name, credentials_enc)
      values (${channel}, ${anchor}, ${agent}, 'telegram', ${`@${tag}`}, '\\x00')`;
    await su`insert into telegram_accounts (id, user_id, bot_username, branch_path, channel_id)
      values (${account}, ${anchor}, ${`${tag}_bot`}, 'inbox.telegram_test', ${channel})`;

    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 180_000);

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    (await import('@mantle/config')).resetBoxPolicyForTests();
    hold?.forgetHolds();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('required: a linked login is outside the rule, by every credential', async () => {
    // The Policy panel's count leaves the two linked logins out.
    const { heldLoginCounts } = await import('../policy-check');
    setMode('optional');
    const optional = await heldLoginCounts();
    setMode('required');
    const required = await heldLoginCounts();
    expect(optional.recheck - required.recheck).toBe(2);
    expect(await stateOf(lk)).toEqual({ flag: false, checked: null });
    expect(await telegram(un)).toBe('password_hold');
    for (const flag of [false, true]) {
      await asSuperuser()`update auth.users set must_change_password = ${flag} where id = ${lk}`;
      const sso = await ssoCookie(lk);
      expect(await probe({ cookies: [sso] }), `sso, flag ${flag}`).toBe('past');
      const who = await call('/api/auth/whoami', { cookies: [sso] });
      expect(who.status).toBe(200);
      expect(await who.json()).not.toHaveProperty('mustChangePassword');
      expect(await probe({ bearer: keys[lk] }), `key, flag ${flag}`).toBe('past');
      expect(await mcp(lk), `mcp, flag ${flag}`).not.toBeNull();
      expect(await telegram(lk), `telegram, flag ${flag}`).toBeNull();
    }
    await asSuperuser()`update auth.users set must_change_password = false where id = ${lk}`;

    // A weak password typed for a linked login is refused and writes nothing.
    const refused = await call('/api/auth/login', {
      method: 'POST',
      body: { email: emailOf(wk), password: WEAK },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'sso-required' });
    expect(await stateOf(wk)).toEqual({ flag: false, checked: null });
    expect(await probe({ cookies: [await ssoCookie(wk)] })).toBe('past');
  });

  it('optional: a held cookie reaches the callback; an SSO session meets change, never recheck', async () => {
    setMode('optional');
    // A weak password sign-in: the login is held to the change step.
    const signIn = await call('/api/auth/login', {
      method: 'POST',
      body: { email: emailOf(wk), password: WEAK },
    });
    expect(signIn.status).toBe(200);
    const held = cookie(signIn, 'mantle_session');
    expect(await stateOf(wk)).toEqual({ flag: true, checked: 12 });
    expect(await probe({ cookies: [held] })).toBe('password_change_required');

    // Company sign-in with that cookie in the browser: a redirect, not a 403.
    const back = await companySignIn('sub-wk', [held]);
    expect(back.status).toBe(302);
    const sso = cookie(back, 'mantle_session');
    expect(sso).toBeTruthy();
    // The password is still a way in: the SSO session meets the change step.
    expect(await probe({ cookies: [sso] })).toBe('password_change_required');
    const who = await call('/api/auth/whoami', { cookies: [sso] });
    expect(await who.json()).toMatchObject({ mustChangePassword: true });
    expect(await probe({ bearer: keys[wk] })).toBe('password_change_required');

    // Never checked: its password session is rechecked, its SSO session and
    // its grants (a linked login's) are not.
    expect(await stateOf(lk)).toEqual({ flag: false, checked: null });
    const old = await passwordCookie(lk);
    expect(await probe({ cookies: [old] })).toBe('password_recheck_required');
    expect(await probe({ cookies: [await ssoCookie(lk)] })).toBe('past');
    expect(await probe({ bearer: keys[lk] })).toBe('past');
    expect(await mcp(lk)).not.toBeNull();
    expect(await telegram(lk)).toBeNull();
    const again = await companySignIn('sub-lk', [old]);
    expect(again.status).toBe(302);
    expect(await probe({ cookies: [cookie(again, 'mantle_session')] })).toBe('past');

    // An unlinked login's grants are rechecked, as with no company sign-in.
    expect(await probe({ bearer: keys[un] })).toBe('password_recheck_required');
    expect(await mcp(un)).toBeNull();
    expect(await telegram(un)).toBe('password_hold');
  });

  it('off: a link left in the table counts for nothing, the rule is as before', async () => {
    setMode('off');
    expect(await probe({ bearer: keys[lk] })).toBe('password_recheck_required');
    expect(await mcp(lk)).toBeNull();
    expect(await telegram(lk)).toBe('password_hold');
  });
});
