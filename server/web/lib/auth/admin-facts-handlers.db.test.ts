/**
 * The handlers that moved to the Login and adminFacts (plan v3.2 section
 * 2.2 point 3), on a real migrated Postgres and the real login row
 * (getLoginOr401 through a session cookie, in the real request scope of
 * each route's row).
 *
 * Each cell sets what the site decided before (the legacy kind, the role,
 * requireArea) beside what it decides now (adminFacts, the Admin pair), for
 * an Admin user, an Admin user with the keys area off, a role=admin login
 * outside Admin (drift), a role=member login inside Admin (drift) and a
 * member. Byte-equal for the Admin users and the member; the only changes
 * are the two drift logins', each narrower (no answer gets wider), named
 * in the changed-answers tables of docs/_archive/plan-v3-s8c-handover.md
 * and pinned here as that table states them:
 *  - GET /api/access-keys and GET /api/shell (any-login rows, the login's
 *    scope): Admin is the scope's answer with the row's pair, so the
 *    role=admin login outside Admin is no Admin user (its own keys only;
 *    the shell's empty Admin values and the short asset token);
 *  - the keys area (GET in the scope, POST unscoped): the role=member
 *    login inside Admin holds no keys area (the pair needs role admin);
 *  - a pairing code's claim and a peer's risky tools: the Admin pair, so
 *    the role=admin login outside Admin claims nothing and its peer names
 *    no risky tool.
 * And the same narrowing of the role=admin login outside Admin:
 *  - the owner rows that branched on the owner answer's kind (an app's
 *    brokers, its frame ticket, a new app's author ceiling, the Admin
 *    switches of PATCH /api/apps/:id), in the owner guard's scope;
 *  - the chat rows (which assistants, the limits, the error detail), in
 *    the chat guard's scope;
 *  - the public rows (whoami's areas, OAuth consent), with no scope (the
 *    row's answer);
 *  - a role change in the Admin workspace (WsCaller's Admin only), in the
 *    any-login scope.
 *
 * Since S8b round 4 (L1) the session follows membership too (resolvedFor):
 * where a cell's first column is the session's legacy kind it now agrees
 * with adminFacts (BY_MEMBERSHIP); against main, drift only, out is a member
 * session and memIn an Admin login (the one wider answer).
 *
 * The cells run with the box modes warn (the full run) and on.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/auth/admin-facts-handlers.db.test.ts
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

type Row = Record<string, unknown>;
type Name = 'adm' | 'lim' | 'out' | 'memIn' | 'mem';

describe.skipIf(!URL)('the handlers that ask adminFacts of the Login', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let tokens: typeof import('./tokens');
  let session: typeof import('./session');
  let facts: typeof import('./login');
  let rc: typeof import('../../server/request-context');
  let ws: typeof import('../workspaces');
  let riq: typeof import('./rule-in-query');
  const tag = `c2-${randomUUID().slice(0, 8)}`;
  const adm = randomUUID(); // role admin, in Admin
  const lim = randomUUID(); // role admin, in Admin, its keys area off
  const out = randomUUID(); // role admin, taken out of Admin (drift)
  const memIn = randomUUID(); // role member, put into Admin (drift)
  const mem = randomUUID(); // member, not in Admin
  const all: Record<Name, string> = { adm, lim, out, memIn, mem };
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;

  const ctxFor = (id: string, path: string) => {
    const cookie = `mantle_session=${tokens.buildSessionCookie(id, { epoch: 0 }).value}`;
    const req = new Request(`http://x${path}`, { headers: { cookie } });
    return { req, path, method: 'GET' };
  };

  /** getLoginOr401 for `id` in the real request scope of the row `key`. */
  const inRow = async <T>(
    key: string,
    id: string,
    fn: (login: import('./login').Login) => Promise<T>,
  ): Promise<T> => {
    const { buildRoutePolicy } = await import('./route-policy');
    const { routeManifest } = await import('../../server/route-manifest.gen');
    const row = [...buildRoutePolicy(routeManifest).values()].find((r) => r.key === key);
    if (!row) throw new Error(`no row ${key}`);
    const ctx = { ...ctxFor(id, row.pattern), method: row.method, route: row };
    return rc.runWithRequestContext(ctx, () =>
      m.runInRequestSlot(async () => {
        const login = await session.getLoginOr401();
        if (login instanceof Response) throw new Error(`no login for ${id}: ${login.status}`);
        expect(m.currentScope().kind).toBe('user');
        return fn(login);
      }),
    );
  };

  /** A guard's answer for `id` in the real request scope of the row `key`
   *  (its `:id` a fresh uuid). */
  const inGuardRow = async <T>(
    key: string,
    id: string,
    guard: () => Promise<unknown>,
    fn: (answer: never) => Promise<T>,
  ): Promise<T> => {
    const { buildRoutePolicy } = await import('./route-policy');
    const { routeManifest } = await import('../../server/route-manifest.gen');
    const row = [...buildRoutePolicy(routeManifest).values()].find((r) => r.key === key);
    if (!row) throw new Error(`no row ${key}`);
    const path = row.pattern.replace(/:\w+/g, randomUUID());
    const ctx = { ...ctxFor(id, path), method: row.method, route: row };
    return rc.runWithRequestContext(ctx, () =>
      m.runInRequestSlot(async () => {
        const got = await guard();
        if (got instanceof Response) throw new Error(`${key}: no answer for ${id}: ${got.status}`);
        return fn(got as never);
      }),
    );
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'admin-facts-c2-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./tokens');
    session = await import('./session');
    facts = await import('./login');
    rc = await import('../../server/request-context');
    ws = await import('../workspaces');
    riq = await import('./rule-in-query');
    await ensureTestAnchor(sql);
    const hash = bcrypt.hashSync('first password 1', 4);
    // As the superuser: the role guard (0330) refuses the app pools an admin login.
    const su0 = superuserClient(scratch.url);
    try {
      await su0`insert into auth.users (id, email, password_hash, role) values
        (${adm}, ${emailOf(adm)}, ${hash}, 'admin'), (${lim}, ${emailOf(lim)}, ${hash}, 'admin'),
        (${out}, ${emailOf(out)}, ${hash}, 'admin'), (${memIn}, ${emailOf(memIn)}, ${hash}, 'member'),
        (${mem}, ${emailOf(mem)}, ${hash}, 'member')`;
    } finally {
      await su0.end();
    }
    await runWorkspacesSwitch(scratch.url);
    const [a] = await sql<Row[]>`select w.id::text as id from workspaces w
                                  join auth.users o on o.id = w.owner_id and o.is_owner
                                 where w.is_admin`;
    const su = superuserClient(scratch.url);
    try {
      await su`delete from workspace_users where workspace_id = ${a!.id as string} and login_id = ${out}`;
      await su`insert into workspace_users (workspace_id, login_id, moderator)
                values (${a!.id as string}, ${memIn}, false) on conflict do nothing`;
      await su`update workspace_users set limits = '{"areas": {"keys": false}}'::jsonb
                where workspace_id = ${a!.id as string} and login_id = ${lim}`;
    } finally {
      await su.end();
    }
    expect(Number((await sql<Row[]>`select mantle_role_drift() as n`)[0]!.n)).toBe(2);
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  }, 120_000);

  /** Each login's [before, now] for one site. */
  const table = async (
    one: (id: string) => Promise<[unknown, unknown]>,
  ): Promise<Record<Name, [unknown, unknown]>> => {
    const got = {} as Record<Name, [unknown, unknown]>;
    for (const [name, id] of Object.entries(all) as [Name, string][]) got[name] = await one(id);
    return got;
  };

  it('Admin on the any-login rows (access keys, shell): the drift admin narrows only', async () => {
    for (const key of ['GET /api/access-keys', 'GET /api/shell']) {
      const got = await table((id) =>
        inRow(key, id, async (login) => [
          session.sessionRole(login) === 'admin',
          (await facts.adminFacts(login)).admin,
        ]),
      );
      expect(got, key).toEqual(BY_MEMBERSHIP);
    }
  });

  it('the keys area, in the scope (GET) and unscoped (POST): the drift member narrows only', async () => {
    const scoped = await table((id) =>
      inRow('GET /api/access-keys', id, async (login) => [
        await ws.requireArea(ws.workspaceCaller(login), 'keys'),
        (await facts.adminFacts(login)).areas.has('keys'),
      ]),
    );
    const unscoped = await table((id) =>
      inRow('POST /api/access-keys', id, (login) =>
        riq.inRuleInQuery(async () => {
          expect(m.currentScope().kind).toBe('system');
          return [
            await ws.requireArea(ws.workspaceCaller(login), 'keys'),
            (await facts.adminFacts(login)).areas.has('keys'),
          ] as [unknown, unknown];
        }),
      ),
    );
    for (const got of [scoped, unscoped]) {
      expect(got).toEqual({
        adm: [true, true],
        lim: [false, false],
        out: [false, false],
        // S8b round 4: the session follows membership, so the drifted login
        // inside Admin holds the keys area as the area rule says (wider than
        // main's [true, false], drift only).
        memIn: [true, true],
        mem: [false, false],
      });
    }
  });

  it("a pairing code's claim: the drift admin claims nothing, every other login as before", async () => {
    const { issuePairCode, claimPairCode } = await import('../pair-code');
    const claim = async (id: string, nonAdmin: boolean) => {
      const { code } = await issuePairCode(id);
      const got = await claimPairCode(code, 'cell', new Date(), { nonAdmin });
      return got === null || got === 'update-app' ? got : 'token';
    };
    const got = {} as Record<Name, unknown[]>;
    for (const [name, id] of Object.entries(all) as [Name, string][])
      got[name] = [await claim(id, false), await claim(id, true)];
    expect(got).toEqual({
      adm: ['token', 'token'],
      lim: ['token', 'token'],
      // S8b: membership decides (drift only, both): outside Admin is a
      // member (narrower: main minted an Admin bearer for role admin) ...
      out: ['update-app', 'token'],
      // ... and inside Admin an Admin login (wider: main answered a member).
      memIn: ['token', 'token'],
      mem: ['update-app', 'token'],
    });
  });

  // S8b round 4 (L1): membership decides the session too (resolvedFor), so
  // the legacy kind and adminFacts agree for every login. Against main,
  // drift only: out (role admin outside Admin) is a member session, no
  // Admin (main [true, false]); memIn (role member inside Admin) is an Admin
  // login (main [false, false]: the one wider answer, which the membership
  // definers never leave and the merge precondition reads as 0).
  const BY_MEMBERSHIP = {
    adm: [true, true],
    lim: [true, true],
    out: [false, false],
    memIn: [true, true],
    mem: [false, false],
  };

  it('Admin on the owner rows (app brokers, frame ticket, new app): the drift admin narrows only', async () => {
    for (const key of [
      'GET /api/apps',
      'POST /api/apps',
      'POST /api/apps/:id/frame-ticket',
      'POST /api/apps/:id/db-broker',
      'POST /api/apps/:id/tool-broker',
    ]) {
      const got = await table((id) =>
        inGuardRow(
          key,
          id,
          () => session.getOwnerOr401WithLogin(),
          async (owner: import('./session').OwnerRouteLogin) => {
            expect(m.currentScope().kind).toBe('user');
            const login = session.ownerAnswerLogin(owner);
            if (!login) throw new Error('the owner answer carries no login');
            return [owner.member === null, (await facts.adminFacts(login)).admin];
          },
        ),
      );
      expect(got, key).toEqual(BY_MEMBERSHIP);
    }
  });

  it('Admin on the chat rows (assistants, limits, error detail): the drift admin narrows only', async () => {
    const { chatAdmin } = await import('../assistant-chat');
    for (const key of [
      'POST /api/assistant/turn',
      'GET /api/assistant/thread',
      'POST /api/assistant/transcribe',
    ]) {
      const got = await table((id) =>
        inGuardRow(
          key,
          id,
          () => session.getChatLoginOr401(),
          async (chat: import('./session').ChatCaller) => {
            expect(m.currentScope().kind).toBe('user');
            return [session.sessionRole(chat.asLogin) === 'admin', await chatAdmin(chat)];
          },
        ),
      );
      expect(got, key).toEqual(BY_MEMBERSHIP);
    }
  });

  it('Admin on the public rows (whoami, OAuth consent), with no scope: the drift admin narrows only', async () => {
    for (const key of [
      'GET /api/auth/whoami',
      'GET /api/oauth/authorize',
      'POST /api/oauth/authorize',
    ]) {
      const got = await table((id) =>
        inGuardRow(
          key,
          id,
          () => session.getLoginOr401(),
          async (login: import('./login').Login) => {
            expect(m.currentScope().kind).toBe('system');
            return [session.sessionRole(login) === 'admin', (await facts.adminFacts(login)).admin];
          },
        ),
      );
      expect(got, key).toEqual(BY_MEMBERSHIP);
    }
  });

  it("a role change's Admin only (WsCaller): the drift admin narrows only", async () => {
    for (const key of [
      'POST /api/workspaces/:id/users',
      'DELETE /api/workspaces/:id/users/:loginId',
    ]) {
      const got = await table((id) =>
        inRow(key, id, async (login) => {
          const caller = ws.workspaceCaller(login);
          return [
            session.sessionRole(login) === 'admin',
            (await facts.adminFacts(caller.login!)).admin,
          ];
        }),
      );
      expect(got, key).toEqual(BY_MEMBERSHIP);
    }
  });

  it("a peer's Admin facts (risky tools, the owner's own peer): the Admin pair, not the role", async () => {
    const { loadLoginRow } = await import('./login-row');
    const got = await table(async (id) => {
      const row = await loadLoginRow(id);
      if (!row) throw new Error(`no row ${id}`);
      return [row.role === 'admin', session.adminLogin(row)];
    });
    expect(got).toEqual({
      adm: [true, true],
      lim: [true, true],
      out: [true, false], // narrower: its peer names no risky tool
      memIn: [false, true], // S8b, wider for the drift only: membership decides
      mem: [false, false],
    });
  });

  it("an MCP key's and an Admin OAuth grant's caller, the companion's sign-in: the Admin pair, not the role", async () => {
    const { loadLoginRow } = await import('./login-row');
    const { mintAccessKey } = await import('../access-keys');
    const { resolveMcpCaller } = await import('../mcp-auth');
    const { actorMayConnect } = await import('../mcp-oauth');
    const { handleTokenLogin } = await import('../token-login');
    const roleOf = async (id: string) => (await loadLoginRow(id))!.role;
    // An MCP key acts as its login: an Admin caller, a member's, or none.
    const keyCaller = await table(async (id) => {
      const made = await mintAccessKey({
        name: `${tag} cell`,
        loginId: id,
        access: 'read',
        areas: null,
        riskyTools: [],
        expiresAt: null,
        createdBy: id,
        maxLive: 10,
      });
      if (!made) throw new Error(`no key for ${id}`);
      const req = new Request('http://x/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${made.key}` },
      });
      const role = await roleOf(id);
      const before = role === 'admin' ? 'admin' : role === 'member' ? 'member' : null;
      return [before, (await resolveMcpCaller(req))?.role ?? null];
    });
    expect(keyCaller).toEqual({
      adm: ['admin', 'admin'],
      lim: ['admin', 'admin'],
      out: ['admin', null], // narrower: not an Admin caller, and no member
      memIn: ['member', 'admin'], // S8b, wider for the drift only: membership decides
      mem: ['member', 'member'],
    });
    // An Admin OAuth grant (no session epoch) connects only an Admin login.
    const connect = await table(async (id) => [
      (await roleOf(id)) === 'admin',
      await actorMayConnect(id, null),
    ]);
    expect(connect).toEqual({
      adm: [true, true],
      lim: [true, true],
      out: [true, false], // narrower: role admin outside Admin is no Admin user
      memIn: [false, true], // S8b: drift only
      mem: [false, false],
    });
    // The old companion's sign-in (POST /api/auth/mobile-login): Admin only,
    // a member hears "Update the app".
    const signIn = await table(async (id) => {
      const req = new Request('http://x/api/auth/mobile-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: emailOf(id), password: 'first password 1' }),
      });
      const res = await handleTokenLogin(req, {
        path: '/api/auth/mobile-login',
        channel: 'mobile',
        defaultLabel: 'cell',
        adminsOnly: true,
      });
      const role = await roleOf(id);
      return [role === 'admin' ? 200 : 426, res.status];
    });
    expect(signIn).toEqual({
      adm: [200, 200],
      lim: [200, 200],
      // S8b: membership decides (drift only): outside Admin is a member
      // ("Update the app"), inside Admin an Admin login.
      out: [200, 426],
      memIn: [426, 200],
      mem: [426, 426],
    });
  });
});
