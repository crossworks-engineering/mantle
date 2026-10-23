/**
 * The ledger part of migrate.ts (arch A6 fix round 1, H1): read the ledger,
 * plan the run (migrate-plan.ts), refuse a gap from 0290 on, warn on an
 * older one, then apply each pending migration in its own transaction and
 * record it. Apart from migrate.ts so a database test runs the real thing
 * (migrate-runner.db.test.ts).
 */
import type postgres from 'postgres';
import { headsBypassesIn } from './heads-bypass';
import { assertNoIdentityLeaks } from './identity-gateway';
import { applyNarrowWouldRefuse, dropNarrowWouldRefuse } from './runtime-role';
import {
  gapRefusal,
  gapWarning,
  planMigrations,
  type JournalEntry,
  type MigrationGap,
} from './migrate-plan';

/** A migration as drizzle's readMigrationFiles returns it. */
export type RunnerMigration = { folderMillis: number; hash: string; sql: string[] };

export type RunnerLog = { log: (line: string) => void; warn: (line: string) => void };

/** A run refused for a gap (migrate.ts exits non-zero on it). */
export class MigrationGapError extends Error {
  readonly gaps: readonly MigrationGap[];
  constructor(gaps: readonly MigrationGap[]) {
    super(gapRefusal(gaps));
    this.name = 'MigrationGapError';
    this.gaps = gaps;
  }
}

/** Apply what the ledger lacks; returns how many were applied. Throws
 *  MigrationGapError, before applying anything, on a refused gap. */
export async function applyJournal(
  sql: postgres.Sql,
  migrations: readonly RunnerMigration[],
  journal: readonly JournalEntry[],
  out: RunnerLog = { log: console.log, warn: console.warn },
): Promise<number> {
  await sql`create schema if not exists "drizzle"`;
  await sql`
    create table if not exists "drizzle"."__drizzle_migrations" (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `;
  const ledger = await sql<{ hash: string; created_at: string | null }[]>`
    select hash, created_at from "drizzle"."__drizzle_migrations"
  `;
  const plan = planMigrations(migrations, journal, ledger);
  if (plan.gaps.some((g) => g.refused)) throw new MigrationGapError(plan.gaps);
  for (const g of plan.gaps) out.warn(gapWarning(g));

  // The would-refuse count's derived triggers (runtime-role.ts) hold the
  // columns they watch: a migration that drops or retypes one would fail
  // on every migrated box (a fresh one has none, so CI would stay green).
  // Dropped before the first pending migration; afterMigrations makes them
  // again from the grants. If a migration fails, they are made again here
  // (best effort) so the count does not go blind until the next migrate.
  const dropped = plan.pending.length > 0 ? await dropNarrowWouldRefuse(sql) : 0;
  try {
    return await applyPending(sql, plan.pending, out);
  } catch (err) {
    if (dropped > 0) {
      try {
        await applyNarrowWouldRefuse(sql);
      } catch (again) {
        out.warn(
          `  WARNING the narrow would-refuse triggers not made again after the failed migration (the next migrate makes them): ${String(again)}`,
        );
      }
    }
    throw err;
  }
}

async function applyPending(
  sql: postgres.Sql,
  pending: readonly RunnerMigration[],
  out: RunnerLog,
): Promise<number> {
  let applied = 0;
  for (const migration of pending) {
    // Each migration in its OWN transaction (see migrate.ts's header).
    await sql.begin(async (tx) => {
      // Arch A2a: a migration's writes run as system(migration).
      await tx`select set_config('mantle.actor', 'system:migration', true),
                      set_config('mantle.write_mode', 'rw', true)`;
      for (const stmt of migration.sql) {
        await tx.unsafe(stmt);
      }
      // The identity gateway's catalog check (0322) before the commit: a
      // migration that leaves a read of an identity setting outside the
      // readers fails, and its transaction leaves nothing (afterMigrations
      // checks again after the grants, for what no migration made).
      await assertNoIdentityLeaks(tx as unknown as postgres.Sql);
      await tx`
        insert into "drizzle"."__drizzle_migrations" ("hash", "created_at")
        values (${migration.hash}, ${migration.folderMillis})
      `;
    });
    applied += 1;
    out.log(`  ✓ ${migration.folderMillis} (${migration.sql.length} statement(s))`);
    // A named heads-check bypass (0244) shows here as well as in the log.
    for (const name of headsBypassesIn(migration.sql)) {
      out.log(`    heads check bypassed by name: ${name}`);
    }
  }
  return applied;
}
