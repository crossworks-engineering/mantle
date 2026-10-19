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
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${adm}, ${emailOf(adm)}, ${hash}, 'admin'), (${lim}, ${emailOf(lim)}, ${hash}, 'admin'),
      (${out}, ${emailOf(out)}, ${hash}, 'admin'), (${memIn}, ${emailOf(memIn)}, ${hash}, 'member'),
      (${mem}, ${emailOf(mem)}, ${hash}, 'member')`;
    await runWorkspacesSwitch(scratch.url);
    const [a] = await sql<Row[]>`select w.id::text as id from workspaces w
                                  join auth.users o on o.id = w.owner_id and o.is_owner
                                 where w.is_admin`;
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
    // The session stays on the role: as main's getLoginOr401 answered.
    expect(kinds).toEqual({
      adm: 'admin',
      lim: 'admin',
      out: 'admin',
      memIn: 'member',
      mem: 'member',
    });
    // A Login getLoginOr401 did not answer has no legacy shape and no pair.
    await inRequest(adm, async (login) => {
      const copy = { ...login };
      expect(() => session.legacyLogin(copy)).toThrow(/getLoginOr401/);
      expect(shown(await facts.adminFacts(copy))).toEqual({ admin: false, areas: [] });
    });
  });

  it('no scope open: the row pair and the area rule, byte-equal to main', async () => {
    for (const [name, id] of Object.entries(all)) {
      const got = await inRequest(id, async (login) => {
        expect(m.currentScope().kind).toBe('system');
        return shown(await facts.adminFacts(login));
      });
      expect(JSON.stringify(got), name).toBe(JSON.stringify(await mainAnswer(id)));
    }
  });

  it("in the login's own scope: one round trip on the scope's answers, byte-equal to main", async () => {
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
      expect(JSON.stringify(got), name).toBe(JSON.stringify(await mainAnswer(id)));
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
