/**
 * SCIM's auto-link through the real app (createApp: the gate, the routes)
 * on a real migrated Postgres, the provider stood in (docs/scim.md,
 * "Signing in the first time"): a company sign-in with no link signs in the
 * login SCIM made for the same person, matched by the provider's object id
 * (`oid`) in the issuer's own tenant (`tid`), never by an email.
 *
 *  - on: the match links and signs in, with an audit row; the next sign-in
 *    uses the link;
 *  - never: an email, a login SCIM only matched (made by hand), a disabled
 *    login, an Admin user, a login already linked to another account
 *    (refused, not relinked), another tenant, an object id two logins share;
 *  - off: with MANTLE_SCIM_AUTO_LINK off, with SCIM off, with company
 *    sign-in off.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/scim/scim-oid-link.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureAdminUsers,
  ensureTestAnchor,
  runWorkspacesSwitch,
  superuserClient,
} from '@mantle/db/test-support';

const TENANT = '7d8b2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const h = vi.hoisted(() => ({
  subject: 'sub-x',
  tid: null as string | null,
  oid: null as string | null,
  display: null as string | null,
}));

vi.mock('../oidc/provider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authorizationUrl: async (_s: unknown, f: { state: string }) =>
    `https://login.microsoftonline.com/authorize?state=${f.state}`,
  identityFromCallback: async (_s: unknown, q: URLSearchParams, f: { state: string }) => {
    if (q.get('state') !== f.state) throw new Error('state mismatch');
    return {
      issuer: `https://login.microsoftonline.com/${'7d8b2c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'}/v2.0`,
      subject: h.subject,
      tid: h.tid,
      oid: h.oid,
      display: h.display,
    };
  },
}));

const URL = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;

describe.skipIf(!URL)('SCIM auto-link by the provider object id', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let token = '';
  let hash = '';
  const tag = `scimlink-${randomUUID().slice(0, 8)}`;
  const hand = randomUUID(); // a login made by hand, with a password
  const PASSWORD = 'first password 1';
  let ip = 0;

  const call = (
    path: string,
    init: { method?: string; cookies?: (string | null)[]; body?: unknown; scim?: boolean } = {},
  ) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${ip % 250}`,
      'x-forwarded-proto': 'https',
    };
    if (init.scim) headers.authorization = `Bearer ${token}`;
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
  const stateOf = (location: string) => new globalThis.URL(location).searchParams.get('state')!;
  /** One company sign-in as the account `as`; the callback's response. */
  const signIn = async (as: {
    subject: string;
    oid: string | null;
    tid?: string | null;
    display?: string | null;
  }) => {
    h.subject = as.subject;
    h.oid = as.oid;
    h.tid = as.tid === undefined ? TENANT : as.tid;
    h.display = as.display ?? null;
    const go = await call('/api/auth/oidc/start?return=/');
    if (go.status !== 302) return go;
    return call(`/api/auth/oidc/callback?code=c&state=${stateOf(go.headers.get('location')!)}`, {
      cookies: [cookie(go, '__Host-mantle_oidc_flow')],
    });
  };
  const outcome = (res: Response) => {
    const loc = res.headers.get('location') ?? '';
    const code = /[?&]oidc=([a-z-]+)/.exec(loc)?.[1];
    if (code) return code;
    return cookie(res, 'mantle_session') ? 'signed-in' : `status-${res.status}`;
  };
  const linksOf = async (loginId: string) =>
    sql<Row[]>`select subject, oid, tid from oidc_signin_links where login_id = ${loginId}`;
  /** A login SCIM makes, with this object id as its externalId. */
  const scimMade = async (name: string, oid: string, extra: Record<string, unknown> = {}) => {
    const res = await call('/scim/v2/Users', {
      method: 'POST',
      scim: true,
      body: { userName: `${tag}-${name}@example.com`, externalId: oid, ...extra },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const env = (on: { scim?: boolean; link?: boolean; oidc?: boolean }) => {
    process.env.MANTLE_SCIM_TOKEN_HASH = on.scim === false ? '' : hash;
    process.env.MANTLE_SCIM_AUTO_LINK = on.link === false ? 'off' : 'on';
    process.env.MANTLE_OIDC_MODE = on.oidc === false ? 'off' : 'optional';
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'scim-oid-link-db-test-secret-at-least-32-chars';
    process.env.MANTLE_PUBLIC_URL = 'https://brain.example.invalid';
    process.env.MANTLE_OIDC_ISSUER = ISSUER;
    process.env.MANTLE_OIDC_CLIENT_ID = 'mantle';
    delete process.env.MANTLE_OIDC_SESSION_HOURS;
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    // Fixtures on a superuser client of its own (the runtime-role lane).
    sql = superuserClient(scratch.url) as unknown as typeof sql;
    await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${hand}, ${`${tag}-hand@example.com`}, ${bcrypt.hashSync(PASSWORD, 4)}, 'member')`;
    await runWorkspacesSwitch(scratch.url);
    const { newScimToken } = await import('./settings');
    ({ token, hash } = newScimToken());
    env({});
    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    for (const k of [
      'MANTLE_SCIM_TOKEN_HASH',
      'MANTLE_SCIM_AUTO_LINK',
      'MANTLE_OIDC_MODE',
      'MANTLE_OIDC_ISSUER',
      'MANTLE_OIDC_CLIENT_ID',
      'MANTLE_PUBLIC_URL',
    ]) {
      delete process.env[k];
    }
    await (sql as unknown as { end?: () => Promise<void> } | undefined)?.end?.();
    await m?.closeDb();
    await scratch?.drop();
  });

  it('the object id of a login SCIM made links it and signs it in, once', async () => {
    env({});
    const oid = randomUUID();
    const ana = await scimMade('ana', oid.toUpperCase());
    const first = await signIn({ subject: 'sub-ana', oid, display: `${tag}-ana@example.com` });
    expect(outcome(first)).toBe('signed-in');
    expect(await linksOf(ana)).toEqual([{ subject: 'sub-ana', oid, tid: TENANT }]);
    const audit = async () => {
      for (let i = 0; i < 60; i++) {
        const rows = await sql<Row[]>`select actor_id, detail from audit_log
          where action = 'auth.oidc_linked' and actor_id = ${ana}`;
        if (rows.length > 0) return rows;
        await new Promise((r) => setTimeout(r, 50));
      }
      return [];
    };
    const [row] = await audit();
    expect(row!.detail).toMatchObject({ via: 'scim-auto-link', subject: 'sub-ana', oid });
    // The next sign-in uses the link.
    expect(outcome(await signIn({ subject: 'sub-ana', oid }))).toBe('signed-in');
    expect(await linksOf(ana)).toHaveLength(1);
  });

  it('its first sign-in only: after an unlink the account does not link again by itself', async () => {
    env({});
    const oid = randomUUID();
    const eli = await scimMade('eli', oid);
    expect(outcome(await signIn({ subject: 'sub-eli', oid }))).toBe('signed-in');
    // An admin unlinks it (the link is a way in; the unlink closes it).
    await sql`delete from oidc_signin_links where login_id = ${eli}`;
    expect(outcome(await signIn({ subject: 'sub-eli', oid }))).toBe('not-linked');
    expect(await linksOf(eli)).toEqual([]);
  });

  it('a login made with no externalId is never linked, even once the provider sets one', async () => {
    env({});
    const oid = randomUUID();
    const res = await call('/scim/v2/Users', {
      method: 'POST',
      scim: true,
      body: { userName: `${tag}-noext@example.com` },
    });
    const noext = ((await res.json()) as { id: string }).id;
    const set = await call(`/scim/v2/Users/${noext}`, {
      method: 'PATCH',
      scim: true,
      body: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'add', path: 'externalId', value: oid }],
      },
    });
    expect(set.status).toBe(200);
    expect(outcome(await signIn({ subject: 'sub-noext', oid }))).toBe('not-linked');
    expect(await linksOf(noext)).toEqual([]);
  });

  it('a sign-in handed to the desktop app or the phone links the same way', async () => {
    env({});
    const oid = randomUUID();
    const fay = await scimMade('fay', oid);
    h.subject = 'sub-fay';
    h.oid = oid;
    h.tid = TENANT;
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const go = await call(
      `/api/auth/oidc/start?redirect=${encodeURIComponent('mantle://oidc')}&challenge=${challenge}`,
    );
    expect(go.status).toBe(302);
    const back = await call(
      `/api/auth/oidc/callback?code=c&state=${stateOf(go.headers.get('location')!)}`,
      { cookies: [cookie(go, '__Host-mantle_oidc_flow')] },
    );
    expect(back.headers.get('location')).toMatch(/^mantle:\/\/oidc#oidc=code&code=/);
    expect(await linksOf(fay)).toEqual([{ subject: 'sub-fay', oid, tid: TENANT }]);
    // The app never spends the code, so the login was never signed in; an
    // admin sets it a password and removes the link. The account does not
    // link again by itself: a login with a password never auto-links.
    await sql`update auth.users set password_hash = ${bcrypt.hashSync(PASSWORD, 4)}
              where id = ${fay}`;
    await sql`delete from oidc_signin_links where login_id = ${fay}`;
    expect(outcome(await signIn({ subject: 'sub-fay', oid }))).toBe('not-linked');
    expect(await linksOf(fay)).toEqual([]);
  });

  it('never links by email: an account with no SCIM object id signs nobody in', async () => {
    env({});
    const res = await signIn({
      subject: 'sub-hand',
      oid: randomUUID(),
      display: `${tag}-hand@example.com`,
    });
    expect(outcome(res)).toBe('not-linked');
    expect(await linksOf(hand)).toEqual([]);
  });

  it('never links a login SCIM only matched by email (made by hand)', async () => {
    env({});
    const oid = randomUUID();
    const hit = await call(
      `/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${tag}-hand@example.com"`)}`,
      { scim: true },
    );
    expect(((await hit.json()) as { totalResults: number }).totalResults).toBe(1);
    const set = await call(`/scim/v2/Users/${hand}`, {
      method: 'PATCH',
      scim: true,
      body: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'add', path: 'externalId', value: oid }],
      },
    });
    expect(set.status).toBe(200);
    expect(outcome(await signIn({ subject: 'sub-hand2', oid }))).toBe('not-linked');
    expect(await linksOf(hand)).toEqual([]);
  });

  it('never links a disabled login, an Admin user, or an object id two logins share', async () => {
    env({});
    const offOid = randomUUID();
    const off = await scimMade('off', offOid, { active: false });
    expect(outcome(await signIn({ subject: 'sub-off', oid: offOid }))).toBe('not-linked');
    expect(await linksOf(off)).toEqual([]);

    const admOid = randomUUID();
    const adm = await scimMade('adm', admOid);
    await ensureAdminUsers(sql as never, [adm]);
    expect(outcome(await signIn({ subject: 'sub-adm', oid: admOid }))).toBe('not-linked');
    expect(await linksOf(adm)).toEqual([]);

    // Two logins whose object ids differ only in case: neither.
    const twin = randomUUID();
    const t1 = await scimMade('twin1', twin.toLowerCase());
    const t2 = await scimMade('twin2', twin.toUpperCase());
    expect(outcome(await signIn({ subject: 'sub-twin', oid: twin }))).toBe('not-linked');
    expect([...(await linksOf(t1)), ...(await linksOf(t2))]).toEqual([]);
  });

  it('a login already linked to another account is refused, not relinked', async () => {
    env({});
    const oid = randomUUID();
    const bea = await scimMade('bea', oid);
    await sql`insert into oidc_signin_links (login_id, issuer, subject)
              values (${bea}, ${ISSUER}, 'sub-bea-old')`;
    expect(outcome(await signIn({ subject: 'sub-bea-new', oid }))).toBe('has-other');
    expect(await linksOf(bea)).toEqual([{ subject: 'sub-bea-old', oid: null, tid: null }]);
    // The refusal names the login on its audit row.
    let refused: Row[] = [];
    for (let i = 0; i < 60 && refused.length === 0; i++) {
      refused = await sql<Row[]>`select detail from audit_log
        where action = 'auth.login_failed' and actor_id = ${bea}`;
      if (refused.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(refused[0]!.detail).toMatchObject({ reason: 'has-other', subject: 'sub-bea-new' });
  });

  it('another tenant, or no tenant or object id in the token, links nothing', async () => {
    env({});
    const oid = randomUUID();
    const cal = await scimMade('cal', oid);
    for (const as of [
      { subject: 'sub-cal-1', oid, tid: randomUUID() },
      { subject: 'sub-cal-2', oid, tid: null },
      { subject: 'sub-cal-3', oid: null },
      { subject: 'sub-cal-4', oid: 'not-a-guid' },
    ]) {
      expect(outcome(await signIn(as)), as.subject).toBe('not-linked');
    }
    expect(await linksOf(cal)).toEqual([]);
  });

  it('off: with the auto-link off, with SCIM off, with company sign-in off', async () => {
    const oid = randomUUID();
    env({});
    const dee = await scimMade('dee', oid);
    env({ link: false });
    expect(outcome(await signIn({ subject: 'sub-dee', oid }))).toBe('not-linked');
    env({ scim: false });
    expect(outcome(await signIn({ subject: 'sub-dee', oid }))).toBe('not-linked');
    env({ oidc: false });
    expect((await signIn({ subject: 'sub-dee', oid })).status).toBe(404);
    expect(await linksOf(dee)).toEqual([]);
    // On again: it links.
    env({});
    expect(outcome(await signIn({ subject: 'sub-dee', oid }))).toBe('signed-in');
  });
});
