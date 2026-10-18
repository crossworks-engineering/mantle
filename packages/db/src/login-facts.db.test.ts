/**
 * The login facts in SQL (workspaces arch plan v3.2, S2a a0; migration
 * 0304_login_facts): every fact answers as the text it replaces, byte for
 * byte, on a grid of logins, areas and scopes, on a database of its own (so
 * mantle_brain_id() is this file's anchor).
 *
 *  - mantle_login_is_admin against loginHoldsAdmin's SQL as main had it;
 *  - mantle_area_rule against loginHasArea as main had it (its TypeScript
 *    area guard, then its SQL), and adminUserSql (now a call of it) too;
 *  - mantle_login_areas against loginHasArea over SCOPE_AREAS;
 *  - mantle_login_area against its 0293 text;
 *  - mantle_scope_has_area against its 0291 text, on the workspace role's
 *    settings and on the system pool's (mantle.scope_login): the same but
 *    for the cells the redefinition names (a disabled login inside a scope
 *    still open; a scope that holds another brain's Admin workspace, which
 *    no box has: one brain per database);
 *  - loginHoldsAdmin and loginHasArea (now thin calls) against main's text;
 *  - mantle_role_drift: a disabled Admin user and a former client are left
 *    out (0), a role=admin login outside Admin counts (1), a member inside
 *    Admin counts;
 *  - the catalog: no PUBLIC and no role but a superuser, mantle_runtime and
 *    mantle_owner (so no viewer role, write role, gap writer or
 *    mantle_system) may EXECUTE a login fact, mantle_login_area too; the
 *    runtime role may run the four it calls, never mantle_login_area;
 *  - mantle_login_areas(anchor) gives WORKSPACE_AREAS (client-types), so
 *    an area TypeScript gains that the SQL lacks fails here;
 *  - the renumber proof: 0304's `when` is above every one before it, and
 *    a database at main's last migration applies it and only it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/login-facts.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql as sqlTag } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';
import {
  createMigratedScratchDatabase,
  createScratchDatabaseBefore,
  ensureTestAnchor,
} from './test-support';
import { OWNER_ROLE, RUNTIME_ROLE, SYSTEM_ROLE } from './runtime-role';
import { GAP_WRITER_ROLE } from './access-matrix';
import { viewerRoleName } from './viewer';
import { WORKSPACE_AREAS } from '@mantle/client-types/dto/workspaces';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');
const TAG = '0304_login_facts';
const WRITE_ROLE = viewerRoleName('write');
const AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys'] as const;
const ASKED = [...AREAS, 'bogus'] as const;

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

/** main's loginHoldsAdmin text (client.ts at v0.300.83), `$1` the login. */
const MAIN_HOLDS_ADMIN = `select exists (
  select 1 from workspaces w
    join workspace_users u on u.workspace_id = w.id and u.login_id = $1::uuid
    join auth.users l on l.id = u.login_id and l.disabled_at is null
   where w.owner_id = mantle_brain_id() and w.is_admin and w.archived_at is null) as a`;
/** main's loginHasArea SQL (client.ts at v0.300.83), `$1` the login, `$2` the area. */
const MAIN_HAS_AREA = `select exists (
  select 1 from workspaces w
    join workspace_users u on u.workspace_id = w.id and u.login_id = $1::uuid
    join auth.users l on l.id = u.login_id and l.disabled_at is null
   where w.owner_id = mantle_brain_id() and w.is_admin and w.archived_at is null
     and coalesce(u.limits -> 'areas' ->> $2::text, '') <> 'false') as a`;
/** 0293's mantle_login_area body. */
const MAIN_LOGIN_AREA = `select (NOT EXISTS (SELECT 1 FROM "public"."workspaces" w
                      WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin")
      OR EXISTS (SELECT 1 FROM "public"."workspaces" w
                   JOIN "public"."workspace_users" u ON u."workspace_id" = w."id" AND u."login_id" = $1::uuid
                   JOIN "auth"."users" l ON l."id" = u."login_id" AND l."disabled_at" IS NULL
                  WHERE w."owner_id" = "public"."mantle_brain_id"() AND w."is_admin"
                    AND w."archived_at" IS NULL
                    AND $2::text IN ('settings', 'users', 'assistants', 'connectors', 'keys')
                    AND coalesce(u."limits" -> 'areas' ->> $2::text, '') <> 'false')) as a`;
/** 0291's mantle_scope_has_area body. */
const MAIN_SCOPE_HAS_AREA = `select EXISTS (
    SELECT 1 FROM "public"."workspaces" w
      JOIN "public"."workspace_users" u
        ON u."workspace_id" = w."id" AND u."login_id" = "public"."mantle_scope_login_id"()
     WHERE w."is_admin" AND w."archived_at" IS NULL
       AND w."id" = ANY ("public"."mantle_scope_ws"())
       AND $1::text IN ('settings', 'users', 'assistants', 'connectors', 'keys')
       AND coalesce(u."limits" -> 'areas' ->> $1::text, '') <> 'false') as a`;

describe('0304 is stamped above every `when` before it (renumber proof)', () => {
  it('is stamped above its predecessor and above the S11a-7 hotfix`s 1790197500000', () => {
    expect(at).toBeGreaterThan(0);
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
    expect(journal[at]!.when).toBeGreaterThan(1790197500000);
  });
});

describe.skipIf(!URL)('the login facts answer as the text they replace (S2a a0)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let brain = '';
  let adminWs = '';
  const tag = `lf${randomUUID().slice(0, 8)}`;
  const other = randomUUID(); // another brain's owner (no box has one)
  const ws = { team: randomUUID(), otherAdmin: randomUUID() };
  const L = {
    adm: randomUUID(), // role admin, in Admin
    lim: randomUUID(), // role admin, in Admin, users off (false), keys off ("false")
    dis: randomUUID(), // role admin, in Admin, disabled
    mem: randomUUID(), // member, in Team only
    out: randomUUID(), // role admin, not in Admin
    former: randomUUID(), // a former client: role admin row, archived, not in Admin
    otherUser: randomUUID(), // member, in the other brain's Admin only
    none: randomUUID(), // no login at all
  };
  const logins = (): Record<string, string> => ({ anchor: brain, ...L });

  const one = async (q: string, params: unknown[]): Promise<unknown> =>
    (await sql.unsafe<{ a: unknown }[]>(q, params as never[]))[0]!.a;
  /** `fn` in a transaction rolled back after. */
  const rolledBack = async <T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> => {
    let out: T | undefined;
    await sql
      .begin(async (tx) => {
        out = await fn(tx);
        throw new Error('rollback');
      })
      .catch((err: unknown) => {
        if ((err as Error).message !== 'rollback') throw err;
      });
    return out as T;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(sql);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('./index');
    const email = (k: string) => `${tag}-${k}@example.invalid`;
    await sql`insert into auth.users (id, email, password_hash, role) values
      (${L.adm}, ${email('adm')}, 'x', 'admin'), (${L.lim}, ${email('lim')}, 'x', 'admin'),
      (${L.dis}, ${email('dis')}, 'x', 'admin'), (${L.mem}, ${email('mem')}, 'x', 'member'),
      (${L.out}, ${email('out')}, 'x', 'admin'), (${L.former}, ${email('former')}, 'x', 'admin'),
      (${L.otherUser}, ${email('other')}, 'x', 'member'), (${other}, ${email('owner2')}, 'x', 'member')`;
    await sql`update auth.users set disabled_at = now() where id = ${L.dis}`;
    await sql`insert into archive_client_logins (login_id, email, created_at, session_epoch)
              values (${L.former}, ${email('former')}, now(), 0)`;
    await sql`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain}),
              (${other}, 'brain', ${other}) on conflict (id) do nothing`;
    const [a] = await sql<{ id: string }[]>`
      select id::text from workspaces where owner_id = ${brain} and is_admin`;
    adminWs = a?.id ?? randomUUID();
    if (!a) {
      await sql`insert into workspaces (id, owner_id, name, is_admin)
                values (${adminWs}, ${brain}, ${`${tag} Admin`}, true)`;
    }
    await sql`insert into workspaces (id, owner_id, name, is_admin) values
      (${ws.team}, ${brain}, ${`${tag} Team`}, false),
      (${ws.otherAdmin}, ${other}, ${`${tag} Other Admin`}, true)`;
    await sql`insert into workspace_users (workspace_id, login_id, moderator, limits) values
      (${adminWs}, ${brain}, true, '{}'), (${adminWs}, ${L.adm}, true, '{}'),
      (${adminWs}, ${L.lim}, true, ${sql.json({ areas: { users: false, keys: 'false', settings: true } })}),
      (${adminWs}, ${L.dis}, true, '{}'), (${ws.team}, ${L.mem}, true, '{}'),
      (${ws.otherAdmin}, ${L.otherUser}, true, '{}')
      on conflict do nothing`;
  }, 300_000);

  afterAll(async () => {
    await m?.closeDb();
    await sql?.end();
    await scratch?.drop();
  });

  it('mantle_login_is_admin and loginHoldsAdmin answer as main`s loginHoldsAdmin', async () => {
    const diffs: string[] = [];
    for (const [k, id] of Object.entries(logins())) {
      const main = await one(MAIN_HOLDS_ADMIN, [id]);
      const fact = await one('select mantle_login_is_admin($1::uuid) as a', [id]);
      const ts = await m.loginHoldsAdmin(id);
      if (fact !== main || ts !== main) diffs.push(`${k}: main ${main} fact ${fact} ts ${ts}`);
    }
    expect(diffs).toEqual([]);
    // The grid has both answers, and the role alone is never Admin.
    expect(await m.loginHoldsAdmin(brain)).toBe(true);
    expect(await m.loginHoldsAdmin(L.out)).toBe(false);
    expect(await m.loginHoldsAdmin(L.dis)).toBe(false);
    expect(await m.loginHoldsAdmin('not-a-uuid')).toBe(false);
  });

  it('mantle_area_rule, mantle_login_areas and loginHasArea answer as main`s loginHasArea', async () => {
    const diffs: string[] = [];
    for (const [k, id] of Object.entries(logins())) {
      const want: string[] = [];
      for (const area of ASKED) {
        // main: the TypeScript guard (SCOPE_AREAS), then the SQL.
        const main = (AREAS as readonly string[]).includes(area)
          ? await one(MAIN_HAS_AREA, [id, area])
          : false;
        const fact = await one('select mantle_area_rule($1::uuid, $2::text) as a', [id, area]);
        const ts = await m.loginHasArea(id, area as (typeof AREAS)[number]);
        if (fact !== main || ts !== main) {
          diffs.push(`${k} ${area}: main ${main} fact ${fact} ts ${ts}`);
        }
        if (area !== 'bogus') {
          // adminUserSql (workspace-ticks.ts) is the same rule as SQL.
          const [u] = (await m.systemDb.execute(
            sqlTag`select ${m.adminUserSql(sqlTag`${id}::uuid`, area)} as a`,
          )) as unknown as { a: boolean }[];
          if (u!.a !== main) diffs.push(`${k} ${area}: main ${main} adminUserSql ${u!.a}`);
        }
        if (main === true) want.push(area);
      }
      const areas = await one('select mantle_login_areas($1::uuid) as a', [id]);
      if (JSON.stringify(areas) !== JSON.stringify(want)) {
        diffs.push(`${k} areas: main ${JSON.stringify(want)} fact ${JSON.stringify(areas)}`);
      }
    }
    expect(diffs).toEqual([]);
    expect(await one('select mantle_login_areas($1::uuid) as a', [L.lim])).toEqual([
      'settings',
      'assistants',
      'connectors',
    ]);
    expect(await one('select mantle_login_areas($1::uuid) as a', [L.dis])).toEqual([]);
    expect(await m.loginHasArea('not-a-uuid', 'users')).toBe(false);
  });

  it('mantle_login_areas gives the anchor every area TypeScript knows (WORKSPACE_AREAS)', async () => {
    // The SQL's area list against client-types': an area TypeScript gains
    // that the SQL lacks fails here (the anchor holds every area).
    expect(await one('select mantle_login_areas($1::uuid) as a', [brain])).toEqual([
      ...WORKSPACE_AREAS,
    ]);
  });

  it('mantle_login_area answers as its 0293 text, with and without an Admin workspace', async () => {
    const grid = async (q: (s: string, p: unknown[]) => Promise<unknown>) => {
      const diffs: string[] = [];
      for (const [k, id] of Object.entries(logins())) {
        for (const area of ASKED) {
          const main = await q(MAIN_LOGIN_AREA, [id, area]);
          const fact = await q('select mantle_login_area($1::uuid, $2::text) as a', [id, area]);
          if (fact !== main) diffs.push(`${k} ${area}: main ${main} fact ${fact}`);
        }
      }
      return diffs;
    };
    expect(await grid(one)).toEqual([]);
    // No Admin workspace (the fail-open branch, S4a/S4b): yes for anyone;
    // the strict facts stay no, so the branch reaches neither of them.
    const noAdmin = await rolledBack(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from workspaces where owner_id = ${brain} and is_admin`;
      const q = async (s: string, p: unknown[]) =>
        (await tx.unsafe<{ a: unknown }[]>(s, p as never[]))[0]!.a;
      return {
        diffs: await grid(q),
        loginArea: await q('select mantle_login_area($1::uuid, $2::text) as a', [L.out, 'users']),
        rule: await q('select mantle_area_rule($1::uuid, $2::text) as a', [brain, 'users']),
        areas: await q('select mantle_login_areas($1::uuid) as a', [brain]),
        admin: await q('select mantle_login_is_admin($1::uuid) as a', [brain]),
      };
    });
    expect(noAdmin).toEqual({
      diffs: [],
      loginArea: true,
      rule: false,
      areas: [],
      admin: false,
    });
  });

  it('mantle_scope_has_area answers as its 0291 text but for the named cells', async () => {
    const scopes: Record<string, string[]> = {
      admin: [adminWs],
      'admin+team': [adminWs, ws.team],
      team: [ws.team],
      none: [],
      otherAdmin: [ws.otherAdmin],
    };
    const diffs: string[] = [];
    for (const path of ['viewer', 'system'] as const) {
      for (const [k, id] of Object.entries(logins())) {
        for (const [sk, ids] of Object.entries(scopes)) {
          const got = await rolledBack(async (tx) => {
            await tx`select set_config('mantle.ws', ${`{${ids.join(',')}}`}, true)`;
            if (path === 'viewer') await tx`select set_config('mantle.login_id', ${id}, true)`;
            else await tx`select set_config('mantle.scope_login', ${id}, true)`;
            const out: string[] = [];
            for (const area of ASKED) {
              const [main] = await tx.unsafe<{ a: boolean }[]>(MAIN_SCOPE_HAS_AREA, [area]);
              const [fact] = await tx<{ a: boolean }[]>`select mantle_scope_has_area(${area}) as a`;
              if (fact!.a !== main!.a)
                out.push(`${path} ${k} ${sk} ${area}: ${main!.a} -> ${fact!.a}`);
            }
            return out;
          });
          diffs.push(...got);
        }
      }
    }
    // The named cells, each narrower (yes to no), nothing else:
    //  - a disabled login inside a scope that is still open (plan S2a a0);
    //  - a scope holding another brain's Admin workspace (the owner test;
    //    no box has two brains in one database).
    const named: string[] = [];
    for (const path of ['viewer', 'system']) {
      for (const sk of ['admin', 'admin+team']) {
        for (const area of AREAS) named.push(`${path} dis ${sk} ${area}: true -> false`);
      }
      for (const area of AREAS) named.push(`${path} otherUser otherAdmin ${area}: true -> false`);
    }
    expect(diffs.sort()).toEqual(named.sort());
  });

  it('the disabled-in-scope cell: the workspace role in the login`s own Admin scope', async () => {
    const asks = async (login: string) =>
      rolledBack(async (tx) => {
        await tx`set local role mantle_view_user`;
        await tx`select set_config('mantle.ws', ${`{${adminWs}}`}, true),
                        set_config('mantle.mod_ws', ${`{${adminWs}}`}, true),
                        set_config('mantle.login_id', ${login}, true)`;
        const [r] = await tx<{ a: boolean }[]>`select mantle_scope_has_area('users') as a`;
        return r!.a;
      });
    expect(await asks(L.adm)).toBe(true);
    expect(await asks(L.dis)).toBe(false);
  });

  it('scopeHasArea kind by kind on the brain`s own Admin (workspaces.db.test.ts`s W5b1 cell)', async () => {
    const has = (scope: Parameters<typeof m.withScope>[0], area: string) =>
      m.withScope(scope, () => m.scopeHasArea(area as (typeof AREAS)[number]));
    // System work: every area, never an unknown area.
    expect(await m.scopeHasArea('users')).toBe(true);
    expect(await m.scopeHasArea('nope' as never)).toBe(false);
    const user = (loginId: string, wsIds: string[]) =>
      ({ kind: 'user', loginId, ws: wsIds, modWs: [] }) as const;
    // A workspace scope: an area only when it holds the Admin workspace.
    expect(await has(user(L.mem, [ws.team]), 'settings')).toBe(false);
    expect(await has(user(L.adm, [adminWs, ws.team]), 'settings')).toBe(true);
    expect(await has(user(brain, [adminWs]), 'settings')).toBe(true);
    // Its limits switch an area off: false, and "false" as a JSON string.
    expect(await has(user(L.lim, [adminWs]), 'users')).toBe(false);
    expect(await has(user(L.lim, [adminWs]), 'keys')).toBe(false);
    expect(await has(user(L.lim, [adminWs]), 'settings')).toBe(true);
    expect(await has(user(L.lim, [adminWs]), 'assistants')).toBe(true);
    // Not a user of Admin, an assistant answering no login, a link: no area.
    expect(await has(user(L.mem, [adminWs]), 'settings')).toBe(false);
    expect(
      await has({ kind: 'assistant', loginId: null, ws: [adminWs], modWs: [] }, 'settings'),
    ).toBe(false);
    // The Admin assistant answering an Admin user: that user's areas;
    // answering a login that is no user of Admin: none.
    expect(
      await has({ kind: 'assistant', loginId: L.adm, ws: [adminWs], modWs: [] }, 'settings'),
    ).toBe(true);
    expect(
      await has({ kind: 'assistant', loginId: L.mem, ws: [adminWs], modWs: [] }, 'settings'),
    ).toBe(false);
    expect(await has({ kind: 'link', loginId: null, ws: [adminWs], modWs: [] }, 'settings')).toBe(
      false,
    );
    // The named cell through the TypeScript path: a disabled Admin user in
    // a scope still open holds no area (0304).
    expect(await has(user(L.dis, [adminWs]), 'settings')).toBe(false);
    // Another brain's Admin in the scope: no area (the owner test, 0304).
    expect(await has(user(L.otherUser, [ws.otherAdmin]), 'settings')).toBe(false);
  });

  it('mantle_role_drift: enabled logins only, former clients left out', async () => {
    const drift = async (tx: postgres.TransactionSql) =>
      (await tx<{ n: number }[]>`select mantle_role_drift() as n`)[0]!.n;
    // As seeded, a role=admin login outside Admin (L.out): 1. The disabled
    // Admin user (role admin, Admin needs an enabled login) and the former
    // client (role admin, outside Admin) are left out.
    expect(await rolledBack(drift)).toBe(1);
    // L.out disabled: a box whose only odd login is a disabled Admin user: 0.
    expect(
      await rolledBack(async (tx) => {
        await tx`update auth.users set disabled_at = now() where id = ${L.out}`;
        return drift(tx);
      }),
    ).toBe(0);
    // The former client, were it not left out, would count.
    expect(
      await rolledBack(async (tx) => {
        await tx`update auth.users set disabled_at = now() where id = ${L.out}`;
        await tx`delete from archive_client_logins where login_id = ${L.former}`;
        return drift(tx);
      }),
    ).toBe(1);
    // A member inside Admin is drift too; the disabled Admin user enabled again is not.
    expect(
      await rolledBack(async (tx) => {
        await tx`update auth.users set disabled_at = now() where id = ${L.out}`;
        await tx`update auth.users set disabled_at = null where id = ${L.dis}`;
        await tx`insert into workspace_users (workspace_id, login_id, moderator)
                 values (${adminWs}, ${L.mem}, true)`;
        return drift(tx);
      }),
    ).toBe(1);
  });

  it('catalog: no role but a superuser, the runtime role and the owner role may EXECUTE a login fact; the runtime role runs the four it calls', async () => {
    const facts = [
      'public.mantle_area_rule(uuid,text)',
      'public.mantle_login_areas(uuid)',
      'public.mantle_login_is_admin(uuid)',
      'public.mantle_role_drift()',
      'public.mantle_login_area(uuid,text)',
    ];
    // Every role in the cluster that is not a superuser, the runtime role,
    // the owner role or the public demo's reader (it runs the app's system
    // pool there: 0306 grants it the three facts the app reads): the viewer
    // roles, the write role, the gap writer, mantle_system, any login a
    // later step adds. PUBLIC as well.
    const rows = await sql<{ fn: string; definer: boolean; pub: boolean; may: string[] }[]>`
      select f.fn, p.prosecdef as definer,
             has_function_privilege('public', p.oid, 'EXECUTE') as pub,
             array(select r.rolname::text from pg_roles r
                    where not r.rolsuper and r.rolname <> all (${[RUNTIME_ROLE, OWNER_ROLE, 'demo_reader']}::text[])
                      and has_function_privilege(r.oid, p.oid, 'EXECUTE')
                    order by 1) as may
        from unnest(${facts}::text[]) f(fn) join pg_proc p on p.oid = to_regprocedure(f.fn)`;
    expect(rows.map((r) => r.fn).sort()).toEqual([...facts].sort());
    expect(rows.filter((r) => !r.definer || r.pub || r.may.length)).toEqual([]);
    // The roles the cell is about are there to ask (the access matrix and
    // migrate made them): a viewer role, the write role, the gap writer,
    // and mantle_system where the runtime roles are made.
    const [v] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_roles where rolname like 'mantle\\_view\\_%'`;
    expect(v!.n).toBeGreaterThan(0);
    const named = await sql<{ rolname: string }[]>`
      select rolname::text as rolname from pg_roles
       where not rolsuper and rolname = any (${[WRITE_ROLE, GAP_WRITER_ROLE, SYSTEM_ROLE]}::text[])
       order by 1`;
    const hasRuntime = (
      await sql<{ on: boolean }[]>`
      select to_regrole(${RUNTIME_ROLE}) is not null as on`
    )[0]!.on;
    expect(named.map((r) => r.rolname)).toEqual(
      [GAP_WRITER_ROLE, WRITE_ROLE, ...(hasRuntime ? [SYSTEM_ROLE] : [])].sort(),
    );
    const [rt] = await sql<{ on: boolean }[]>`select to_regrole(${RUNTIME_ROLE}) is not null as on`;
    if (rt!.on) {
      const grants = await sql<{ fn: string; ok: boolean }[]>`
        select f.fn, has_function_privilege(${RUNTIME_ROLE}, to_regprocedure(f.fn), 'EXECUTE') as ok
          from unnest(${facts}::text[]) f(fn)`;
      expect(Object.fromEntries(grants.map((g) => [g.fn, g.ok]))).toEqual(
        Object.fromEntries(facts.map((fn) => [fn, fn !== 'public.mantle_login_area(uuid,text)'])),
      );
    }
  });
});

describe.skipIf(!URL)('a database at main`s last migration runs 0304 and only it', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let sql: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await sql`create schema if not exists "drizzle"`;
    await sql`create table if not exists "drizzle"."__drizzle_migrations" (
                id serial primary key, hash text not null, created_at bigint)`;
    for (const mg of all.slice(0, at)) {
      await sql`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
                values (${mg.hash}, ${mg.folderMillis})`;
    }
  }, 300_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('the runner applies 0304 and only it', async () => {
    const fn = async () =>
      (
        await sql<
          { n: number }[]
        >`select count(*)::int as n from pg_proc where proname = 'mantle_role_drift'`
      )[0]!.n;
    expect(await fn()).toBe(0);
    const out = { lines: [] as string[], warnings: [] as string[] };
    // The journal up to 0304: a later migration is not this proof's.
    const applied = await applyJournal(sql, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(applied).toBe(1);
    expect(out.warnings).toEqual([]);
    expect(await fn()).toBe(1);
  }, 120_000);
});
