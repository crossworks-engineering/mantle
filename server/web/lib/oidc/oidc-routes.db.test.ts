/**
 * Company sign-in through the real app (createApp: the gate, the route
 * policies, the rate limits) on a real migrated Postgres, with the
 * provider stood in (the provider round trip itself is
 * scripts/oidc-flow-check.ts against a local OIDC provider):
 *
 *  - off: the config read says off, a password sign-in sets the one
 *    session cookie it always did, the company sign-in tables stay empty;
 *  - optional: a password sign-in carries the ticket; the login links in
 *    one click (the row, keyed on issuer and subject); company sign-in
 *    then signs it in with a 12-hour session that passes the gate;
 *  - required: the linked login's password is refused, an unlinked one is
 *    held (no session) and links on its held ticket, then is signed in;
 *    the original account and an outside login keep their passwords;
 *  - the users area: the counts, the outside mark, an admin's unlink.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/oidc/oidc-routes.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
      tid: 'tenant-1',
      oid: null,
    };
  },
}));

const URL = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;

describe.skipIf(!URL)('company sign-in through the app', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  const tag = `oidc-${randomUUID().slice(0, 8)}`;
  const linked = randomUUID();
  const held = randomUUID();
  const outside = randomUUID();
  const admin = randomUUID();
  const PASSWORD = 'first password 1';
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let ip = 0;
  /** The held login's company sign-in session (the required test). */
  let heldSession: string | null = null;

  const call = (
    path: string,
    init: { method?: string; cookies?: (string | null)[]; body?: unknown } = {},
  ) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${ip % 250}`,
      'x-forwarded-proto': 'https',
    };
    const jar = (init.cookies ?? []).filter((c): c is string => !!c);
    if (jar.length) headers.cookie = jar.join('; ');
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
  const passwordSignIn = (id: string) =>
    call('/api/auth/login', { method: 'POST', body: { email: emailOf(id), password: PASSWORD } });
  const memberProbe = (session: string | null) =>
    call('/api/member/push/preferences', { cookies: [session] }).then((r) =>
      r.status === 401 || r.status === 403 ? r.status : 'past',
    );
  const stateOf = (location: string) => new globalThis.URL(location).searchParams.get('state')!;
  const links = async () =>
    (await sql<Row[]>`select login_id, issuer, subject, tid from oidc_signin_links
                      where login_id in (${linked}, ${held}, ${outside}, ${admin})
                      order by created_at`) as Row[];
  const setMode = (mode: string) => {
    process.env.MANTLE_OIDC_MODE = mode;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'oidc-routes-db-test-secret-at-least-32-chars';
    process.env.MANTLE_PUBLIC_URL = 'https://brain.example.invalid';
    process.env.MANTLE_OIDC_ISSUER = ISSUER;
    process.env.MANTLE_OIDC_CLIENT_ID = 'mantle';
    process.env.MANTLE_OIDC_LABEL = 'Company';
    delete process.env.MANTLE_OIDC_SESSION_HOURS;
    delete process.env.MANTLE_DETACHED_DEV;
    setMode('off');
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    await ensureTestAnchor(sql);
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await asSuperuser()`insert into auth.users (id, email, password_hash, role) values
      (${linked}, ${emailOf(linked)}, ${hash}, 'member'),
      (${held}, ${emailOf(held)}, ${hash}, 'member'),
      (${outside}, ${emailOf(outside)}, ${hash}, 'member'),
      (${admin}, ${emailOf(admin)}, ${hash}, 'admin')`;
    await runWorkspacesSwitch(scratch.url);
    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 120_000);

  afterEach(() => setMode('off'));

  afterAll(async () => {
    for (const k of [
      'MANTLE_OIDC_OUTSIDE',
      'MANTLE_OIDC_MODE',
      'MANTLE_OIDC_ISSUER',
      'MANTLE_OIDC_CLIENT_ID',
      'MANTLE_OIDC_LABEL',
      'MANTLE_PUBLIC_URL',
    ]) {
      delete process.env[k];
    }
    await m?.closeDb();
    await scratch?.drop();
  });

  it('off: the sign-in screen reads off, a password sign-in is as before, nothing is written', async () => {
    const config = await call('/api/auth/oidc/config');
    expect(await config.json()).toEqual({ mode: 'off' });
    expect((await call('/api/auth/oidc/start')).status).toBe(404);
    const res = await passwordSignIn(linked);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toHaveLength(1);
    expect(res.headers.getSetCookie()[0]).toMatch(/^mantle_session=.*Max-Age=31536000/i);
    expect(await memberProbe(cookie(res, 'mantle_session'))).toBe('past');
    const [n] = await sql<Row[]>`select
      (select count(*) from oidc_signin_links)::int + (select count(*) from oidc_login_state)::int as n`;
    expect(n!.n).toBe(0);
  });

  it('optional: link in one click after a password sign-in, then sign in with a 12-hour session', async () => {
    setMode('optional');
    const signIn = await passwordSignIn(linked);
    expect(signIn.status).toBe(200);
    const session = cookie(signIn, 'mantle_session');
    const ticket = cookie(signIn, '__Host-mantle_oidc_ticket');
    expect(ticket).toBeTruthy();
    const status = await call('/api/auth/oidc/status', { cookies: [session] });
    expect(await status.json()).toMatchObject({ mode: 'optional', linked: false, offer: true });

    const start = await call('/api/auth/oidc/link', {
      method: 'POST',
      cookies: [session, ticket],
      body: { returnTo: '/settings/profile' },
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const flow = cookie(start, '__Host-mantle_oidc_flow');
    h.subject = 'sub-linked';
    const back = await call(`/api/auth/oidc/callback?code=c&state=${stateOf(url)}`, {
      cookies: [session, flow],
    });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe(
      'https://brain.example.invalid/settings/profile?oidc=linked#',
    );
    expect(await links()).toEqual([
      { login_id: linked, issuer: ISSUER, subject: 'sub-linked', tid: 'tenant-1' },
    ]);

    // Company sign-in now signs the login in.
    const go = await call('/api/auth/oidc/start?return=/');
    const flow2 = cookie(go, '__Host-mantle_oidc_flow');
    const done = await call(
      `/api/auth/oidc/callback?code=c&state=${stateOf(go.headers.get('location')!)}`,
      { cookies: [flow2] },
    );
    expect(done.status).toBe(302);
    const sso = done.headers.getSetCookie().find((c) => c.startsWith('mantle_session='))!;
    expect(sso).toMatch(/Max-Age=43200/);
    expect(await memberProbe(cookie(done, 'mantle_session'))).toBe('past');
    // Optional: the password still works too.
    expect((await passwordSignIn(linked)).status).toBe(200);
  });

  it('an account linked to nobody signs nobody in and makes no login', async () => {
    setMode('optional');
    const before = (await sql<Row[]>`select count(*)::int as n from auth.users`)[0]!.n;
    h.subject = 'sub-stranger';
    const go = await call('/api/auth/oidc/start');
    const done = await call(
      `/api/auth/oidc/callback?code=c&state=${stateOf(go.headers.get('location')!)}`,
      { cookies: [cookie(go, '__Host-mantle_oidc_flow')] },
    );
    expect(done.headers.get('location')).toBe(
      'https://brain.example.invalid/login?oidc=not-linked#',
    );
    expect(cookie(done, 'mantle_session')).toBeNull();
    expect((await sql<Row[]>`select count(*)::int as n from auth.users`)[0]!.n).toBe(before);
  });

  it('required: a linked password is refused, an unlinked login is held, links, and is signed in', async () => {
    // A password session from before the switch is held on the server: no
    // session for a login that must use company sign-in now.
    setMode('optional');
    const before = cookie(await passwordSignIn(linked), 'mantle_session');
    expect(await memberProbe(before)).toBe('past');
    setMode('required');
    const { forgetHolds } = await import('./hold');
    forgetHolds();
    expect(await memberProbe(before)).toBe(401);
    const refused = await passwordSignIn(linked);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'sso-required' });
    expect(cookie(refused, 'mantle_session')).toBeNull();
    const token = await call('/api/auth/device-login', {
      method: 'POST',
      body: { email: emailOf(linked), password: PASSWORD },
    });
    expect(token.status).toBe(403);

    const hold = await passwordSignIn(held);
    expect(hold.status).toBe(403);
    expect(await hold.json()).toMatchObject({ code: 'sso-link-required' });
    expect(cookie(hold, 'mantle_session')).toBeNull();
    const ticket = cookie(hold, '__Host-mantle_oidc_ticket');
    expect(ticket).toBeTruthy();

    const start = await call('/api/auth/oidc/link', {
      method: 'POST',
      cookies: [ticket],
      body: {},
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    h.subject = 'sub-held';
    const back = await call(`/api/auth/oidc/callback?code=c&state=${stateOf(url)}`, {
      cookies: [cookie(start, '__Host-mantle_oidc_flow')],
    });
    expect(back.headers.get('location')).toBe('https://brain.example.invalid/?oidc=linked#');
    heldSession = cookie(back, 'mantle_session');
    expect(await memberProbe(heldSession)).toBe('past');
    expect((await links()).map((l) => l.login_id)).toEqual([linked, held]);
    // Now linked: its password is refused too.
    expect((await passwordSignIn(held)).status).toBe(403);
  });

  it('the users area: counts, the outside mark (keeps a password in required mode), an unlink', async () => {
    setMode('optional');
    const adminSession = cookie(await passwordSignIn(admin), 'mantle_session');
    const summary = await call('/api/users/oidc', { cookies: [adminSession] });
    expect(summary.status).toBe(200);
    const body = (await summary.json()) as { counts: Record<string, number> };
    expect(body.counts.linked).toBe(2);

    // Refused while the operator has turned outside logins off.
    process.env.MANTLE_OIDC_OUTSIDE = 'off';
    const refusedMark = await call(`/api/users/${outside}/oidc`, {
      method: 'PATCH',
      cookies: [adminSession],
      body: { outside: true },
    });
    expect(refusedMark.status).toBe(409);
    process.env.MANTLE_OIDC_OUTSIDE = 'on';
    const mark = await call(`/api/users/${outside}/oidc`, {
      method: 'PATCH',
      cookies: [adminSession],
      body: { outside: true },
    });
    expect(mark.status).toBe(200);
    setMode('required');
    expect((await passwordSignIn(outside)).status).toBe(200);
    // A member may not use the users area.
    setMode('optional');
    const memberSession = cookie(await passwordSignIn(outside), 'mantle_session');
    expect(
      (await call('/api/users/oidc', { cookies: [memberSession] })).status,
    ).toBeGreaterThanOrEqual(401);
    const unlink = await call(`/api/users/${held}/oidc`, {
      method: 'DELETE',
      cookies: [adminSession],
    });
    expect(await unlink.json()).toEqual({ ok: true, unlinked: true });
    expect((await links()).map((l) => l.login_id)).toEqual([linked]);
    // The unlinked login's sessions ended with it (one its link made among
    // them): the held login's company sign-in session no longer passes.
    expect(await memberProbe(heldSession)).toBe(401);
  });

  it('sign out everywhere and a password change keep the link; only an unlink removes it', async () => {
    setMode('optional');
    const session = cookie(await passwordSignIn(linked), 'mantle_session');
    expect((await links()).map((l) => l.login_id)).toEqual([linked]);
    const out = await call('/api/auth/logout', {
      method: 'POST',
      cookies: [session],
      body: { everywhere: true },
    });
    expect(out.status).toBe(200);
    // The company sign-in cookies are cleared too while it is on.
    expect(
      out.headers.getSetCookie().some((c) => c.startsWith('__Host-mantle_oidc_ticket=;')),
    ).toBe(true);
    expect((await links()).map((l) => l.login_id)).toEqual([linked]);
    const again = cookie(await passwordSignIn(linked), 'mantle_session');
    const NEXT = 'second password for the oidc test 2';
    const changed = await call('/api/auth/change-password', {
      method: 'POST',
      cookies: [again],
      body: { oldPassword: PASSWORD, newPassword: NEXT },
    });
    expect(changed.status).toBe(200);
    expect((await links()).map((l) => l.login_id)).toEqual([linked]);
    // Required: still linked, so the new password is refused too (no fall
    // back to "password, then link any account").
    setMode('required');
    const refused = await call('/api/auth/login', {
      method: 'POST',
      body: { email: emailOf(linked), password: NEXT },
    });
    expect(await refused.json()).toMatchObject({ code: 'sso-required' });
  });
});
