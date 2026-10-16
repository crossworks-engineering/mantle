/**
 * The checks' floor runs on a box that rolled main v0.300.82 (F4) first
 * (the pre-check removal's merge of F4). The floor was written as 0298 with
 * the `when` main's 0298 (F4's Admin users ticked) took, and the runner
 * treats a ledger row with the same `when` as applied (migrate-plan.ts): a
 * box at main's 0300 would have skipped the floor SILENTLY, no gap, no
 * warning. Renumbered to 0301, stamped one minute above 0300.
 *
 * A database at main's 0300 (the migrations before 0301 applied and in the
 * ledger, as main's runner leaves it), then the real runner (applyJournal)
 * over the real migration files and journal: it applies 0301 and nothing
 * else, and the floor's functions are there.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/check-floor-renumber.db.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import { planMigrations, type JournalEntry } from './migrate-plan';
import { createScratchDatabaseBefore } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');
const FLOOR = '0301_check_mode_floor';

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === FLOOR);

describe('the floor is 0301, stamped above 0300 (no `when` clash)', () => {
  it('sits right after main 0300, its `when` strictly above', () => {
    expect(at).toBeGreaterThan(0);
    expect(journal[at - 1]!.tag).toBe('0300_f4_brain_wide_answers');
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
  });

  it('a `when` clash would skip it silently (why the renumber matters)', () => {
    const migrations = journal.slice(0, at + 1).map((e) => ({ folderMillis: e.when, hash: e.tag }));
    const ledger = journal.slice(0, at).map((e) => ({ hash: `main-${e.tag}`, created_at: e.when }));
    // As stamped: pending.
    expect(planMigrations(migrations, journal, ledger).pending.map((m) => m.hash)).toEqual([FLOOR]);
    // Stamped with 0300's `when` (the clash the old 0298 had with main's
    // 0298): no pending, no gap, nothing said.
    const clash = migrations.map((m, i) =>
      i === at ? { ...m, folderMillis: journal[at - 1]!.when } : m,
    );
    const plan = planMigrations(clash, journal, ledger);
    expect(plan.pending).toEqual([]);
    expect(plan.gaps).toEqual([]);
  });
});

describe.skipIf(!URL)('a database at main 0300 runs the floor (0301)', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>>;
  let sql: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, FLOOR);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    // The ledger main's runner leaves: every migration before 0301.
    await sql`create schema if not exists "drizzle"`;
    await sql`create table if not exists "drizzle"."__drizzle_migrations" (
                id serial primary key, hash text not null, created_at bigint)`;
    for (const m of all.slice(0, at)) {
      await sql`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
                values (${m.hash}, ${m.folderMillis})`;
    }
  }, 300_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('the runner applies 0301 and only it', async () => {
    const fn = async () =>
      (
        await sql<
          { n: number }[]
        >`select count(*)::int as n from pg_proc where proname = 'mantle_check_lowered'`
      )[0]!.n;
    expect(await fn()).toBe(0);
    const out = { lines: [] as string[], warnings: [] as string[] };
    const applied = await applyJournal(sql, all, journal, {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(applied).toBe(1);
    expect(out.warnings).toEqual([]);
    expect(out.lines[0]).toContain(String(journal[at]!.when));
    expect(await fn()).toBe(1);
    const [last] = await sql<{ w: string }[]>`
      select max(created_at)::text as w from "drizzle"."__drizzle_migrations"`;
    expect(Number(last!.w)).toBe(journal[at]!.when);
    // And again: nothing left.
    expect(await applyJournal(sql, all, journal, { log: () => {}, warn: () => {} })).toBe(0);
  }, 120_000);
});
