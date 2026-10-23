/**
 * The scoreboard reads the SQL readers of auth.users.role from the
 * migrations, with no database (eslint-rules/rights-counts.mjs
 * readsLoginRole over migrationFunctions: sqlRoleReaders). This proves
 * that reading equals the live catalog after migrate: the same functions
 * read the role column, and every live function that names auth.users and
 * a role at all is one the reader catches, so a new way to read the column
 * fails here, not as a wrong pin. Plan v3.2 S8b pins each reader as
 * migration-only or reading the column the membership definers keep exact.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/role-readers-catalog.db.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

type Fn = { schema: string; name: string; body: string };
type Counts = {
  migrationFunctions(root: string): Fn[];
  readsLoginRole(body: string): boolean;
};

/** A body with its SQL comments dropped (the catalog keeps them). */
const code = (body: string) => body.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

describe.skipIf(!URL)('the scoreboard reads the role readers of the live catalog', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let sql: postgres.Sql;
  let counts: Counts;
  let live: Fn[];
  let read: Fn[];

  beforeAll(async () => {
    counts = (await import(join(ROOT, 'eslint-rules/rights-counts.mjs'))) as Counts;
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    // The functions a migration made: in public, none an extension owns.
    live = await sql<Fn[]>`
      select n.nspname as schema, p.proname as name, p.prosrc as body
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and not exists (select 1 from pg_depend d
                          where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                            and d.deptype = 'e')`;
    read = counts.migrationFunctions(ROOT).filter((f) => f.schema === 'public');
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  const names = (fns: Fn[], keep: (f: Fn) => boolean) =>
    fns
      .filter(keep)
      .map((f) => f.name)
      .sort();

  it('finds the same functions reading auth.users.role', () => {
    const want = names(live, (f) => counts.readsLoginRole(f.body));
    expect(want).toContain('mantle_access_keys_seen');
    expect(names(read, (f) => counts.readsLoginRole(f.body))).toEqual(want);
  });

  it('catches every live function naming auth.users and a role', () => {
    // Any spelling: `auth.users`, `"auth"."users"`, then `role` or `"role"`
    // anywhere in the code. A function that names both and is not a reader
    // (the role of something else) would show here and need a look.
    const both = names(
      live,
      (f) => /\bauth"?\s*\.\s*"?users\b/i.test(code(f.body)) && /\brole\b/i.test(code(f.body)),
    );
    // The two membership definers name both as writers of the column (S8b:
    // the role follows Admin membership); they read none of it.
    const WRITERS = ['mantle_ws_add_user', 'mantle_ws_remove_user'];
    for (const w of WRITERS) {
      const f = live.find((x) => x.name === w);
      expect(f, w).toBeDefined();
      expect(counts.readsLoginRole(f!.body), w).toBe(false);
      expect(code(f!.body), w).toMatch(/UPDATE "auth"\."users" SET "role" = '(?:admin|member)'/);
    }
    // The role guard (0330) names both to check the row being written
    // (NEW and OLD), never a stored login's role: it decides who may write.
    const GUARDS = ['mantle_login_role_guard'];
    for (const g of GUARDS) {
      const f = live.find((x) => x.name === g);
      expect(f, g).toBeDefined();
      expect(counts.readsLoginRole(f!.body), g).toBe(false);
      expect(code(f!.body), g).toMatch(/NEW\."role" IS DISTINCT FROM OLD\."role"/);
    }
    expect(both.filter((n) => !WRITERS.includes(n) && !GUARDS.includes(n))).toEqual(
      names(live, (f) => counts.readsLoginRole(f.body)),
    );
  });

  it('each reader is migration-only or reads the column the membership definers keep exact', async () => {
    // Since 0330 the role column is written only by mantle_ws_add_user and
    // mantle_ws_remove_user on the Admin workspace, in the transaction of
    // the membership row, so it equals Admin membership. A reader an app
    // role may EXECUTE is named here with what it reads the column for; a
    // reader no app role may run (the switch's steps, the box count) needs
    // no line. A new reader an app role may run fails here until named.
    const EXACT: Readonly<Record<string, string>> = {
      mantle_access_keys_seen: "shows each key's login role (display): the exact column",
      mantle_client_space_usage: 'counts by role: the exact column',
      mantle_bridge_login:
        "demote only (0330): an older image's demotion writes role member and calls it; the login leaves Admin, never joins it",
      mantle_member_space: "a member's personal space by role: the exact column",
      mantle_role_drift:
        'compares the column with Admin membership, numbers only: the pre-merge and box check that the two agree',
      mantle_space_item_author_role: "an item author's role: the exact column",
      mantle_space_item_client_private: "a client item's privacy by role: the exact column",
      mantle_ws_dry_run: "the switch's dry run (counts by role, writes nothing): the exact column",
      mantle_ws_skip_reason: "the switch's skip reason (counts by role): the exact column",
    };
    const readers = names(live, (f) => counts.readsLoginRole(f.body));
    for (const k of Object.keys(EXACT)) expect(readers, k).toContain(k);
    const appRun = (
      await sql<{ name: string }[]>`
        select distinct p.proname::text as name
          from pg_proc p join pg_roles r on not r.rolsuper and r.rolname <> 'mantle_owner'
                                        and r.rolname <> current_user
         where p.pronamespace = 'public'::regnamespace
           and p.proname = any (${readers}::text[])
           and has_function_privilege(r.oid, p.oid, 'EXECUTE')
         order by 1`
    ).map((x) => x.name);
    expect(appRun.filter((n) => !(n in EXACT))).toEqual([]);
    // The one the membership definers replaced reads no role now; the
    // bridge reads it again only to demote (round 4, M1).
    expect(readers).not.toContain('mantle_login_is_admin_user');
  });

  it('leaves out a role of something else', () => {
    expect(counts.readsLoginRole(`select a.role from agents a`)).toBe(false);
    expect(counts.readsLoginRole(`perform set_config('role', 'x', true)`)).toBe(false);
    expect(counts.readsLoginRole(`-- auth.users u ... u.role\nselect 1`)).toBe(false);
    expect(counts.readsLoginRole(`select u."role" from "auth"."users" as u`)).toBe(true);
  });
});
