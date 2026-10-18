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
    expect(want).toContain('mantle_login_is_admin_user');
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
    expect(both).toEqual(names(live, (f) => counts.readsLoginRole(f.body)));
  });

  it('leaves out a role of something else', () => {
    expect(counts.readsLoginRole(`select a.role from agents a`)).toBe(false);
    expect(counts.readsLoginRole(`perform set_config('role', 'x', true)`)).toBe(false);
    expect(counts.readsLoginRole(`-- auth.users u ... u.role\nselect 1`)).toBe(false);
    expect(counts.readsLoginRole(`select u."role" from "auth"."users" as u`)).toBe(true);
  });
});
