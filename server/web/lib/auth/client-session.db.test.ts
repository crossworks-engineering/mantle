/**
 * A client login end to end, on a real migrated Postgres, through the real
 * app (createApp). Workspaces W5c removed the admin-issued sign-in links, the
 * client portal and Team admin's client routes: a client login (made here
 * directly) signs in with an emailed code (written here as the worker stores
 * it), and its session reaches the one shell (GET /api/shell, role client).
 * Then every way a client session ends:
 *
 *   - the code is one use;
 *   - password sign-in never opens a client, nor does a bearer minted
 *     without the session epoch (the phone app's device token, which does
 *     open one, is device-tokens.db.test.ts);
 *   - an admin's "End sessions" (PATCH /api/users/:id {signOut:true});
 *   - the client's own "sign out everywhere", and its plain sign-out;
 *   - an admin disabling the login (enabling it again does not revive the
 *     old cookie, nor an emailed code issued before: audit B14);
 *   - deleting the login takes its codes with it;
 *   - the old link route answers 410 for everyone.
 *
 * Probe: GET /api/shell (a client session gets 200; no session is 401).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/auth/client-session.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('a client login, end to end', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('./tokens');
  let content: typeof import('@mantle/content');
  let anchor = '';
  const tag = `csess-${randomUUID().slice(0, 8)}`;
  const admin = randomUUID();
  const made: string[] = [];
  const emailOf = (s: string) => `${tag}-${s}@example.com`;
  let ip = 0;

  const call = (
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
    return Promise.resolve(
      app.request(path, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  };
  const cookieFrom = (res: Response): string | null => {
    const m1 = /mantle_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '');
    return m1 && m1[1] ? `mantle_session=${m1[1]}` : null;
  };
  const asAdmin = () => `mantle_session=${tokens.buildSessionCookie(admin).value}`;
  const probe = (auth: { cookie?: string; bearer?: string }) =>
    call('/api/shell', auth).then((r) => r.status);

  /** A client login, made directly (no admin route makes one since W5c):
   *  role client and a password hash nobody knows. */
  const addClient = async (name: string): Promise<string> => {
    const id = randomUUID();
    await sql`insert into auth.users (id, email, password_hash, role, display_name)
              values (${id}, ${emailOf(name)}, ${bcrypt.hashSync(randomUUID(), 4)}, 'client', ${name})`;
    made.push(id);
    return id;
  };
  /** An open emailed code for the client, written as the worker stores it
   *  (a browser's request id is its cookie's). Not through
   *  createClientEmailCode: its brain-wide daily cap is shared with every
   *  test file on this database. */
  const mailedCode = async (id: string) => {
    const requestId = randomUUID();
    const code = content.generateClientCode();
    await sql`insert into client_signin_codes
                (owner_id, login_id, kind, code_hash, request_id, request_ip, expires_at)
              values (${anchor}, ${id}, 'email', ${content.hashClientCode(requestId, code)},
                      ${requestId}, ${`198.51.100.${(ip += 1) % 250}`}, now() + interval '10 minutes')`;
    return { requestId, code };
  };
  const signIn = (c: { requestId: string; code: string }, email: string) =>
    call('/api/auth/client-code/verify', {
      method: 'POST',
      cookie: `mantle_code_req=${c.requestId}`,
      body: { email, code: c.code },
    });
  const signedIn = async (id: string, name: string): Promise<string> => {
    const res = await signIn(await mailedCode(id), emailOf(name));
    expect(res.status).toBe(200);
    return cookieFrom(res)!;
  };
  const openSignins = async (id: string) =>
    Number(
      (
        await sql<Row[]>`select count(*)::int as n from client_signin_codes
                         where login_id = ${id} and used_at is null and revoked_at is null`
      )[0]!.n,
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'client-session-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./tokens');
    content = await import('@mantle/content');
    // The client resolves against the brain's anchor: the shared test
    // anchor (made once, by whichever file asks first, never deleted).
    anchor = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role)
              values (${admin}, ${emailOf('admin')}, ${bcrypt.hashSync('an admin pass', 4)}, 'admin')`;
    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    const all = [...made, admin];
    await sql`delete from audit_log where actor_email like ${`${tag}%`}`;
    await sql`delete from mobile_tokens where user_id in ${sql(all)}`;
    await sql`delete from spaces where login_id in ${sql(all)}`;
    await sql`delete from auth.users where id in ${sql(all)}`;
  });

  it('signs in with an emailed code, once, and reaches the one shell as a client', async () => {
    const id = await addClient('ada');
    const mailed = await mailedCode(id);
    expect((await signIn(mailed, emailOf('someone-else'))).status).toBe(401);
    const res = await signIn(mailed, emailOf('ada').toUpperCase());
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res)!;
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=2592000/);
    // One use: the same code again is refused.
    expect((await signIn(mailed, emailOf('ada'))).status).toBe(401);
    // The one shell answers it as a client (W5c), with no admin part.
    const shell = await call('/api/shell', { cookie });
    expect(shell.status).toBe(200);
    expect(await shell.json()).toMatchObject({
      role: 'client',
      loginId: id,
      email: emailOf('ada'),
      areas: [],
      pendingApprovals: 0,
      onboarded: true,
    });
    // The old portal answers 410; admin and member routes refuse a client.
    expect((await call('/api/client/shared', { cookie })).status).toBe(410);
    const admin = await call('/api/push/subscriptions', { cookie });
    expect(admin.status).toBe(403);
    expect(((await admin.json()) as { reason?: string }).reason).toBe('client-login');
  });

  it('the old sign-in link route answers 410 for everyone', async () => {
    const res = await call('/api/auth/client-link', {
      method: 'POST',
      body: { code: 'x'.repeat(16), email: emailOf('ada') },
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'gone' });
  });

  it('never opens a client with a password, or a bearer without the session epoch', async () => {
    const id = await addClient('bea');
    const login = await call('/api/auth/login', {
      method: 'POST',
      body: { email: emailOf('bea'), password: 'any password at all' },
    });
    expect(login.status).toBe(401);
    // Even with a password the login does know (set by hand here), password
    // sign-in is for admins and members only.
    await sql`update auth.users set password_hash = ${bcrypt.hashSync('known pass 1', 4)}
              where id = ${id}`;
    const known = await call('/api/auth/login', {
      method: 'POST',
      body: { email: emailOf('bea'), password: 'known pass 1' },
    });
    expect(known.status).toBe(401);
    expect(known.headers.get('set-cookie') ?? '').not.toMatch(/mantle_session=[^;]/);
    // A bearer as the password logins mint it (no epoch): only the emailed
    // code in device mode mints a client's token, and that one carries it.
    const jti = randomUUID();
    const t = tokens.buildMobileToken(id, jti, 3600);
    await sql`insert into mobile_tokens (id, user_id, label, expires_at)
              values (${jti}, ${id}, ${tag}, ${t.expiresAt.toISOString()})`;
    expect(await probe({ bearer: t.value })).toBe(401);
    expect((await call('/api/client/shell', { bearer: t.value })).status).toBe(401);
    expect(await openSignins(id)).toBe(0);
  });

  it("an admin's End sessions stops the client's next request", async () => {
    const id = await addClient('cy');
    const cookie = await signedIn(id, 'cy');
    expect(await probe({ cookie })).toBe(200);
    const res = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { signOut: true },
    });
    expect(res.status).toBe(200);
    expect(await probe({ cookie })).toBe(401);
    // A new code signs the client in again.
    expect(await probe({ cookie: await signedIn(id, 'cy') })).toBe(200);
  });

  it('the client can sign itself out everywhere', async () => {
    const id = await addClient('di');
    const here = await signedIn(id, 'di');
    const there = await signedIn(id, 'di');
    const res = await call('/api/auth/logout', {
      method: 'POST',
      cookie: here,
      body: { everywhere: true },
    });
    expect(res.status).toBe(200);
    expect(await probe({ cookie: there })).toBe(401);
  });

  it("a client's plain sign-out ends its other sessions (audit B23)", async () => {
    const id = await addClient('jo');
    const here = await signedIn(id, 'jo');
    const there = await signedIn(id, 'jo');
    expect(await probe({ cookie: there })).toBe(200);
    const res = await call('/api/auth/logout', { method: 'POST', cookie: here });
    expect(res.status).toBe(200);
    expect(await probe({ cookie: there })).toBe(401);
  });

  it('disable ends the session and its open code; enable does not revive them', async () => {
    const id = await addClient('ed');
    const cookie = await signedIn(id, 'ed');
    const mailed = await mailedCode(id);
    const off = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { disabled: true },
    });
    expect(off.status).toBe(200);
    expect(await probe({ cookie })).toBe(401);
    expect(await openSignins(id)).toBe(0);
    expect((await signIn(mailed, emailOf('ed'))).status).toBe(401);
    const on = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { disabled: false },
    });
    expect(on.status).toBe(200);
    expect(await probe({ cookie })).toBe(401);
    // A code issued after the enable works (audit B14).
    expect(await probe({ cookie: await signedIn(id, 'ed') })).toBe(200);
  });

  it('End sessions revokes the open emailed code too', async () => {
    const id = await addClient('ivy');
    const mailed = await mailedCode(id);
    const res = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { signOut: true },
    });
    expect(res.status).toBe(200);
    expect(await openSignins(id)).toBe(0);
    expect((await signIn(mailed, emailOf('ivy'))).status).toBe(401);
  });

  it('refuses a role change to or from client', async () => {
    const id = await addClient('fay');
    const res = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { role: 'member' },
    });
    expect(res.status).toBe(400);
    const [u] = await sql<Row[]>`select role from auth.users where id = ${id}`;
    expect(u!.role).toBe('client');
  });

  it('deleting the client removes its codes and ends the session', async () => {
    const id = await addClient('gus');
    const cookie = await signedIn(id, 'gus');
    await mailedCode(id);
    const res = await call(`/api/users/${id}`, { method: 'DELETE', cookie: asAdmin() });
    expect(res.status).toBe(200);
    made.splice(made.indexOf(id), 1);
    expect(await probe({ cookie })).toBe(401);
    const left = await sql<Row[]>`select 1 from client_signin_codes where login_id = ${id}`;
    expect(left).toHaveLength(0);
  });
});
