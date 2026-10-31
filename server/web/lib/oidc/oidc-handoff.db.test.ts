/**
 * A company sign-in handed to a client, through the real app on a real
 * migrated Postgres, with the provider stood in (docs/oidc-sign-in.md):
 *
 *  - a sign-in: the code goes to the client's target, buys one short bearer
 *    that passes the gate, and works once;
 *  - a wrong verifier burns the code;
 *  - the bearer never rotates, its cookie keeps its end and its mark, it
 *    cannot pair, and an unlink ends it;
 *  - a link: made only when the client that started it spends the code, on a
 *    bearer session and from a token login's held ticket;
 *  - a fresh sign-in: the same account or nothing, one code for one key;
 *  - required mode: a typed password does not make a key for a linked login;
 *  - the MCP consent page confirms with a fresh sign-in.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/oidc/oidc-handoff.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
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
  authorizationUrl: async (_s: unknown, f: { state: string }, o?: { link?: boolean }) =>
    `${'https://idp.example.invalid/realms/company'}/auth?state=${f.state}&fresh=${o?.link ? 1 : 0}`,
  identityFromCallback: async (_s: unknown, q: URLSearchParams, f: { state: string }) => {
    if (q.get('state') !== f.state) throw new Error('state mismatch');
    return {
      issuer: 'https://idp.example.invalid/realms/company',
      subject: h.subject,
      tid: null,
      oid: null,
      display: 'a person',
    };
  },
}));

const URL_ = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;

const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const TARGET = 'mantle://oidc';
const AS_CLIENT = `redirect=${encodeURIComponent(TARGET)}&challenge=${CHALLENGE}`;

describe.skipIf(!URL_)('company sign-in handed to a client', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  const tag = `hand-${randomUUID().slice(0, 8)}`;
  const person = randomUUID();
  const heldOne = randomUUID();
  const other = randomUUID();
  const PASSWORD = 'first password 1';
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let ip = 0;

  const call = (
    path: string,
    init: { method?: string; cookies?: (string | null)[]; body?: unknown; bearer?: string } = {},
  ) => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${ip % 250}`,
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
  const FLOW = '__Host-mantle_oidc_flow';
  const stateOf = (location: string) => new URL(location).searchParams.get('state')!;
  /** Run the browser half of a flow from its start URL; the final Location. */
  const browser = async (start: string): Promise<string> => {
    const go = await call(start);
    expect(go.status).toBe(302);
    const flow = cookie(go, FLOW);
    const back = await call(
      `/api/auth/oidc/callback?code=c&state=${stateOf(go.headers.get('location')!)}`,
      { cookies: [flow] },
    );
    expect(back.status).toBe(302);
    return back.headers.get('location')!;
  };
  const fragment = (location: string) => new URLSearchParams(location.split('#')[1]);
  const exchange = (code: string, verifier = VERIFIER) =>
    call('/api/auth/oidc/exchange', { method: 'POST', body: { code, verifier } });
  const pathOf = (url: string) => {
    const u = new URL(url);
    return u.pathname + u.search;
  };
  const setMode = (mode: string) => {
    process.env.MANTLE_OIDC_MODE = mode;
  };
  /** A link for `id` written straight in, to set a test up. */
  const linkDirect = (id: string, subject: string) =>
    asSuperuser()`insert into oidc_signin_links (login_id, issuer, subject)
                  values (${id}, ${ISSUER}, ${subject})`;
  const unlinkDirect = (id: string) =>
    asSuperuser()`delete from oidc_signin_links where login_id = ${id}`;
  const signInBearer = async (subject: string) => {
    h.subject = subject;
    const done = await browser(`/api/auth/oidc/start?${AS_CLIENT}`);
    const res = await exchange(fragment(done).get('code')!);
    expect(res.status).toBe(200);
    return (await res.json()) as { token: string; expiresAt: string; deviceId: string };
  };
  const memberProbe = (bearer: string) =>
    call('/api/member/push/preferences', { bearer }).then((r) =>
      r.status === 401 || r.status === 403 ? r.status : 'past',
    );
  const KEY = { name: 'k', access: 'read', areas: null, expiresInDays: 30 };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL_!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'oidc-handoff-db-test-secret-at-least-32-chars';
    process.env.MANTLE_PUBLIC_URL = 'https://brain.example.invalid';
    process.env.MANTLE_OIDC_ISSUER = ISSUER;
    process.env.MANTLE_OIDC_CLIENT_ID = 'mantle';
    process.env.MANTLE_OIDC_LABEL = 'Company';
    delete process.env.MANTLE_OIDC_SESSION_HOURS;
    delete process.env.MANTLE_DETACHED_DEV;
    setMode('optional');
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    await ensureTestAnchor(sql);
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await asSuperuser()`insert into auth.users (id, email, password_hash, role) values
      (${person}, ${emailOf(person)}, ${hash}, 'member'),
      (${heldOne}, ${emailOf(heldOne)}, ${hash}, 'member'),
      (${other}, ${emailOf(other)}, ${hash}, 'member')`;
    await runWorkspacesSwitch(scratch.url);
    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 120_000);

  afterEach(async () => {
    setMode('optional');
    await asSuperuser()`delete from oidc_signin_links`;
    const { forgetHolds } = await import('./hold');
    forgetHolds();
  });

  afterAll(async () => {
    for (const k of [
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

  it('a sign-in: one code, one short bearer that passes the gate', async () => {
    await linkDirect(person, 'sub-p');
    h.subject = 'sub-p';
    const done = await browser(`/api/auth/oidc/start?${AS_CLIENT}`);
    expect(done.startsWith(`${TARGET}#oidc=code&code=`)).toBe(true);
    expect(fragment(done).get('purpose')).toBe('signin');
    const code = fragment(done).get('code')!;
    // Only the hash is kept.
    const rows = await asSuperuser()<Row>`select code_hash from oidc_handoff_codes`;
    expect(JSON.stringify(rows)).not.toContain(code);

    const res = await exchange(code);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      expiresIn: number;
      deviceId: string;
      sso: boolean;
      loginId: string;
    };
    expect(body).toMatchObject({ sso: true, loginId: person, expiresIn: 43200 });
    expect(await memberProbe(body.token)).toBe('past');
    // A code works once.
    expect((await exchange(code)).status).toBe(401);
    const [row] = await asSuperuser()<Row>`select label from mobile_tokens
                                            where id = ${body.deviceId}`;
    expect(row!.label).toBe('Company sign-in');
  });

  it('a wrong verifier burns the code', async () => {
    await linkDirect(person, 'sub-p');
    h.subject = 'sub-p';
    const done = await browser(`/api/auth/oidc/start?${AS_CLIENT}`);
    const code = fragment(done).get('code')!;
    expect((await exchange(code, 'w'.repeat(43))).status).toBe(401);
    expect((await exchange(code)).status).toBe(401);
  });

  it('a target the brain does not trust is never redirected to', async () => {
    const res = await call(
      `/api/auth/oidc/start?redirect=${encodeURIComponent('https://evil.example.invalid/')}&challenge=${CHALLENGE}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('brain.example.invalid/login?oidc=failed');
  });

  it('an account linked to nobody gets no code, and the client hears why', async () => {
    h.subject = 'sub-nobody';
    const done = await browser(`/api/auth/oidc/start?${AS_CLIENT}`);
    expect(done).toBe(`${TARGET}#oidc=not-linked`);
  });

  it('the bearer never rotates: refresh answers it with itself', async () => {
    await linkDirect(person, 'sub-p');
    const { token, expiresAt } = await signInBearer('sub-p');
    const res = await call('/api/auth/token/refresh', { method: 'POST', bearer: token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(body.token).toBe(token);
    expect(body.expiresAt).toBe(expiresAt);
  });

  it('its cookie keeps its end and its mark', async () => {
    await linkDirect(person, 'sub-p');
    const { token } = await signInBearer('sub-p');
    const res = await call('/api/auth/sso', { method: 'POST', bearer: token });
    expect(res.status).toBe(204);
    const set = res.headers.getSetCookie().find((c) => c.startsWith('mantle_session='))!;
    const age = Number(/Max-Age=(\d+)/i.exec(set)![1]);
    expect(age).toBeLessThanOrEqual(43200);
    const { verifySessionCookie } = await import('@/lib/auth/tokens');
    const value = /^mantle_session=([^;]+)/.exec(set)![1]!;
    expect(verifySessionCookie(decodeURIComponent(value))?.oidc).toBe(true);
  });

  it('it cannot pair a phone or a chat: those would outlive it', async () => {
    await linkDirect(person, 'sub-p');
    const { token } = await signInBearer('sub-p');
    const pair = await call('/api/auth/pair', { method: 'POST', bearer: token });
    expect(pair.status).toBe(403);
    expect(await pair.json()).toMatchObject({ code: 'sso-session' });
  });

  it('an unlink ends it, and off ends it', async () => {
    await linkDirect(person, 'sub-p');
    const a = await signInBearer('sub-p');
    expect(await memberProbe(a.token)).toBe('past');
    await unlinkDirect(person);
    const { forgetHolds } = await import('./hold');
    forgetHolds();
    expect(await memberProbe(a.token)).toBe(401);
    await linkDirect(person, 'sub-p');
    forgetHolds();
    const b = await signInBearer('sub-p');
    setMode('off');
    expect(await memberProbe(b.token)).toBe(401);
  });

  it('a link on a bearer session: made only when the code is spent', async () => {
    const signIn = await call('/api/auth/token', {
      method: 'POST',
      body: { email: emailOf(person), password: PASSWORD },
    });
    expect(signIn.status).toBe(200);
    const { token, oidcTicket } = (await signIn.json()) as { token: string; oidcTicket: string };
    expect(oidcTicket).toBeTruthy();
    const start = await call('/api/auth/oidc/link', {
      method: 'POST',
      bearer: token,
      body: { handoff: { redirect: TARGET, challenge: CHALLENGE }, ticket: oidcTicket },
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    h.subject = 'sub-link';
    const done = await browser(pathOf(url));
    expect(fragment(done).get('purpose')).toBe('link');
    // Nothing yet: a start URL mailed to someone links nothing.
    const none = await asSuperuser()<Row>`select 1 from oidc_signin_links`;
    expect(none).toHaveLength(0);
    // The wrong verifier links nothing, and burns the code.
    const code = fragment(done).get('code')!;
    expect((await exchange(code, 'w'.repeat(43))).status).toBe(401);
    expect(await asSuperuser()<Row>`select 1 from oidc_signin_links`).toHaveLength(0);
  });

  it('a link made: the client spends the code', async () => {
    const signIn = await call('/api/auth/token', {
      method: 'POST',
      body: { email: emailOf(person), password: PASSWORD },
    });
    const { token, oidcTicket } = (await signIn.json()) as { token: string; oidcTicket: string };
    const start = await call('/api/auth/oidc/link', {
      method: 'POST',
      bearer: token,
      body: { handoff: { redirect: TARGET, challenge: CHALLENGE }, ticket: oidcTicket },
    });
    const { url } = (await start.json()) as { url: string };
    h.subject = 'sub-link';
    const done = await browser(pathOf(url));
    const res = await exchange(fragment(done).get('code')!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: true });
    const rows = await asSuperuser()<Row>`select login_id, subject from oidc_signin_links`;
    expect(rows).toEqual([{ login_id: person, subject: 'sub-link' }]);
  });

  it('a bearer session with no ticket must type its password', async () => {
    const signIn = await call('/api/auth/token', {
      method: 'POST',
      body: { email: emailOf(person), password: PASSWORD },
    });
    const { token } = (await signIn.json()) as { token: string };
    const res = await call('/api/auth/oidc/link', {
      method: 'POST',
      bearer: token,
      body: { handoff: { redirect: TARGET, challenge: CHALLENGE } },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'password-needed' });
  });

  it('required: a token login answers a held ticket, and the link signs it in', async () => {
    setMode('required');
    const signIn = await call('/api/auth/token', {
      method: 'POST',
      body: { email: emailOf(heldOne), password: PASSWORD },
    });
    expect(signIn.status).toBe(403);
    const { code, ticket } = (await signIn.json()) as { code: string; ticket: string };
    expect(code).toBe('sso-link-required');
    expect(signIn.headers.getSetCookie()).toEqual([]);
    const start = await call('/api/auth/oidc/link', {
      method: 'POST',
      body: { handoff: { redirect: TARGET, challenge: CHALLENGE }, ticket },
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    h.subject = 'sub-held';
    const done = await browser(pathOf(url));
    const res = await exchange(fragment(done).get('code')!);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; linked: boolean; sso: boolean };
    expect(body).toMatchObject({ linked: true, sso: true });
    expect(await memberProbe(body.token)).toBe('past');
  });

  it('a fresh sign-in: the linked account or nothing, one code for one key', async () => {
    await linkDirect(person, 'sub-p');
    const { token } = await signInBearer('sub-p');
    const list = await call('/api/access-keys', { bearer: token });
    expect(await list.json()).toMatchObject({
      needsPassword: false,
      stepUp: { kind: 'company', label: 'Company' },
    });
    const startFresh = async () => {
      const res = await call('/api/auth/oidc/fresh', {
        method: 'POST',
        bearer: token,
        body: { redirect: TARGET, challenge: CHALLENGE },
      });
      expect(res.status).toBe(200);
      return pathOf(((await res.json()) as { url: string }).url);
    };

    // The provider asks again, and another account gets nothing.
    h.subject = 'sub-someone-else';
    expect(await browser(await startFresh())).toBe(`${TARGET}#oidc=wrong-account`);

    h.subject = 'sub-p';
    const done = await browser(await startFresh());
    expect(fragment(done).get('purpose')).toBe('fresh');
    const fresh = { code: fragment(done).get('code')!, verifier: VERIFIER };
    // A fresh code buys no bearer.
    expect((await exchange(fresh.code)).status).toBe(401);
    // That spend failed on the purpose, so the code still works.
    const made = await call('/api/access-keys', {
      method: 'POST',
      bearer: token,
      body: { ...KEY, fresh },
    });
    expect(made.status).toBe(201);
    // One code, one key.
    const again = await call('/api/access-keys', {
      method: 'POST',
      bearer: token,
      body: { ...KEY, name: 'k2', fresh },
    });
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject({ reason: 'fresh-sign-in' });
  });

  it('a fresh code is good only for the login that asked', async () => {
    await linkDirect(person, 'sub-p');
    await linkDirect(other, 'sub-o');
    const mine = await signInBearer('sub-p');
    const theirs = await signInBearer('sub-o');
    const res = await call('/api/auth/oidc/fresh', {
      method: 'POST',
      bearer: mine.token,
      body: { redirect: TARGET, challenge: CHALLENGE },
    });
    h.subject = 'sub-p';
    const done = await browser(pathOf(((await res.json()) as { url: string }).url));
    const made = await call('/api/access-keys', {
      method: 'POST',
      bearer: theirs.token,
      body: { ...KEY, fresh: { code: fragment(done).get('code')!, verifier: VERIFIER } },
    });
    expect(made.status).toBe(403);
  });

  it('required: a typed password does not make a key for a linked login', async () => {
    await linkDirect(person, 'sub-p');
    const { token } = await signInBearer('sub-p');
    setMode('required');
    const made = await call('/api/access-keys', {
      method: 'POST',
      bearer: token,
      body: { ...KEY, password: PASSWORD },
    });
    expect(made.status).toBe(403);
    expect(await made.json()).toMatchObject({ reason: 'fresh-sign-in' });
  });

  it('optional: a linked login may still type its password (an older app)', async () => {
    await linkDirect(person, 'sub-p');
    const { token } = await signInBearer('sub-p');
    const made = await call('/api/access-keys', {
      method: 'POST',
      bearer: token,
      body: { ...KEY, password: PASSWORD },
    });
    expect(made.status).toBe(201);
  });

  it('off: nothing here is open', async () => {
    setMode('off');
    for (const [path, method] of [
      ['/api/auth/oidc/exchange', 'POST'],
      ['/api/auth/oidc/fresh', 'POST'],
      [`/api/auth/oidc/start?${AS_CLIENT}`, 'GET'],
    ] as const) {
      expect((await call(path, { method, body: method === 'POST' ? {} : undefined })).status).toBe(
        404,
      );
    }
    const signIn = await call('/api/auth/token', {
      method: 'POST',
      body: { email: emailOf(person), password: PASSWORD },
    });
    const body = (await signIn.json()) as { token: string; oidcTicket?: string };
    expect(body.oidcTicket).toBeUndefined();
    const list = await call('/api/access-keys', { bearer: body.token });
    const keys = (await list.json()) as { needsPassword: boolean; stepUp?: unknown };
    expect(keys.needsPassword).toBe(true);
    expect(keys.stepUp).toBeUndefined();
  });
});
