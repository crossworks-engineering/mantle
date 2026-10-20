/**
 * The handlers that moved to the Login and adminFacts (plan v3.2 section
 * 2.2 point 3, part c2), on a real migrated Postgres and the real login row
 * (getLoginOr401 through a session cookie, in the real request scope of
 * each route's row).
 *
 * Each cell sets what the site decided before (the legacy kind, the role,
 * requireArea) beside what it decides now (adminFacts, the Admin pair), for
 * an Admin user, an Admin user with the keys area off, a role=admin login
 * outside Admin (drift), a role=member login inside Admin (drift) and a
 * member. Byte-equal for the Admin users and the member; the only changes
 * are the two drift logins', each narrower (no answer gets wider), named
 * in the changed-answers table of docs/_archive/plan-v3-s8c-handover.md
 * (part c2) and pinned here as that table states them:
 *  - GET /api/access-keys and GET /api/shell (any-login rows, the login's
 *    scope): Admin is the scope's answer with the row's pair, so the
 *    role=admin login outside Admin is no Admin user (its own keys only;
 *    the shell's empty Admin values and the short asset token);
 *  - the keys area (GET in the scope, POST unscoped): the role=member
 *    login inside Admin holds no keys area (the pair needs role admin);
 *  - a pairing code's claim and a peer's risky tools: the Admin pair, so
 *    the role=admin login outside Admin claims nothing and its peer names
 *    no risky tool.
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

describe.skipIf(!URL)('the c2 handlers on the Login and adminFacts', () => {
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
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${adm}, ${emailOf(adm)}, ${hash}, 'admin'), (${lim}, ${emailOf(lim)}, ${hash}, 'admin'),
      (${out}, ${emailOf(out)}, ${hash}, 'admin'), (${memIn}, ${emailOf(memIn)}, ${hash}, 'member'),
      (${mem}, ${emailOf(mem)}, ${hash}, 'member')`;
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
          session.legacyLogin(login).kind === 'admin',
          (await facts.adminFacts(login)).admin,
        ]),
      );
      expect(got, key).toEqual({
        adm: [true, true],
        lim: [true, true],
        out: [true, false], // narrower: role admin outside Admin is no Admin user
        memIn: [false, false],
        mem: [false, false],
      });
    }
  });

  it('the keys area, in the scope (GET) and unscoped (POST): the drift member narrows only', async () => {
    const scoped = await table((id) =>
      inRow('GET /api/access-keys', id, async (login) => [
        await ws.requireArea(ws.workspaceCaller(session.legacyLogin(login)), 'keys'),
        (await facts.adminFacts(login)).areas.has('keys'),
      ]),
    );
    const unscoped = await table((id) =>
      inRow('POST /api/access-keys', id, (login) =>
        riq.inRuleInQuery(async () => {
          expect(m.currentScope().kind).toBe('system');
          return [
            await ws.requireArea(ws.workspaceCaller(session.legacyLogin(login)), 'keys'),
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
        memIn: [true, false], // narrower: role member inside Admin holds no keys area
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
      out: [null, null], // narrower: main minted an Admin bearer (role admin)
      memIn: ['update-app', 'token'],
      mem: ['update-app', 'token'],
    });
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
      memIn: [false, false],
      mem: [false, false],
    });
  });
});
