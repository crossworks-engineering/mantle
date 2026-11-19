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
  const sys2 = randomUUID(); // a second System user (the acts on a System user's login)
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
    // The login's session epoch now: a session end (leaving System) moves it.
    const [e] = await sql<{ epoch: number }[]>`
      select session_epoch::int as epoch from auth.users where id = ${as}`;
    const res = await app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `198.51.100.${ip % 250}`,
        cookie: `mantle_session=${tokens.buildSessionCookie(as, { epoch: e?.epoch ?? 0 }).value}`,
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
        (${sys}, ${emailOf(sys)}, ${hash}, 'admin'), (${sys2}, ${emailOf(sys2)}, ${hash}, 'admin'),
        (${adm}, ${emailOf(adm)}, ${hash}, 'admin'),
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
    expect(new Set(rows.map((r) => r.login))).toEqual(new Set([anchor, sys, sys2]));
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

  it('the key list: the keys area (a System user) sees every key, an Admin user outside System its own', async () => {
    const make = async (id: string) => {
      const r = await call(id, 'POST', '/api/access-keys', {
        name: `${tag} list key`,
        access: 'read',
        areas: null,
        password: PASSWORD,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return r.json.id as string;
    };
    const sysKey = await make(sys);
    const memKey = await make(mem);
    const listOf = async (id: string) => {
      const r = await call(id, 'GET', '/api/access-keys');
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return (r.json as { keys: { id: string; login: { id: string } }[] }).keys;
    };
    // adm is an Admin user (role admin, in Admin) without the keys area: no
    // key of another login, sys's included.
    const admList = await listOf(adm);
    expect(admList.filter((k) => k.login.id !== adm)).toEqual([]);
    expect(admList.map((k) => k.id)).not.toContain(sysKey);
    // sys holds the keys area: its own key and other logins' keys.
    const sysIds = (await listOf(sys)).map((k) => k.id);
    expect(sysIds).toContain(sysKey);
    expect(sysIds).toContain(memKey);
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
    // Its name, description and look are its users': an
    // Admin user outside it changes none of them; a System user does.
    r = await call(adm, 'PATCH', base, { description: `${tag} by adm` });
    expect([r.status, r.json.code]).toEqual([403, 'forbidden']);
    r = await call(adm, 'PATCH', base, { icon: null });
    expect([r.status, r.json.code]).toEqual([403, 'forbidden']);
    r = await call(sys, 'PATCH', base, { description: `${tag} by sys` });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // A System user adds an Admin user, ticked even when the body says no:
    // the areas follow at once.
    r = await call(sys, 'POST', `${base}/users`, { loginId: adm, moderator: false });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await usersOf())[adm]).toBe(true);
    expect(await status(adm, 'GET', AREA_ROUTES.connectors)).toBe(200);
    // While in System it makes a key that never expires (the keys area).
    const key = await call(adm, 'POST', '/api/access-keys', {
      name: `${tag} sys key`,
      access: 'read',
      areas: null,
      password: PASSWORD,
      expiresInDays: null,
    });
    expect(key.status, JSON.stringify(key.json)).toBe(201);
    const epochOf = async (id: string) =>
      (
        await sql<{ e: number }[]>`select session_epoch::int as e from auth.users where id = ${id}`
      )[0]!.e;
    const liveKeys = async (id: string) =>
      (
        await sql<{ n: number }[]>`
          select count(*)::int as n from access_keys where login_id = ${id} and revoked_at is null`
      )[0]!.n;
    expect(await liveKeys(adm)).toBe(1);
    const epoch = await epochOf(adm);
    // Anyone may leave, and the areas go with it; so do its sessions and
    // keys, as out of Admin.
    r = await call(adm, 'DELETE', `${base}/users/${adm}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await usersOf())[adm]).toBeUndefined();
    expect(await liveKeys(adm)).toBe(0);
    expect(await epochOf(adm)).toBeGreaterThan(epoch);
    expect(await status(adm, 'GET', AREA_ROUTES.connectors)).toBe(403);
    // A removal by a System user ends them too.
    r = await call(sys, 'POST', `${base}/users`, { loginId: adm });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const again = await epochOf(adm);
    r = await call(sys, 'DELETE', `${base}/users/${adm}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await epochOf(adm)).toBeGreaterThan(again);
    expect((await usersOf())[adm]).toBeUndefined();
    // "System" is reserved for every other workspace, as "Admin" is.
    r = await call(sys, 'POST', '/api/workspaces', { name: ' system ' });
    expect([r.status, r.json.code, r.json.error]).toEqual([
      409,
      'reserved_name',
      'System is the name of the built-in System workspace. Pick another name.',
    ]);
    const made = await call(sys, 'POST', '/api/workspaces', { name: `${tag} ws` });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    r = await call(sys, 'PATCH', `/api/workspaces/${made.json.id as string}`, { name: 'System' });
    expect([r.status, r.json.code]).toEqual([409, 'reserved_name']);
    expect(Object.keys(await usersOf()).sort()).toEqual([anchor, sys, sys2].sort());
  });

  it('the last System user stays, in its own words: a leave, a removal from Admin, a login delete', async () => {
    // The owner always stays in System; a hand repair that took it out
    // leaves sys the last System user.
    await su(
      (c) =>
        c`delete from workspace_users
           where workspace_id = ${systemWs} and login_id in (${anchor}, ${sys2})`,
    );
    try {
      let r = await call(sys, 'DELETE', `/api/workspaces/${systemWs}/users/${sys}`);
      expect([r.status, r.json.code]).toEqual([409, 'last_system_user']);
      expect(r.json.error).toBe(
        'This is the last System user. Add another Admin user to System first.',
      );
      // Out of Admin, a role change and a delete of a System user are a
      // System user's acts only, so no person reaches the
      // last one that way: an Admin user outside System is refused first.
      // The guard trigger at commit still holds it (system-workspace.db.test).
      r = await call(adm, 'DELETE', `/api/workspaces/${adminWs}/users/${sys}`);
      expect([r.status, r.json.code], JSON.stringify(r.json)).toEqual([403, 'system_user_target']);
      r = await call(adm, 'PATCH', `/api/users/${sys}`, { role: 'member' });
      expect([r.status, r.json.code], JSON.stringify(r.json)).toEqual([403, 'system_user_target']);
      r = await call(adm, 'DELETE', `/api/users/${sys}`);
      expect([r.status, r.json.code], JSON.stringify(r.json)).toEqual([403, 'system_user_target']);
      const [still] = await sql<{ n: number }[]>`
        select count(*)::int as n from workspace_users
         where workspace_id = ${systemWs} and login_id = ${sys}`;
      expect(still!.n).toBe(1);
    } finally {
      await su(
        (c) => c`insert into workspace_users (workspace_id, login_id, moderator)
                  values (${systemWs}, ${anchor}, true), (${systemWs}, ${sys2}, true)
                  on conflict do nothing`,
      );
    }
  });

  it("a System user's login is a System user's to change; a member's is any Admin user's", async () => {
    const refusedBody = {
      error: "Only a System user can change a System user's login.",
      code: 'system_user_target',
    };
    const NEW_PASSWORD = 'system area password 2';
    // An Admin user outside System, on a System user: every act refused,
    // nothing changed.
    const before = await sql<{ e: number; d: boolean }[]>`
      select session_epoch::int as e, disabled_at is not null as d from auth.users where id = ${sys2}`;
    const acts: [string, string, unknown?][] = [
      ['POST', `/api/users/${sys2}/password`, { newPassword: NEW_PASSWORD }],
      ['PATCH', `/api/users/${sys2}`, { disabled: true }],
      ['PATCH', `/api/users/${sys2}`, { signOut: true }],
      ['PATCH', `/api/users/${sys2}`, { role: 'member' }],
      ['PATCH', `/api/users/${sys2}`, { displayName: `${tag} renamed` }],
      ['DELETE', `/api/users/${sys2}`],
      ['DELETE', `/api/users/${sys2}/devices/${randomUUID()}`],
      ['PUT', `/api/users/${sys2}/agent`, { name: `${tag} assistant` }],
      ['DELETE', `/api/users/${sys2}/agent`],
    ];
    for (const [method, path, body] of acts) {
      const r = await call(adm, method, path, body);
      expect([r.status, r.json], `${method} ${path}`).toEqual([403, refusedBody]);
    }
    // The company sign-in link: off, the route is not there (404, as on
    // every company sign-in route); on, refused as the acts above.
    const oidcActs: [string, string, unknown?][] = [
      ['PATCH', `/api/users/${sys2}/oidc`, { outside: true }],
      ['DELETE', `/api/users/${sys2}/oidc`],
    ];
    for (const [method, path, body] of oidcActs) {
      expect((await call(adm, method, path, body)).status, `${method} ${path} off`).toBe(404);
    }
    const oidcEnv = {
      MANTLE_OIDC_MODE: 'optional',
      MANTLE_OIDC_ISSUER: 'https://login.example.invalid/tenant/v2.0',
      MANTLE_OIDC_CLIENT_ID: 'mantle',
      MANTLE_PUBLIC_URL: 'https://brain.example.invalid',
    };
    const saved = Object.fromEntries(Object.keys(oidcEnv).map((k) => [k, process.env[k]]));
    Object.assign(process.env, oidcEnv);
    try {
      for (const [method, path, body] of oidcActs) {
        const r = await call(adm, method, path, body);
        expect([r.status, r.json], `${method} ${path} on`).toEqual([403, refusedBody]);
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const r0 = await call(adm, 'DELETE', `/api/workspaces/${adminWs}/users/${sys2}`);
    expect([r0.status, r0.json.code, r0.json.error]).toEqual([
      403,
      'system_user_target',
      refusedBody.error,
    ]);
    const after = await sql<{ e: number; d: boolean }[]>`
      select session_epoch::int as e, disabled_at is not null as d from auth.users where id = ${sys2}`;
    expect(after).toEqual(before);
    // The person card's description is not the login: it stays open.
    expect(await status(adm, 'PATCH', `/api/users/${sys2}`, { description: `${tag} card` })).toBe(
      200,
    );
    // A System user on a System user: allowed.
    let r = await call(sys, 'POST', `/api/users/${sys2}/password`, { newPassword: NEW_PASSWORD });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await call(sys, 'PATCH', `/api/users/${sys2}`, { signOut: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await call(sys, 'PATCH', `/api/users/${sys2}`, { disabled: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await call(sys, 'PATCH', `/api/users/${sys2}`, { disabled: false });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // The assistant route goes past the check for a System user (sys2 has
    // no assistant to rename or release: 400 and 404, never 403).
    r = await call(sys, 'PUT', `/api/users/${sys2}/agent`, { name: `${tag} assistant` });
    expect([r.status, r.json.error]).toEqual([400, 'Choose an agent to copy.']);
    r = await call(sys, 'DELETE', `/api/users/${sys2}/agent`);
    expect(r.status, JSON.stringify(r.json)).toBe(404);
    // Your own login stays yours (a System user's, an Admin user's).
    r = await call(sys2, 'PATCH', `/api/users/${sys2}`, { displayName: `${tag} me` });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await call(adm, 'PATCH', `/api/users/${adm}`, { displayName: `${tag} me too` });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // A member's login: any Admin user's, as before.
    r = await call(adm, 'POST', `/api/users/${mem}/password`, { newPassword: NEW_PASSWORD });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await call(adm, 'PATCH', `/api/users/${mem}`, { signOut: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // An Admin user outside System: any Admin user's too (adm on rec2).
    r = await call(adm, 'PATCH', `/api/users/${rec2}`, { signOut: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
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
    // A member with a shared item in its personal space: Admin (the role
    // follows, the space settled as the Users screen's promotion), then
    // System. The email in any case.
    const item = randomUUID();
    await su((c) =>
      c.begin(async (t) => {
        await t`set local session_replication_role = replica`;
        await t`insert into spaces (kind, login_id) values ('personal', ${rec1})
                  on conflict do nothing`;
        const [sp] = await t<{ id: string }[]>`
          select id::text as id from spaces where kind = 'personal' and login_id = ${rec1}`;
        await t`insert into nodes (id, owner_id, type, title, path)
                values (${item}, ${sp!.id}, 'note', 'shared', 'notes')`;
        await t`insert into space_items (node_id, sharing, review_state, submitted_at)
                values (${item}, 'team', 'draft', null)`;
      }),
    );
    expect(await systemAdd(emailOf(rec1).toUpperCase())).toEqual({
      ok: true,
      addedToAdmin: true,
      addedToSystem: true,
    });
    expect(await seats(rec1)).toEqual(['admin:true', 'system:true']);
    const [role] = await sql<{ role: string }[]>`select role from auth.users where id = ${rec1}`;
    expect(role!.role).toBe('admin');
    const [settled] = await su(
      (c) => c<{ sharing: string }[]>`select sharing from space_items where node_id = ${item}`,
    );
    expect(settled!.sharing).toBe('private');
    expect(await status(rec1, 'GET', AREA_ROUTES.keys)).toBe(200);
    // Again: nothing to do.
    expect(await systemAdd(emailOf(rec1))).toEqual({
      ok: true,
      addedToAdmin: false,
      addedToSystem: false,
    });
    // Each add wrote its event, with no actor (system work); the
    // migration's own adds say `by`.
    const [ev] = await sql<{ n: number }[]>`
      select count(*)::int as n from workspace_events
       where action = 'user.add' and actor_id is null
         and subject->>'login' in (${rec1}, ${rec2})
         and subject->>'by' is null
         and workspace_id in (${adminWs}, ${systemWs})`;
    expect(ev!.n).toBe(3);
    // A brain whose System was lost (a hand repair): made again, every
    // Admin user seated, then the login added.
    await su((c) => c`delete from workspaces where id = ${systemWs}`);
    expect(await systemAdd(emailOf(rec2))).toEqual({
      ok: true,
      addedToAdmin: false,
      addedToSystem: false,
    });
    const [again] = await sql<{ id: string | null }[]>`
      select mantle_ws_system_id(${anchor}::uuid)::text as id`;
    expect(again!.id).not.toBeNull();
    expect(again!.id).not.toBe(systemWs);
    const seated = await sql<{ login: string }[]>`
      select login_id::text as login from workspace_users where workspace_id = ${again!.id}`;
    const admins = await sql<{ login: string }[]>`
      select login_id::text as login from workspace_users where workspace_id = ${adminWs}`;
    expect(new Set(seated.map((x) => x.login))).toEqual(new Set(admins.map((x) => x.login)));
  });
});
