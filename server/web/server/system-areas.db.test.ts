/**
 * The System workspace through the real app (createApp), on a migrated
 * scratch brain: one route per Admin area per person, the areas the shell
 * answers, the routes that moved to the users area (branding, pending, the
 * Inbox), a long-lived API key, the System screen's rules as the routes
 * answer them, and the operator's recovery (system:add).
 *
 * People (the anchor is the owner, always in Admin and System):
 *  - sys: an Admin user and a System user: every area.
 *  - adm: an Admin user outside System: the users area only.
 *  - mem: a member: no area.
 * A System-only login cannot exist (out of Admin is out of System).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/server/system-areas.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureTestAnchor,
  runWorkspacesSwitch,
  superuserClient,
} from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, unknown>;

describe.skipIf(!URL)('the System workspace: areas, routes and recovery', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let app: import('hono').Hono;
  let tokens: typeof import('../lib/auth/tokens');
  const tag = `sysws-${randomUUID().slice(0, 8)}`;
  const sys = randomUUID();
  const adm = randomUUID();
  const mem = randomUUID();
  const rec1 = randomUUID(); // a member, for the recovery
  const rec2 = randomUUID(); // an Admin user outside System, for the recovery
  const off = randomUUID(); // a disabled member, for the recovery
  let anchor = '';
  let adminWs = '';
  let systemWs = '';
  const PASSWORD = 'system area password 1';
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let ip = 0;

  const call = async (
    as: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Json }> => {
    ip += 1;
    const res = await app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `198.51.100.${ip % 250}`,
        cookie: `mantle_session=${tokens.buildSessionCookie(as, { epoch: 0 }).value}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Json;
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = { text };
    }
    return { status: res.status, json };
  };
  const status = async (as: string, method: string, path: string, body?: unknown) =>
    (await call(as, method, path, body)).status;
  const su = async <T>(fn: (c: ReturnType<typeof superuserClient>) => Promise<T>): Promise<T> => {
    const c = superuserClient(scratch!.url);
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };

  /** One GET route of each Admin area. */
  const AREA_ROUTES = {
    settings: '/api/mcp-settings',
    users: '/api/users',
    assistants: '/api/agents/options',
    connectors: '/api/peers',
    keys: '/api/secrets',
  } as const;

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'system-areas-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('../lib/auth/tokens');
    anchor = await ensureTestAnchor(sql);
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await su(
      (c) => c`insert into auth.users (id, email, password_hash, role) values
        (${sys}, ${emailOf(sys)}, ${hash}, 'admin'), (${adm}, ${emailOf(adm)}, ${hash}, 'admin'),
        (${mem}, ${emailOf(mem)}, ${hash}, 'member'), (${rec1}, ${emailOf(rec1)}, ${hash}, 'member'),
        (${rec2}, ${emailOf(rec2)}, ${hash}, 'admin'), (${off}, ${emailOf(off)}, ${hash}, 'member')`,
    );
    await su((c) => c`update auth.users set disabled_at = now() where id = ${off}`);
    // The switch makes Admin with every admin login, and System with every
    // Admin user (mantle_ws_migrate ends with mantle_ws_ensure_system).
    await runWorkspacesSwitch(scratch.url);
    const [w] = await sql<{ admin: string; system: string }[]>`
      select mantle_ws_admin_id(${anchor}::uuid)::text as admin,
             mantle_ws_system_id(${anchor}::uuid)::text as system`;
    adminWs = w!.admin;
    systemWs = w!.system;
    // adm and rec2 stay Admin users, out of System (a System user's act on
    // its screen; here the fixture's).
    await su(
      (c) => c`delete from workspace_users
                where workspace_id = ${systemWs} and login_id in (${adm}, ${rec2})`,
    );
    const { createApp } = await import('./app');
    app = await createApp();
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  it('the migration put every Admin user in System, each a Moderator; the fixture took two out', async () => {
    const rows = await sql<{ login: string; moderator: boolean }[]>`
      select login_id::text as login, moderator from workspace_users
       where workspace_id = ${systemWs} order by login_id`;
    expect(new Set(rows.map((r) => r.login))).toEqual(new Set([anchor, sys]));
    expect(rows.every((r) => r.moderator)).toBe(true);
    expect(adminWs).not.toBe(systemWs);
  });

  it('one route per area: a System user all, an Admin user users only, a member none', async () => {
    const answers: Record<string, Record<string, number>> = {};
    for (const [who, id] of Object.entries({ sys, adm, mem })) {
      answers[who] = {};
      for (const [area, path] of Object.entries(AREA_ROUTES)) {
        answers[who]![area] = await status(id, 'GET', path);
      }
    }
    expect(answers.sys).toEqual({
      settings: 200,
      users: 200,
      assistants: 200,
      connectors: 200,
      keys: 200,
    });
    expect(answers.adm).toEqual({
      settings: 403,
      users: 200,
      assistants: 403,
      connectors: 403,
      keys: 403,
    });
    for (const area of Object.keys(AREA_ROUTES)) expect(answers.mem![area], area).not.toBe(200);
  });

  it('the shell: areas per person; System marked, and listed only for its users', async () => {
    const shell = async (id: string) =>
      (await call(id, 'GET', '/api/shell')).json as {
        areas: string[];
        workspaces: { id: string; isAdmin: boolean; isSystem?: true }[];
      };
    const s = await shell(sys);
    expect(s.areas).toEqual(['settings', 'users', 'assistants', 'connectors', 'keys']);
    expect(s.workspaces.find((w) => w.id === systemWs)?.isSystem).toBe(true);
    expect(s.workspaces.find((w) => w.id === adminWs)?.isSystem).toBeUndefined();
    const a = await shell(adm);
    expect(a.areas).toEqual(['users']);
    expect(a.workspaces.some((w) => w.id === systemWs)).toBe(false);
    expect((await shell(mem)).areas).toEqual([]);
  });

  it('the moved routes: branding, pending and the Inbox are for every Admin user', async () => {
    // Branding (the brand gate: the users area).
    const brand = { timezone: 'UTC', siteName: `${tag} brand` };
    expect(await status(adm, 'PUT', '/api/profile', brand)).toBe(200);
    expect(await status(mem, 'PUT', '/api/profile', brand)).not.toBe(200);
    // Pending approvals.
    expect(await status(adm, 'GET', '/api/pending')).toBe(200);
    expect(await status(mem, 'GET', '/api/pending')).not.toBe(200);
    // The Inbox reader.
    expect(await status(adm, 'GET', '/api/email/accounts')).toBe(200);
    expect(await status(adm, 'GET', '/api/email/contact-gate')).toBe(200);
    expect(await status(mem, 'GET', '/api/email/accounts')).not.toBe(200);
  });

  it('a key that never expires: only a login with the keys area, a System user', async () => {
    const make = (id: string) =>
      call(id, 'POST', '/api/access-keys', {
        name: `${tag} key`,
        access: 'read',
        areas: null,
        password: PASSWORD,
        expiresInDays: null,
      });
    const bySys = await make(sys);
    expect(bySys.status, JSON.stringify(bySys.json)).toBe(201);
    expect(bySys.json.expiresAt).toBeNull();
    expect((await make(adm)).status).toBe(400);
  });

  it('the workspace list: an Admin user sees System, built in, read only', async () => {
    const list = (await call(adm, 'GET', '/api/workspaces')).json as {
      workspaces: Json[];
    };
    const row = list.workspaces.find((w) => w.id === systemWs);
    expect(row).toMatchObject({ isSystem: true, isAdmin: false, builtIn: true });
    expect(row?.me).toEqual({ member: false, moderator: false });
    const admin = list.workspaces.find((w) => w.id === adminWs);
    expect(admin).toMatchObject({ isSystem: false, isAdmin: true, builtIn: true });
    // Admin first, System second.
    expect(list.workspaces.slice(0, 2).map((w) => w.id)).toEqual([adminWs, systemWs]);
  });

  it("the System screen's rules, as the routes answer them", async () => {
    const usersOf = async () =>
      (
        await sql<{ login: string; moderator: boolean }[]>`
          select login_id::text as login, moderator from workspace_users
           where workspace_id = ${systemWs}`
      ).reduce<Record<string, boolean>>((o, r) => ({ ...o, [r.login]: r.moderator }), {});
    const base = `/api/workspaces/${systemWs}`;
    // Only a System user adds, and removes another.
    let r = await call(adm, 'POST', `${base}/users`, { loginId: rec1 });
    expect([r.status, r.json.code]).toEqual([403, 'system_users_only']);
    r = await call(adm, 'DELETE', `${base}/users/${sys}`);
    expect([r.status, r.json.code]).toEqual([403, 'system_users_only']);
    // Only an Admin user can be added.
    r = await call(sys, 'POST', `${base}/users`, { loginId: mem });
    expect([r.status, r.json.code]).toEqual([409, 'not_admin_user']);
    // No tick to clear, no rename, no archive.
    r = await call(sys, 'PATCH', `${base}/users/${sys}`, { moderator: false });
    expect([r.status, r.json.code]).toEqual([409, 'admin_workspace']);
    r = await call(sys, 'PATCH', base, { name: `${tag} renamed` });
    expect([r.status, r.json.code]).toEqual([409, 'reserved_name']);
    r = await call(sys, 'POST', `${base}/archive`);
    expect([r.status, r.json.code]).toEqual([409, 'admin_workspace']);
    // The owner stays.
    r = await call(sys, 'DELETE', `${base}/users/${anchor}`);
    expect([r.status, r.json.code]).toEqual([403, 'owner_stays_admin']);
    // A System user adds an Admin user, ticked even when the body says no:
    // the areas follow at once.
    r = await call(sys, 'POST', `${base}/users`, { loginId: adm, moderator: false });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await usersOf())[adm]).toBe(true);
    expect(await status(adm, 'GET', AREA_ROUTES.connectors)).toBe(200);
    // Anyone may leave, and the areas go with it.
    r = await call(adm, 'DELETE', `${base}/users/${adm}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await usersOf())[adm]).toBeUndefined();
    expect(await status(adm, 'GET', AREA_ROUTES.connectors)).toBe(403);
    expect(Object.keys(await usersOf()).sort()).toEqual([anchor, sys].sort());
  });

  it("workspace_user_set refuses System for every role, the owner's call too, and changes nothing", async () => {
    const t = await import('@mantle/tools');
    const tool = t.getBuiltin('workspace_user_set')!;
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from workspace_users where workspace_id = ${systemWs}`;
    for (const role of ['user', 'moderator', 'none'] as const) {
      for (const login of [adm, mem, sys]) {
        const r = (await tool.handler(
          { changes: [{ loginId: login, workspaceId: systemWs, role }] },
          { ownerId: anchor } as never,
        )) as { ok: boolean; output?: { results: { ok: boolean; reason?: string }[] } };
        expect(r.ok, `${role} ${login}`).toBe(true);
        expect(r.output!.results[0], `${role} ${login}`).toMatchObject({
          ok: false,
          reason: 'system',
        });
      }
    }
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from workspace_users where workspace_id = ${systemWs}`;
    expect(after[0]!.n).toBe(before[0]!.n);
    // users_list names it.
    const list = (await t.getBuiltin('users_list')!.handler({}, { ownerId: anchor } as never)) as {
      output: { workspaces: { id: string; system?: true; admin: boolean }[] };
    };
    expect(list.output.workspaces.find((w) => w.id === systemWs)).toMatchObject({
      system: true,
      admin: false,
    });
    expect(list.output.workspaces.find((w) => w.id === adminWs)?.system).toBeUndefined();
  });

  it('system:add, the recovery: Admin first when needed, then System; refusals named', async () => {
    const { systemAdd } = await import('../lib/system-workspace');
    const seats = async (id: string) =>
      (
        await sql<{ ws: string; moderator: boolean }[]>`
          select workspace_id::text as ws, moderator from workspace_users
           where login_id = ${id} and workspace_id in (${adminWs}, ${systemWs})`
      )
        .map((s) => `${s.ws === adminWs ? 'admin' : 'system'}:${s.moderator}`)
        .sort();
    expect(await systemAdd(`nobody-${tag}@example.com`)).toEqual({
      ok: false,
      reason: 'no_login',
    });
    expect(await systemAdd(emailOf(off))).toEqual({ ok: false, reason: 'disabled' });
    expect(await seats(off)).toEqual([]);
    // An Admin user outside System: System only.
    expect(await systemAdd(emailOf(rec2))).toEqual({
      ok: true,
      addedToAdmin: false,
      addedToSystem: true,
    });
    expect(await seats(rec2)).toEqual(['admin:true', 'system:true']);
    // A member: Admin (the role follows), then System. The email in any case.
    expect(await systemAdd(emailOf(rec1).toUpperCase())).toEqual({
      ok: true,
      addedToAdmin: true,
      addedToSystem: true,
    });
    expect(await seats(rec1)).toEqual(['admin:true', 'system:true']);
    const [role] = await sql<{ role: string }[]>`select role from auth.users where id = ${rec1}`;
    expect(role!.role).toBe('admin');
    expect(await status(rec1, 'GET', AREA_ROUTES.keys)).toBe(200);
    // Again: nothing to do.
    expect(await systemAdd(emailOf(rec1))).toEqual({
      ok: true,
      addedToAdmin: false,
      addedToSystem: false,
    });
    // Each add wrote its event, with no actor (system work).
    const [ev] = await sql<{ n: number }[]>`
      select count(*)::int as n from workspace_events
       where action = 'user.add' and actor_id is null
         and subject->>'login' in (${rec1}, ${rec2})
         and workspace_id in (${adminWs}, ${systemWs})`;
    expect(ev!.n).toBe(3);
  });
});
