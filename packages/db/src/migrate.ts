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
 *     greater than the max recorded `created_at`,
 *   - same file parsing via drizzle's `readMigrationFiles` (statement-breakpoint
 *     splitting + the same hash), so the ledger stays byte-compatible with
 *     anything drizzle wrote before.
 *
 * Trade-off: we lose whole-batch atomicity (a failure mid-batch leaves earlier
 * migrations applied). That's the standard behaviour of most migration tools
 * (Rails, Flyway, golang-migrate) and is strictly better for resumability — the
 * next run picks up where it left off. No migration here relies on cross-
 * migration atomicity, and none uses a non-transactional statement
 * (CONCURRENTLY / VACUUM — verified absent).
 */
import { readMigrationFiles } from 'drizzle-orm/migrator';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  const sql = postgres(url, { max: 1, prepare: false });
  console.log('Applying migrations to', url.replace(/:[^@]+@/, ':***@'));

  try {
    const migrations = readMigrationFiles({ migrationsFolder: './migrations' });

    await sql`create schema if not exists "drizzle"`;
    await sql`
      create table if not exists "drizzle"."__drizzle_migrations" (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `;
    const last = await sql<{ created_at: string | null }[]>`
      select created_at from "drizzle"."__drizzle_migrations"
      order by created_at desc limit 1
    `;
    const lastWhen = last[0]?.created_at != null ? Number(last[0].created_at) : -1;

    let applied = 0;
    for (const migration of migrations) {
      // `migrations` is sorted ascending by folderMillis; gate on the original
      // high-water mark exactly like drizzle does.
      if (migration.folderMillis <= lastWhen) continue;
      // Each migration in its OWN transaction (see file header).
      await sql.begin(async (tx) => {
        for (const stmt of migration.sql) {
          await tx.unsafe(stmt);
        }
        await tx`
          insert into "drizzle"."__drizzle_migrations" ("hash", "created_at")
          values (${migration.hash}, ${migration.folderMillis})
        `;
      });
      applied += 1;
      console.log(`  ✓ ${migration.folderMillis} (${migration.sql.length} statement(s))`);
    }

    console.log(applied === 0 ? 'Already up to date.' : `Done — applied ${applied} migration(s).`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
