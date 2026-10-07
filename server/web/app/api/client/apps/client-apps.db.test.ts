/**
 * Client apps end to end (client logins C6, plan test 22), on a real
 * migrated Postgres, through the real app (createApp), the real gates and a
 * real SQLite per app. The fixture is FOUR published apps identical but for
 * the level (client, team, admin, public), plus an informational client app,
 * so only the level rule and the flag tell them apart:
 *
 *  - a client lists, runs and writes the client app, and is refused the team,
 *    admin and public twins with the same 404 as an id that does not exist
 *    (no route tells a team app from a missing one);
 *  - an informational app refuses a write from a client and from a member
 *    (403 `read-only`) and still answers a read;
 *  - a member writes the client app, and the client reads what the member
 *    wrote (one shared database); a member's write to the public twin is
 *    refused;
 *  - the tool broker refuses a declared brain-wide read tool and an
 *    undeclared slug;
 *  - the frame refuses a ticket after End sessions (the epoch bump) and for a
 *    disabled client;
 *  - every call is in the access log with the client login.
 *
 * The frame document itself is stood in (it reads the bundle from object
 * storage); the ticket and liveness checks in front of it are real.
 * Brain items belong to the shared test anchor (ensureTestAnchor); removes
 * its rows after.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/app/api/client/apps/client-apps.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/app-frame', () => ({
  renderAppFrame: vi.fn(async () => new Response('<!doctype html>', { status: 200 })),
}));

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('client apps, end to end', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('@/lib/auth/tokens');
  let session: typeof import('@/lib/auth/session');
  let log: typeof import('@mantle/content');
  const tag = `capp-e2e-${randomUUID().slice(0, 8)}`;
  const clientLogin = randomUUID();
  const memberLogin = randomUUID();
  const ids = {
    client: randomUUID(),
    team: randomUUID(),
    admin: randomUUID(),
    pub: randomUUID(),
    info: randomUUID(),
  };
  const ours = new Set<string>(Object.values(ids));
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-capps-'));
  let brain = '';
  let ip = 0;

  const call = (
    p: string,
    init: { method?: string; cookie?: string; body?: unknown } = {},
  ): Promise<Response> => {
    ip += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${ip % 250}`,
    };
    if (init.cookie) headers.cookie = init.cookie;
    return Promise.resolve(
      app.request(p, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  };
  const epochOf = async (id: string) =>
    (await sql<{ e: number }[]>`select session_epoch as e from auth.users where id = ${id}`)[0]!.e;
  const clientCookie = async () =>
    `mantle_session=${
      tokens.buildSessionCookie(clientLogin, {
        ttlSeconds: session.CLIENT_SESSION_TTL_SECONDS,
        epoch: await epochOf(clientLogin),
      }).value
    }`;
  const memberCookie = () => `mantle_session=${tokens.buildSessionCookie(memberLogin).value}`;
  const db = (base: string, id: string, cookie: string, body: unknown) =>
    call(`${base}/${id}/db-broker`, { cookie, body });
  const ticketFor = async (id: string, cookie: string): Promise<string> => {
    const res = await call(`/api/client/apps/${id}/frame-ticket`, { cookie, body: {} });
    expect(res.status).toBe(200);
    return ((await res.json()) as { ticket: string }).ticket;
  };
  const frame = (id: string, ticket: string) =>
    call(`/api/client/apps/${id}/frame?t=${encodeURIComponent(ticket)}`);

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'client-apps-db-test-secret-at-least-32-chars';
    process.env.APP_DB_DIR = path.join(root, 'app-dbs');
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('@/lib/auth/tokens');
    session = await import('@/lib/auth/session');
    log = await import('@mantle/content');
    const { ensureTestAnchor } = await import('@mantle/db/test-support');
    await m.ensureViewerRoles(sql, process.env.MANTLE_MASTER_KEY);
    brain = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role, display_name) values
      (${clientLogin}, ${`${tag}-c@example.invalid`}, 'x', 'client', 'Casey Client'),
      (${memberLogin}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Pat Member')`;
    const title = `${tag} orders`;
    for (const [id, level] of [
      [ids.client, 'client'],
      [ids.team, 'team'],
      [ids.admin, 'admin'],
      [ids.pub, 'public'],
      [ids.info, 'client'],
    ] as const) {
      await sql`insert into nodes (id, owner_id, type, title, path, audience)
                values (${id}, ${brain}, 'app', ${title}, 'apps', ${level})`;
    }
    const green = {
      storageKey: 'apps/x.js',
      sha256: 'x',
      builtAt: '2026-09-30T00:00:00Z',
      esbuildVersion: '0',
      bytes: 1,
      ok: true,
    };
    const manifest = { toolSlugs: ['client_shared_list', 'search_chunks'] };
    for (const id of Object.values(ids)) {
      await sql`insert into apps (node_id, manifest, published_build, data_read_only)
                values (${id}, ${JSON.stringify(manifest)}::jsonb, ${JSON.stringify(green)}::jsonb,
                        ${id === ids.info})`;
    }
    const { createApp } = await import('@/server/app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from nodes where id in ${sql([...ours])}`;
    await sql`delete from audit_log where actor_email like ${`${tag}%`}`;
    await sql`delete from spaces where login_id in ${sql([clientLogin, memberLogin])}`;
    await sql`delete from auth.users where id in ${sql([clientLogin, memberLogin])}`;
    await m.closeDb();
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it('lists the client app and the informational one, never a level twin', async () => {
    const res = await call('/api/client/apps', { cookie: await clientCookie() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apps: Array<{ id: string; dataReadOnly: boolean }> };
    const mine = body.apps.filter((a) => ours.has(a.id));
    expect(mine.map((a) => a.id).sort()).toEqual([ids.client, ids.info].sort());
    expect(mine.find((a) => a.id === ids.info)?.dataReadOnly).toBe(true);
    expect(Object.keys(mine[0]!)).not.toContain('audience');
  });

  it('runs and writes the client app', async () => {
    const cookie = await clientCookie();
    expect((await frame(ids.client, await ticketFor(ids.client, cookie))).status).toBe(200);
    const base = '/api/client/apps';
    const make = await db(base, ids.client, cookie, {
      op: 'exec',
      sql: 'create table if not exists orders (id integer primary key, item text)',
    });
    expect(make.status).toBe(200);
    const put = await db(base, ids.client, cookie, {
      op: 'exec',
      sql: 'insert into orders (item) values (?)',
      params: ['from the client'],
    });
    expect(put.status).toBe(200);
    const read = await db(base, ids.client, cookie, {
      op: 'query',
      sql: 'select item from orders order by id',
    });
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain('from the client');
  });

  it('refuses the team, admin and public twins with the same 404 as no app at all', async () => {
    const cookie = await clientCookie();
    const answers = new Set<string>();
    for (const id of [ids.team, ids.admin, ids.pub, randomUUID()]) {
      for (const [suffix, body] of [
        ['frame-ticket', {}],
        ['tool-broker', { slug: 'client_shared_list' }],
        ['db-broker', { op: 'query', sql: 'select 1' }],
      ] as const) {
        const res = await call(`/api/client/apps/${id}/${suffix}`, { cookie, body });
        expect(res.status, `${suffix} ${id}`).toBe(404);
        answers.add(JSON.stringify(await res.json()));
      }
    }
    expect(answers.size).toBe(1);
  });

  it('an informational app refuses a write from a client and a member, and still reads', async () => {
    const make = { op: 'exec', sql: 'create table if not exists t (x integer)' };
    const client = await db('/api/client/apps', ids.info, await clientCookie(), make);
    expect(client.status).toBe(403);
    expect(await client.json()).toMatchObject({ ok: false, reason: 'read-only' });
    const member = await db('/api/member/apps', ids.info, memberCookie(), make);
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ ok: false, reason: 'read-only' });
    for (const [base, cookie] of [
      ['/api/client/apps', await clientCookie()],
      ['/api/member/apps', memberCookie()],
    ] as const) {
      const read = await db(base, ids.info, cookie, { op: 'query', sql: 'select 1 as one' });
      expect(read.status, base).toBe(200);
    }
  });

  it('a member writes the client app, and the client reads it; the public twin stays read only', async () => {
    const put = await db('/api/member/apps', ids.client, memberCookie(), {
      op: 'exec',
      sql: 'insert into orders (item) values (?)',
      params: ['from a member'],
    });
    expect(put.status).toBe(200);
    const read = await db('/api/client/apps', ids.client, await clientCookie(), {
      op: 'query',
      sql: 'select item from orders order by id',
    });
    expect(JSON.stringify(await read.json())).toContain('from a member');
    const pub = await db('/api/member/apps', ids.pub, memberCookie(), {
      op: 'exec',
      sql: 'create table if not exists t (x integer)',
    });
    expect(pub.status).toBe(403);
    expect(await pub.json()).toMatchObject({ reason: 'read-only' });
  });

  it('the tool broker refuses a declared brain-wide read tool and an undeclared slug', async () => {
    const cookie = await clientCookie();
    for (const slug of ['search_chunks', 'note_list']) {
      const res = await call(`/api/client/apps/${ids.client}/tool-broker`, {
        cookie,
        body: { slug, input: {} },
      });
      expect(res.status, slug).toBe(403);
    }
  });

  it('logs every call with the client login', async () => {
    let rows: Awaited<ReturnType<typeof log.listAppAccess>> = [];
    for (let i = 0; i < 250; i++) {
      rows = (await log.listAppAccess(brain, ids.client)).filter((r) => r.actorId === clientLogin);
      if (new Set(rows.map((r) => r.kind)).size === 4) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // A refused tool call also lands an error row (apps plan G4).
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['auth', 'db', 'tool', 'error']));
    expect(rows.every((r) => r.detail.via === 'client')).toBe(true);
    expect(rows.some((r) => r.detail.refused)).toBe(true);
    expect(rows.some((r) => r.kind === 'error' && r.detail.source === 'tool')).toBe(true);
  });

  it('the frame refuses a ticket after End sessions', async () => {
    const ticket = await ticketFor(ids.client, await clientCookie());
    expect((await frame(ids.client, ticket)).status).toBe(200);
    expect(await session.endLoginSessions(clientLogin)).not.toBeNull();
    expect((await frame(ids.client, ticket)).status).toBe(401);
    // A new session at the new epoch mints a ticket that opens it again.
    expect(
      (await frame(ids.client, await ticketFor(ids.client, await clientCookie()))).status,
    ).toBe(200);
  });

  it('the frame refuses a ticket of a disabled client', async () => {
    const ticket = await ticketFor(ids.client, await clientCookie());
    await sql`update auth.users set disabled_at = now() where id = ${clientLogin}`;
    try {
      expect((await frame(ids.client, ticket)).status).toBe(401);
    } finally {
      await sql`update auth.users set disabled_at = null where id = ${clientLogin}`;
    }
  });
});
