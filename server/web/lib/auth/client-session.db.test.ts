/**
 * A client login end to end (client logins C2), on a real migrated
 * Postgres, through the real app (createApp): an admin acknowledges "What
 * clients see", adds a client and issues a sign-in link; the client signs in
 * with the link and its email and gets past the client gate; then every way
 * a client session ends:
 *
 *   - the link is one use;
 *   - password sign-in and a mobile bearer never open a client;
 *   - an admin's "End sessions" (PATCH /api/users/:id {signOut:true});
 *   - the client's own "sign out everywhere";
 *   - an admin disabling the login (enabling it again does not revive the
 *     old cookie);
 *   - deleting the login takes its links with it.
 *
 * Probe: GET /api/client/shared/not-a-uuid (a client past the gate gets the
 * handler's 400; no client session is 401).
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
    call('/api/client/shared/not-a-uuid', auth).then((r) => r.status);

  /** Acknowledge the report as it is now, then run `act`; again when an
   *  item went to client in between (other test files share the anchor). */
  const acknowledged = async (act: () => Promise<Response>): Promise<Response> => {
    for (let i = 0; ; i += 1) {
      const report = await (await call('/api/access/client-report', { cookie: asAdmin() })).json();
      const itemIds = (report.items as Array<{ id: string }>).map((it) => it.id);
      const ack = await call('/api/access/client-report/ack', {
        method: 'POST',
        cookie: asAdmin(),
        body: { itemIds },
      });
      expect(ack.status).toBe(200);
      const res = await act();
      if (res.status !== 409 || i === 3) return res;
      const body = (await res.clone().json()) as { reason?: string };
      if (body.reason !== 'report-not-acknowledged') return res;
    }
  };
  const addClient = async (name: string): Promise<string> => {
    const res = await acknowledged(() =>
      call('/api/team-admin/clients', {
        method: 'POST',
        cookie: asAdmin(),
        body: { email: emailOf(name), displayName: name },
      }),
    );
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { client: { id: string } }).client.id;
    made.push(id);
    return id;
  };
  const issue = async (id: string): Promise<string> => {
    const res = await acknowledged(() =>
      call(`/api/team-admin/clients/${id}/signin-link`, { method: 'POST', cookie: asAdmin() }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { code: string }).code;
  };
  const signIn = (code: string, email: string) =>
    call('/api/auth/client-link', { method: 'POST', body: { code, email } });
  const signedIn = async (id: string, name: string): Promise<string> => {
    const res = await signIn(await issue(id), emailOf(name));
    expect(res.status).toBe(200);
    return cookieFrom(res)!;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'client-session-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./tokens');
    // The client resolves against the brain's anchor: the shared test
    // anchor (made once, by whichever file asks first, never deleted).
    await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role)
              values (${admin}, ${emailOf('admin')}, ${bcrypt.hashSync('an admin pass', 4)}, 'admin')`;
    const { createApp } = await import('../../server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    const all = [...made, admin];
    await sql`delete from client_report_acks where acked_by = ${admin}`;
    await sql`delete from audit_log where actor_email like ${`${tag}%`}`;
    await sql`delete from mobile_tokens where user_id in ${sql(all)}`;
    await sql`delete from spaces where login_id in ${sql(all)}`;
    await sql`delete from auth.users where id in ${sql(all)}`;
  });

  it('signs in with the link and the email, once', async () => {
    const id = await addClient('ada');
    const [u] = await sql<Row[]>`select role from auth.users where id = ${id}`;
    expect(u!.role).toBe('client');
    const code = await issue(id);
    expect((await signIn(code, emailOf('someone-else'))).status).toBe(401);
    const res = await signIn(code, emailOf('ada').toUpperCase());
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res)!;
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=2592000/);
    expect(await probe({ cookie })).toBe(400);
    // One use: the same link again is refused.
    expect((await signIn(code, emailOf('ada'))).status).toBe(401);
    // Admin and member routes answer the client with client-login.
    const shell = await call('/api/shell', { cookie });
    expect(shell.status).toBe(403);
    expect(((await shell.json()) as { reason?: string }).reason).toBe('client-login');
  });

  it('never opens a client with a password or a mobile bearer', async () => {
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
    const jti = randomUUID();
    const t = tokens.buildMobileToken(id, jti, 3600);
    await sql`insert into mobile_tokens (id, user_id, label, expires_at)
              values (${jti}, ${id}, ${tag}, ${t.expiresAt.toISOString()})`;
    expect(await probe({ bearer: t.value })).toBe(401);
    expect((await call('/api/client/shell', { bearer: t.value })).status).toBe(401);
  });

  it("an admin's End sessions stops the client's next request", async () => {
    const id = await addClient('cy');
    const cookie = await signedIn(id, 'cy');
    expect(await probe({ cookie })).toBe(400);
    const res = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { signOut: true },
    });
    expect(res.status).toBe(200);
    expect(await probe({ cookie })).toBe(401);
    // A new link signs the client in again.
    expect(await probe({ cookie: await signedIn(id, 'cy') })).toBe(400);
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

  it('disable ends the session and blocks new links; enable does not revive it', async () => {
    const id = await addClient('ed');
    const cookie = await signedIn(id, 'ed');
    const code = await issue(id);
    const off = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { disabled: true },
    });
    expect(off.status).toBe(200);
    expect(await probe({ cookie })).toBe(401);
    expect((await signIn(code, emailOf('ed'))).status).toBe(401);
    const link = await call(`/api/team-admin/clients/${id}/signin-link`, {
      method: 'POST',
      cookie: asAdmin(),
    });
    expect(link.status).toBe(404);
    const on = await call(`/api/users/${id}`, {
      method: 'PATCH',
      cookie: asAdmin(),
      body: { disabled: false },
    });
    expect(on.status).toBe(200);
    expect(await probe({ cookie })).toBe(401);
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

  it('deleting the client removes its links and ends the session', async () => {
    const id = await addClient('gus');
    const cookie = await signedIn(id, 'gus');
    await issue(id);
    const res = await call(`/api/users/${id}`, { method: 'DELETE', cookie: asAdmin() });
    expect(res.status).toBe(200);
    made.splice(made.indexOf(id), 1);
    expect(await probe({ cookie })).toBe(401);
    const left = await sql<Row[]>`select 1 from client_signin_codes where login_id = ${id}`;
    expect(left).toHaveLength(0);
  });
});
