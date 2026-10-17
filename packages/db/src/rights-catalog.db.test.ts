/**
 * The scoreboard reads the SQL functions from the migrations, with no
 * database (eslint-rules/rights-counts.mjs migrationFunctions). This proves
 * that reading equals the live catalog after migrate: the same writers of
 * the four workspace tables (definer or not), the same functions reading
 * the 'areas' limits, the same set-the-assistant copies, and the same
 * functions overall. A migration shape the reader misses fails here, not
 * as a wrong pin.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/rights-catalog.db.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

type Fn = { schema: string; name: string; definer: boolean; body: string };
type Counts = {
  migrationFunctions(root: string): Fn[];
  writesWorkspaceTable(body: string): boolean;
  readsAreaLimits(body: string): boolean;
  isSetAssistantFn(name: string): boolean;
};

describe.skipIf(!URL)('the scoreboard reads the live catalog from the migrations', () => {
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
      select n.nspname as schema, p.proname as name, p.prosecdef as definer, p.prosrc as body
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

  const names = (fns: Fn[], keep: (f: Fn) => boolean, show = (f: Fn) => f.name) =>
    fns.filter(keep).map(show).sort();

  it('finds the same functions', () => {
    expect(live.length).toBeGreaterThan(100);
    expect(names(read, () => true)).toEqual(names(live, () => true));
  });

  it('finds the same writers of the four workspace tables, definer or not', () => {
    const show = (f: Fn) => `${f.name} ${f.definer ? 'definer' : 'invoker'}`;
    const want = names(live, (f) => counts.writesWorkspaceTable(f.body), show);
    expect(want.length).toBeGreaterThan(0);
    expect(names(read, (f) => counts.writesWorkspaceTable(f.body), show)).toEqual(want);
  });

  it("finds the same functions reading the 'areas' limits", () => {
    const want = names(live, (f) => counts.readsAreaLimits(f.body));
    expect(want).toContain('mantle_scope_has_area');
    expect(names(read, (f) => counts.readsAreaLimits(f.body))).toEqual(want);
  });

  it('finds the same set-the-assistant functions', () => {
    expect(names(read, (f) => counts.isSetAssistantFn(f.name))).toEqual(
      names(live, (f) => counts.isSetAssistantFn(f.name)),
    );
  });
});
