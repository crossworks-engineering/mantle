/**
 * Apply Mantle's Drizzle migrations to Postgres.
 *
 * Extensions (ltree, pg_trgm, pgcrypto, uuid-ossp, vector) are installed by
 * infra/postgres/init/01-extensions.sql at first container boot; the `auth`
 * schema by 02-auth-schema.sql.
 *
 * Env loading is handled by Node's `--env-file-if-exists=.env.local` in
 * `package.json`; this script just trusts `process.env`.
 *
 * ── Why a custom runner instead of drizzle's `migrate()` ──────────────────────
 * drizzle-orm's postgres-js migrator wraps the ENTIRE batch of pending
 * migrations in ONE transaction. That breaks a from-scratch replay whenever one
 * migration does `ALTER TYPE … ADD VALUE` and a *later* migration uses that
 * value: Postgres forbids using a new enum value in the same transaction it was
 * added (error 55P04), and a single-transaction run puts the add + the use in
 * the same transaction. We have a dozen such enum-adding migrations (0008, 0017,
 * 0028…0069), so a brand-new DB could never replay 0001→latest in one pass —
 * only the incremental path worked, because each migration historically
 * committed in its own past `migrate` run.
 *
 * This runner instead applies **each migration in its own transaction**,
 * committing between them — exactly the granularity the incremental path always
 * had, just done in one invocation. So enum values added in migration N are
 * committed before migration M>N uses them. Everything else is identical to
 * drizzle's migrator:
 *   - same ledger table `drizzle.__drizzle_migrations` (id serial, hash, created_at),
 *   - same gating: apply migrations whose journal `when` (folderMillis) is
 *     greater than the max recorded `created_at` (the high-water mark),
 *     except that a gap is never skipped silently (below),
 *   - same file parsing via drizzle's `readMigrationFiles` (statement-breakpoint
 *     splitting + the same hash), so the ledger stays byte-compatible with
 *     anything drizzle wrote before.
 *
 * Trade-off: we lose whole-batch atomicity (a failure mid-batch leaves earlier
 * migrations applied). That's the standard behaviour of most migration tools
 * (Rails, Flyway, golang-migrate) and is strictly better for resumability — the
 * next run picks up where it left off. No migration here relies on cross-
 * migration atomicity, and none uses a non-transactional statement
 * (CONCURRENTLY / VACUUM — verified absent). An index a live table must gain
 * without blocking writes is built CONCURRENTLY after the migrations
 * (concurrent-indexes.ts).
 *
 * ── A migration below the high-water mark (arch A6 fix round 1, H1) ──────────
 * drizzle's gating skips any entry whose `when` is at or below the highest
 * applied one, so an entry that was never applied but sits below the mark
 * (a lower number merged after a higher one, or a `when` stamped too low)
 * would be skipped on this database for ever, with "Already up to date".
 * The runner reads the whole ledger and finds such an entry (by its `when`
 * and its hash; migrate-plan.ts):
 *   - numbered 0290 or later: REFUSED. Nothing is applied, the run fails
 *     (exit 1) naming each missing migration, before any later one runs over
 *     a schema that lacks it;
 *   - older: a loud WARNING and the run goes on. Some boxes carry historic
 *     gaps (an entry re-stamped or edited long ago) and must keep rolling.
 * The ledger and apply loop live in migrate-runner.ts (applyJournal), so a
 * database test runs the real one (migrate-runner.db.test.ts).
 */
import { readFileSync } from 'node:fs';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';
import { bootSmokeExit, env, feature, isBootSmoke, isProduction } from '@mantle/config';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';
import { CONCURRENT_INDEXES, ensureConcurrentIndexes } from './concurrent-indexes';
import { afterMigrations, beforeMigrations } from './migrator-steps';
import { raiseCheckFloor } from './check-floor';

async function main() {
  // Boot smoke (scripts/boot-smoke.mjs): imports linked; exit 0 before any I/O.
  if (isBootSmoke()) await bootSmokeExit('migrate');
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  const sql = postgres(url, { max: 1, prepare: false });
  console.log('Applying migrations to', url.replace(/:[^@]+@/, ':***@'));

  try {
    const migrations = readMigrationFiles({ migrationsFolder: './migrations' });

    // The viewer LOGIN roles and the runtime roles (arch A9) first:
    // migrations grant to them and name them in row level policies, and
    // roles are cluster objects a restore does not bring back. Idempotent;
    // also re-derives the passwords from the key (migrator-steps.ts).
    const runtime = await beforeMigrations(
      sql,
      env('MANTLE_MASTER_KEY') ?? null,
      feature('viewerRolesPerDatabase'),
      feature('dbRuntimeRole'),
    );

    const journal = (
      JSON.parse(readFileSync('./migrations/meta/_journal.json', 'utf8')) as {
        entries: JournalEntry[];
      }
    ).entries;
    // Refuses (throws, nothing applied) a never-applied entry from 0290 on
    // below the high-water mark; warns on an older one (see the header).
    const applied = await applyJournal(sql, migrations, journal);

    console.log(applied === 0 ? 'Already up to date.' : `Done — applied ${applied} migration(s).`);

    // The access matrix's grants, the tables handed to mantle_owner, the
    // runtime role's rights and ts_match_vq LEAKPROOF (migrator-steps.ts).
    // Before the speed-only steps below: nothing of theirs may stand in
    // their way.
    await afterMigrations(sql, runtime);

    // The checks' floor (0298, check-floor.ts): a box below on with no
    // recorded lowering (a new database, a restore, a bare ALTER DATABASE)
    // is raised to on; one an operator lowered with a reason is left, with
    // a warning. Never fatal. A box only (the image's NODE_ENV): a test or
    // development database keeps the mode its run sets (CI migrates the
    // database its suites switch themselves).
    if (isProduction()) await raiseCheckFloor(sql, { info: console.log, warn: console.warn });

    // Indexes built CONCURRENTLY, outside any transaction (workspaces W3).
    // Last, bounded, and never fatal: an index here is speed only, so a
    // build that waits on a lock or runs long is given up (and its INVALID
    // leftover dropped) with a warning, and the next run tries again.
    for (const [name, outcome] of Object.entries(
      await ensureConcurrentIndexes(sql, CONCURRENT_INDEXES, {
        onError: (ix, err) =>
          console.warn(`  WARNING index ${ix} not built (speed only; next run retries):`, err),
      }),
    )) {
      if (outcome !== 'present' && outcome !== 'failed')
        console.log(`  index ${name}: ${outcome} concurrently`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
