/**
 * The Login and adminFacts (plan v3.2 section 2.2 point 3), on a real
 * migrated Postgres and the real login row (getLoginOr401 through a
 * session cookie).
 *
 * adminFacts answers what the code decided before it, byte for byte:
 * `admin` is the row's Admin pair (role admin AND a user of the live Admin
 * workspace, adminLogin), and `areas` are the area rule's
 * (mantle_login_areas) when it is one, none otherwise. Both paths:
 *  - in the login's own scope (one SQL round trip on the scope's answers);
 *  - with no scope open (the routes about the login itself on the system
 *    pool): the row's pair and the area rule.
 * For an Admin user, an Admin user with the keys area off, a role=admin
 * login outside Admin (drift), a role=member login inside Admin (drift)
 * and a member. The legacy shape (legacyLogin) keeps the session's kind,
 * as main's getLoginOr401 answered it; the Login carries no kind and no
 * role. A scope for another login throws.
 *
 * The memo (fix round 1): it is keyed on the very Login object and on the
 * scope object, after the pair. A copy asked after the real Login in the
 * same request answers no; a Login found afresh after a demotion answers
 * the demotion; two scopes for one login (its own, an app run's) each ask;
 * an overwritten loginId borrows no pair (the Login is frozen, and the
 * entry names its login). One cell runs through the real any-login request
 * scope (getLoginOr401's enterLoginScope, read-write), not only withViewer.
 *
 * Since S8b round 4 (L1) membership decides the session too (resolvedFor),
 * so the answer is membership's (nowAnswer: mantle_login_is_admin and the
 * area rule). It equals main's for every login but the drifted role=member
 * login inside Admin, which is an Admin login now (the one looser answer,
 * drift only: the membership definers never leave it, and mantle_role_drift
 * is 0 on every box before the roll); the role=admin login outside Admin
 * stays no Admin and its session is a member's.
 *
 * The cells run with the box modes warn (the full run) and on.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/auth/admin-facts.db.test.ts
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

describe.skipIf(!URL)('the Login and adminFacts', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let tokens: typeof import('./tokens');
  let session: typeof import('./session');
  let facts: typeof import('./login');
  let rc: typeof import('../../server/request-context');
  const tag = `facts-${randomUUID().slice(0, 8)}`;
  const adm = randomUUID(); // role admin, in Admin
  const lim = randomUUID(); // role admin, in Admin, its keys area off
  const out = randomUUID(); // role admin, taken out of Admin (drift)
  const memIn = randomUUID(); // role member, put into Admin (drift)
  const mem = randomUUID(); // member, not in Admin
  const all = { adm, lim, out, memIn, mem };
  const emailOf = (id: string) => `${tag}-${id.slice(0, 8)}@example.com`;
  let adminWs = '';
  /** `fn` on a superuser client of its own (the app pools only read the
   *  workspace tables). */
  const asSu = async (fn: (su: ReturnType<typeof superuserClient>) => Promise<unknown>) => {
    const su = superuserClient(scratch!.url);
    try {
      await fn(su);
    } finally {
      await su.end();
    }
  };

  /** A fresh request carrying `id`'s session cookie. */
  const ctxFor = (id: string) => {
    const cookie = `mantle_session=${tokens.buildSessionCookie(id, { epoch: 0 }).value}`;
    const req = new Request('http://x/api/auth/whoami', { headers: { cookie } });
    return { req, path: '/api/auth/whoami', method: 'GET' };
  };
  /** What main decided: the row's pair, and the area rule's areas when it holds. */
  const mainAnswer = async (id: string) => {
    const [r] = await sql<Row[]>`
      select (u.role = 'admin' and mantle_login_is_admin(u.id)) as admin,
             mantle_login_areas(u.id) as areas
        from auth.users u where u.id = ${id}`;
    const admin = r!.admin === true;
    return { admin, areas: admin ? (r!.areas as string[]) : [] };
  };
  /** What membership decides (S8b round 4): a user of Admin now, enabled,
   *  and the area rule's areas when it is one. */
  const nowAnswer = async (id: string) => {
    const [r] = await sql<Row[]>`
      select mantle_login_is_admin(u.id) as admin, mantle_login_areas(u.id) as areas
        from auth.users u where u.id = ${id}`;
    const admin = r!.admin === true;
    return { admin, areas: admin ? (r!.areas as string[]) : [] };
  };
  const shown = (f: { admin: boolean; areas: ReadonlySet<string> }) => ({
    admin: f.admin,
    areas: [...f.areas],
  });
  /** getLoginOr401 for `id`'s cookie, then `fn` in the same request. */
  const inRequest = <T>(id: string, fn: (login: import('./login').Login) => Promise<T>) =>
    rc.runWithRequestContext(ctxFor(id), async () => {
      const login = await session.getLoginOr401();
      if (login instanceof Response) throw new Error(`no login for ${id}: ${login.status}`);
      return fn(login);
    });

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'admin-facts-db-test-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    tokens = await import('./tokens');
    session = await import('./session');
    facts = await import('./login');
    rc = await import('../../server/request-context');
    await ensureTestAnchor(sql);
    const hash = bcrypt.hashSync('first password 1', 4);
    // As the superuser: the role guard (0399) refuses the app pools an admin login.
    await asSu(
      (su) => su`insert into auth.users (id, email, password_hash, role) values
        (${adm}, ${emailOf(adm)}, ${hash}, 'admin'), (${lim}, ${emailOf(lim)}, ${hash}, 'admin'),
        (${out}, ${emailOf(out)}, ${hash}, 'admin'), (${memIn}, ${emailOf(memIn)}, ${hash}, 'member'),
        (${mem}, ${emailOf(mem)}, ${hash}, 'member')`,
    );
    await runWorkspacesSwitch(scratch.url);
    const [a] = await sql<Row[]>`select w.id::text as id from workspaces w
                                  join auth.users o on o.id = w.owner_id and o.is_owner
                                 where w.is_admin`;
    adminWs = a!.id as string;
    // As the superuser: the app pools only read the workspace tables.
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

  it('the cells mean what they say', async () => {
    expect(await mainAnswer(adm)).toEqual({
      admin: true,
      areas: ['settings', 'users', 'assistants', 'connectors', 'keys'],
    });
    expect(await mainAnswer(lim)).toEqual({
      admin: true,
      areas: ['settings', 'users', 'assistants', 'connectors'],
    });
    for (const id of [out, memIn, mem])
      expect(await mainAnswer(id)).toEqual({ admin: false, areas: [] });
    // Membership equals main for every login but the drifted memIn.
    for (const [name, id] of Object.entries(all)) {
      if (name === 'memIn') continue;
      expect(await nowAnswer(id), name).toEqual(await mainAnswer(id));
    }
    expect(await nowAnswer(memIn)).toEqual({
      admin: true,
      areas: ['settings', 'users', 'assistants', 'connectors', 'keys'],
    });
  });

  it('the Login has no kind and no role; its legacy shape keeps the session kind', async () => {
    const kinds: Record<string, string> = {};
    for (const [name, id] of Object.entries(all)) {
      await inRequest(id, async (login) => {
        expect(Object.keys(login).sort(), name).toEqual([
          'actor',
          'brainId',
          'contactId',
          'displayName',
          'email',
          'loginId',
          'sessionEpoch',
          'source',
        ]);
        expect(login.loginId).toBe(id);
        expect(login.actor.id).toBe(id);
        kinds[name] = session.legacyLogin(login).kind;
      });
    }
    // Membership decides the session (S8b round 4): the two drifted logins
    // swap (main: out admin, memIn member).
    expect(kinds).toEqual({
      adm: 'admin',
      lim: 'admin',
      out: 'member',
      memIn: 'admin',
      mem: 'member',
    });
    // A Login getLoginOr401 did not answer has no legacy shape and no pair.
    await inRequest(adm, async (login) => {
      const copy = { ...login };
      expect(() => session.legacyLogin(copy)).toThrow(/getLoginOr401/);
      expect(shown(await facts.adminFacts(copy))).toEqual({ admin: false, areas: [] });
    });
  });

  it('no scope open: membership and the area rule (main for all but the drifted memIn)', async () => {
    for (const [name, id] of Object.entries(all)) {
      const got = await inRequest(id, async (login) => {
        expect(m.currentScope().kind).toBe('system');
        return shown(await facts.adminFacts(login));
      });
      expect(JSON.stringify(got), name).toBe(JSON.stringify(await nowAnswer(id)));
    }
  });

  it("in the login's own scope: one round trip on the scope's answers, membership's", async () => {
    for (const [name, id] of Object.entries(all)) {
      const got = await inRequest(id, (login) =>
        m.withViewer({ login: id }, async () => {
          expect(m.currentScope().kind).toBe('user');
          const a = facts.adminFacts(login);
          // Asked once per request: the same answer.
          expect(facts.adminFacts(login)).toBe(a);
          return shown(await a);
        }),
      );
      expect(JSON.stringify(got), name).toBe(JSON.stringify(await nowAnswer(id)));
    }
  });

  it('a copy asked after the real Login in the same request answers no, scoped or not', async () => {
    await inRequest(adm, async (login) => {
      expect(shown(await facts.adminFacts(login)).admin).toBe(true);
      const copy = { ...login };
      const upper = { ...login, loginId: login.loginId.toUpperCase() };
      for (const c of [copy, upper]) {
        expect(shown(await facts.adminFacts(c))).toEqual({ admin: false, areas: [] });
      }
      await m.withViewer({ login: adm }, async () => {
        expect(shown(await facts.adminFacts(login)).admin).toBe(true);
        for (const c of [copy, upper]) {
          expect(shown(await facts.adminFacts(c))).toEqual({ admin: false, areas: [] });
        }
      });
    });
  });

  it('demote, forget, find again: the fresh Login answers the demotion', async () => {
    try {
      await inRequest(adm, async (login) => {
        expect(shown(await facts.adminFacts(login)).admin).toBe(true);
        const before = await m.withViewer({ login: adm }, () => facts.adminFacts(login));
        expect(before.admin).toBe(true);
        // The demotion is the removal from Admin (membership decides; the
        // column, which only the definers write, is left as it was).
        await asSu(
          (su) => su`delete from workspace_users where workspace_id = ${adminWs}
                                and login_id = ${adm}`,
        );
        session.forgetRequestLogins();
        const again = await session.getLoginOr401();
        if (again instanceof Response) throw new Error(`no login again: ${again.status}`);
        expect(again).not.toBe(login);
        expect(session.legacyLogin(again).kind).toBe('member');
        expect(shown(await facts.adminFacts(again))).toEqual({ admin: false, areas: [] });
        const scoped = await m.withViewer({ login: adm }, () => facts.adminFacts(again));
        expect(shown(scoped)).toEqual({ admin: false, areas: [] });
        // Membership's answer after the demotion: no.
        expect(await nowAnswer(adm)).toEqual({ admin: false, areas: [] });
      });
    } finally {
      await asSu(
        (su) => su`insert into workspace_users (workspace_id, login_id, moderator)
                             values (${adminWs}, ${adm}, true) on conflict do nothing`,
      );
    }
    expect(await nowAnswer(adm)).toEqual({
      admin: true,
      areas: ['settings', 'users', 'assistants', 'connectors', 'keys'],
    });
  });

  it('two scopes for one login each ask: an app run without Admin answers no', async () => {
    await inRequest(adm, async (login) => {
      const own = await m.withViewer({ login: adm }, () => facts.adminFacts(login));
      expect(shown(own)).toEqual(await mainAnswer(adm));
      const app = await m.withViewer({ login: adm, app: { team: true } }, async () => {
        expect(m.currentScope().kind).toBe('user');
        const [r] = (await m.db.execute(
          m.sql`select "public"."mantle_scope_is_admin"() as a`,
        )) as unknown as { a: boolean }[];
        expect(r!.a).toBe(false);
        return facts.adminFacts(login);
      });
      expect(shown(app)).toEqual({ admin: false, areas: [] });
      // Its own scope again: its own answer, still.
      const ownAgain = await m.withViewer({ login: adm }, () => facts.adminFacts(login));
      expect(shown(ownAgain)).toEqual(await mainAnswer(adm));
    });
  });

  it('an overwritten loginId borrows no pair', async () => {
    await inRequest(adm, async (admLogin) => {
      expect(Object.isFrozen(admLogin)).toBe(true);
      expect(Object.isFrozen(admLogin.actor)).toBe(true);
      expect(() => {
        (admLogin as { loginId: string }).loginId = mem;
      }).toThrow(TypeError);
      expect(admLogin.loginId).toBe(adm);
      expect(Object.isFrozen(session.legacyLogin(admLogin))).toBe(true);
    });
    // A member's Login with its loginId set to an Admin user's, as an
    // unfrozen copy keyed on nothing, and as a defineProperty on the real
    // object (refused: frozen).
    await inRequest(mem, async (memLogin) => {
      const posed = { ...memLogin, loginId: adm };
      expect(shown(await facts.adminFacts(posed))).toEqual({ admin: false, areas: [] });
      expect(() => Object.defineProperty(memLogin, 'loginId', { value: adm })).toThrow(TypeError);
      expect(shown(await facts.adminFacts(memLogin))).toEqual({ admin: false, areas: [] });
    });
  });

  it('through the real any-login request scope (enterLoginScope, read-write): membership`s', async () => {
    const { buildRoutePolicy } = await import('./route-policy');
    const { routeManifest } = await import('../../server/route-manifest.gen');
    const row = [...buildRoutePolicy(routeManifest).values()].find(
      (r) => r.logins === 'any' && r.effect === 'write',
    );
    if (!row) throw new Error('no any-login write row');
    for (const [name, id] of Object.entries(all)) {
      const ctx = { ...ctxFor(id), path: row.pattern, method: row.method, route: row };
      const got = await rc.runWithRequestContext(ctx, () =>
        m.runInRequestSlot(async () => {
          const login = await session.getLoginOr401();
          if (login instanceof Response) throw new Error(`no login for ${name}: ${login.status}`);
          expect(m.currentScope().kind, name).toBe('user');
          expect(m.currentRequestMode()?.writes, name).toBe(true);
          const a = facts.adminFacts(login);
          expect(facts.adminFacts(login)).toBe(a);
          return shown(await a);
        }),
      );
      expect(JSON.stringify(got), `${name} ${row.key}`).toBe(JSON.stringify(await nowAnswer(id)));
    }
  });

  it('a scope for another login throws, never an answer', async () => {
    await inRequest(adm, async (login) => {
      await expect(m.withViewer({ login: mem }, () => facts.adminFacts(login))).rejects.toThrow(
        /another login/,
      );
    });
  });
});
