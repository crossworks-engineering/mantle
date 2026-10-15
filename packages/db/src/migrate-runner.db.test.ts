/**
 * The migration runner's ledger loop (migrate-runner.ts, applyJournal) on a
 * real Postgres (arch A6 fix round 1, H1): a migration that was never
 * applied but sits below the highest applied one is refused from 0290 on
 * (nothing applied, the run fails naming it) and only warned about below.
 *
 * Synthetic migrations (each makes one table) on an empty scratch database
 * of its own, so the real ledger, the real transactions and the real gate
 * run, and nothing of the brain's schema is touched.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/migrate-runner.db.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { applyJournal, MigrationGapError, type RunnerMigration } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';
import { createEmptyScratchDatabase } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Migration `idx`, stamped `when`: it makes table t<idx>. */
const m = (idx: number, when: number): { e: JournalEntry; mig: RunnerMigration } => ({
  e: { idx, tag: `${String(idx).padStart(4, '0')}_t${idx}`, when },
  mig: { folderMillis: when, hash: `hash-${idx}`, sql: [`create table "t${idx}" (id int)`] },
});

describe.skipIf(!URL)(
  'the migration runner refuses a gap from 0290 on (A6 fix round 1, H1)',
  () => {
    let scratch: Awaited<ReturnType<typeof createEmptyScratchDatabase>> | undefined;
    let sql: ReturnType<typeof postgres>;
    const out = { lines: [] as string[], warnings: [] as string[] };
    const log = {
      log: (l: string) => out.lines.push(l),
      warn: (l: string) => out.warnings.push(l),
    };
    const run = (ms: ReturnType<typeof m>[]) =>
      applyJournal(
        sql,
        ms.map((x) => x.mig),
        ms.map((x) => x.e),
        log,
      );
    const tables = async () =>
      (
        await sql<{ t: string }[]>`select tablename as t from pg_tables
                                  where schemaname = 'public' order by 1`
      ).map((r) => r.t);
    const ledger = async () =>
      (
        await sql<{ w: string }[]>`select created_at::text as w from drizzle.__drizzle_migrations
                                  order by created_at`
      ).map((r) => Number(r.w));

    beforeAll(async () => {
      scratch = await createEmptyScratchDatabase(URL!);
      sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    }, 60_000);

    afterAll(async () => {
      await sql?.end();
      await scratch?.drop();
    });

    const m211 = m(211, 1000);
    const m212 = m(212, 1100);
    const m289 = m(289, 2000);
    const m290 = m(290, 2100);
    const m291 = m(291, 2200);
    const m292 = m(292, 2300);

    it('applies 0289 and 0291 (0290 not merged yet)', async () => {
      expect(await run([m289, m291])).toBe(2);
      expect(await tables()).toEqual(['t289', 't291']);
      expect(await ledger()).toEqual([2000, 2200]);
      expect(out.warnings).toEqual([]);
    });

    it('refuses when 0290 lands below 0291 later: nothing applied, 0290 named', async () => {
      const err = await run([m289, m290, m291, m292]).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MigrationGapError);
      expect((err as Error).message).toContain('0290_t290 (when 2100)');
      expect((err as MigrationGapError).gaps.map((g) => g.idx)).toEqual([290]);
      // Nothing ran: not 0290, and not 0292 above the mark either.
      expect(await tables()).toEqual(['t289', 't291']);
      expect(await ledger()).toEqual([2000, 2200]);
    });

    it('runs on once the operator applied 0290 and recorded it', async () => {
      await sql.begin(async (tx) => {
        await tx.unsafe(m290.mig.sql[0]!);
        await tx`insert into drizzle.__drizzle_migrations (hash, created_at)
               values (${m290.mig.hash}, ${m290.mig.folderMillis})`;
      });
      expect(await run([m289, m290, m291, m292])).toBe(1);
      expect(await tables()).toEqual(['t289', 't290', 't291', 't292']);
    });

    it('only warns on an older gap (below 0290) and applies the rest', async () => {
      out.warnings.length = 0;
      const m293 = m(293, 2400);
      expect(await run([m211, m212, m289, m290, m291, m292, m293])).toBe(1);
      expect(await tables()).toEqual(['t289', 't290', 't291', 't292', 't293']);
      expect(out.warnings).toHaveLength(2);
      expect(out.warnings[0]).toMatch(
        /WARNING migration 0211_t211 \(when 1000\) was never applied/,
      );
      expect(out.warnings[1]).toMatch(
        /WARNING migration 0212_t212 \(when 1100\) was never applied/,
      );
    });

    it('is up to date on a second run, with the same warnings', async () => {
      out.warnings.length = 0;
      expect(await run([m211, m212, m289, m290, m291, m292, m(293, 2400)])).toBe(0);
      expect(out.warnings).toHaveLength(2);
    });
  },
);
