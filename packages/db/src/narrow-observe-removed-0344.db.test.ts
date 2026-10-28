/**
 * 0344: the narrow role's report-only branch goes (plan v3.2 S7c), on a
 * database just before it that carries what a box at 0.400.15 carries (a
 * derived would-refuse trigger of each kind, which that release's migrate
 * made):
 *
 *  - the renumber proof: 0344's `when` is above every `when` before it, and
 *    the runner applies 0344 and only it;
 *  - the end state: no report function, no derived trigger, no cascade
 *    trigger, and the holds and rules that stay are there;
 *  - the rollback: rollback/<tag>.revert.sql puts the branch back and takes
 *    0344 off the ledger; a roll forward applies it again.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/narrow-observe-removed-0344.db.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';
import { createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');
const TAG = '0344_narrow_observe_removed';
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

/** The report branch's functions, by signature. */
const GONE = [
  'public.mantle_narrow_report(text,text,uuid)',
  'public.mantle_narrow_counted(text)',
  'public.mantle_narrow_actor(text)',
  'public.mantle_narrow_would_refuse_stmt()',
  'public.mantle_narrow_would_refuse_expected()',
  'public.mantle_narrow_counter_missing()',
  'public.mantle_narrow_cascade_stmt()',
];

/** What the narrow role is held to: stays. */
const KEPT = [
  'public.mantle_narrow_one_way()',
  'public.mantle_narrow_message_guard()',
  'public.mantle_narrow_login_hold()',
  'public.mantle_narrow_token_hold()',
  'public.mantle_narrow_miss_guard()',
  'public.mantle_narrow_login_held(uuid)',
  'public.mantle_narrow_client_held(uuid)',
  'public.mantle_actor_check_stmt()',
];

describe('0344 is stamped above every `when` before it (renumber proof)', () => {
  it('is stamped above every earlier `when`', () => {
    expect(at).toBeGreaterThan(0);
    expect(Math.max(...journal.slice(0, at).map((e) => e.when))).toBeLessThan(journal[at]!.when);
  });

  it('the revert takes this migration off the ledger by its own `when`', () => {
    expect(readFileSync(REVERT, 'utf8')).toContain(
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${journal[at]!.when};`,
    );
  });
});

describe.skipIf(!URL)('0344: a database just before it, and the rollback', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let pg: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  const present = async (sigs: string[]) =>
    (
      await pg<{ sig: string }[]>`
        select s as sig from unnest(${sigs}::text[]) s where to_regprocedure(s) is not null
         order by 1`
    ).map((r) => r.sig);
  const triggers = async () =>
    (
      await pg<{ t: string }[]>`
        select g.tgrelid::regclass::text || ' ' || g.tgname as t from pg_trigger g
         where not g.tgisinternal
           and (g.tgname like 'mantle\\_narrow\\_would\\_refuse\\_%' or g.tgname = 'mantle_narrow_cascade')
         order by 1`
    ).map((r) => r.t);
  const reportCalls = async () =>
    (
      await pg<{ fn: string }[]>`
        select p.proname as fn from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.prosrc ~ 'mantle_narrow_(report|counted|actor)"?\\s*\\('
         order by 1`
    ).map((r) => r.fn);
  const ledger = async () =>
    (
      await pg<{ n: number }[]>`
        select count(*)::int as n from "drizzle"."__drizzle_migrations"
         where created_at = ${journal[at]!.when}`
    )[0]!.n;
  const apply = async () => {
    const out = { lines: [] as string[], warnings: [] as string[] };
    const n = await applyJournal(pg, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(out.warnings).toEqual([]);
    return n;
  };
  // What 0.400.15's migrate made from the grants: one derived trigger of
  // each kind (an UPDATE OF one holds its column).
  const seedDerived = async () => {
    await pg.unsafe(`CREATE TRIGGER "mantle_narrow_would_refuse_ins" AFTER INSERT ON "public"."agents"
      FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_narrow_would_refuse_stmt"()`);
    await pg.unsafe(`CREATE TRIGGER "mantle_narrow_would_refuse_del" AFTER DELETE ON "public"."agents"
      FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_narrow_would_refuse_stmt"()`);
    await pg.unsafe(`CREATE TRIGGER "mantle_narrow_would_refuse_upd" AFTER UPDATE OF "is_owner" ON "auth"."users"
      FOR EACH STATEMENT EXECUTE FUNCTION "public"."mantle_narrow_would_refuse_stmt"()`);
  };

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    pg = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await pg`create schema if not exists "drizzle"`;
    await pg`create table if not exists "drizzle"."__drizzle_migrations" (
               id serial primary key, hash text not null, created_at bigint)`;
    for (const mg of all.slice(0, at)) {
      await pg`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
               values (${mg.hash}, ${mg.folderMillis})`;
    }
  }, 300_000);

  afterAll(async () => {
    await pg?.end();
    await scratch?.drop();
  });

  it('before it: the report branch is there', async () => {
    await seedDerived();
    expect(await present(GONE)).toEqual([...GONE].sort());
    expect(await triggers()).toEqual([
      'agents mantle_narrow_cascade',
      'agents mantle_narrow_would_refuse_del',
      'agents mantle_narrow_would_refuse_ins',
      'auth.users mantle_narrow_cascade',
      'auth.users mantle_narrow_would_refuse_upd',
      'spaces mantle_narrow_cascade',
    ]);
  }, 60_000);

  it('the runner applies 0344 and only it; the branch is gone and the holds stay', async () => {
    expect(await apply()).toBe(1);
    expect(await present(GONE)).toEqual([]);
    expect(await triggers()).toEqual([]);
    expect(await reportCalls()).toEqual([]);
    expect(await present(KEPT)).toEqual([...KEPT].sort());
  }, 120_000);

  it('rollback: the revert puts the branch back and takes 0344 off the ledger; a roll forward applies it again', async () => {
    expect(await ledger()).toBe(1);
    await pg.begin(async (tx) => {
      for (const st of readFileSync(REVERT, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.replace(/^--.*$/gm, '').trim() !== '')) {
        await tx.unsafe(st);
      }
    });
    expect(await ledger()).toBe(0);
    expect(await present(GONE)).toEqual([...GONE].sort());
    expect(await triggers()).toEqual([
      'agents mantle_narrow_cascade',
      'auth.users mantle_narrow_cascade',
      'spaces mantle_narrow_cascade',
    ]);
    expect((await reportCalls()).length).toBeGreaterThan(0);
    await seedDerived();
    expect(await apply()).toBe(1);
    expect(await present(GONE)).toEqual([]);
    expect(await triggers()).toEqual([]);
    expect(await reportCalls()).toEqual([]);
  }, 120_000);
});
