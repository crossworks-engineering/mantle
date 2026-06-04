# @mantle/db

Drizzle schema, hand-written SQL migrations, and the singleton DB client.

## Day-to-day

```bash
pnpm db:migrate     # apply migrations to $DATABASE_URL (idempotent)
pnpm db:studio      # drizzle-kit table browser
pnpm test           # run the cross-package vitest suite from the repo root
```

## Why migrations are hand-written

We deliberately do **not** use `drizzle-kit generate`. The schema in this
package leans on Postgres features Drizzle's generator can't emit:

- `GENERATED ALWAYS AS ... STORED` columns (`nodes.search_tsv`)
- Operator-class indexes (`gist(path)`, `ivfflat(embedding)`)
- Partial unique indexes (`(owner_id, path) where type = 'branch'`)
- Cross-schema foreign keys (`auth.users(id)`)
- pgvector / ltree / tsvector custom types

Generated migrations would silently drop or mangle these. Instead, every
migration in `migrations/*.sql` is hand-written with full intent, and the
TS schema in `src/schema/` is updated alongside to keep application-side
types in sync. The two are kept consistent by review, not tooling.

The `meta/_journal.json` file exists because the migrator reads it to know
which migrations to apply. The corresponding empty `meta/0000_snapshot.json`
is intentional: nothing diffs against it.

## How migrations are applied (custom runner)

`src/migrate.ts` is a **custom runner**, not drizzle's `migrate()`. drizzle's
postgres-js migrator wraps the *entire* pending batch in **one** transaction,
which makes a from-scratch replay impossible whenever one migration does
`ALTER TYPE … ADD VALUE` and a *later* migration uses that value — Postgres
forbids using a new enum value in the same transaction it was added (error
`55P04`). With ~12 enum-adding migrations, only the incremental path ever worked
under drizzle's migrator.

Our runner applies **each migration in its own transaction**, committing between
them — the same granularity the incremental path always had. It stays
byte-compatible with drizzle's ledger: same `drizzle.__drizzle_migrations` table,
same `created_at` (journal `when`) gating, same `readMigrationFiles` parsing and
hash. Trade-off: no whole-batch atomicity (a mid-batch failure leaves earlier
migrations applied) — standard for migration tools and better for resumability.
**A fresh DB now replays `0001 → latest` in one pass.**

Constraints this implies for new migrations:

- **Never add an enum value and use it in the *same* migration file** (still one
  transaction → still `55P04`). Put `ALTER TYPE … ADD VALUE` in its own file and
  use it in a later one (see `0017`, `0075`).
- **No non-transactional statements** (`CREATE INDEX CONCURRENTLY`, `VACUUM`) —
  none exist today; adding one would need a different approach.

## Adding a migration

1. Edit the relevant `src/schema/*.ts` file so application types reflect
   the new shape.
2. Hand-write `migrations/NNNN_<description>.sql` with the DDL.
3. Add a journal entry in `migrations/meta/_journal.json`:
   ```json
   { "idx": N, "version": "7", "when": <epoch_ms>, "tag": "NNNN_<description>", "breakpoints": false }
   ```
4. `pnpm db:migrate` — applies pending migrations (each in its own transaction;
   idempotent). For a structural change, also verify a **from-scratch replay**:
   create a throwaway DB, run the extension + auth init SQL, then `migrate`
   against it and confirm it reaches your new migration. (If you added an enum
   value, keep the `ADD VALUE` in its own file — see "How migrations are applied".)
5. Spot-check both sides against the live DB (`docker exec ... psql ...`).

## Source-of-truth contract

- **`src/schema/*.ts`** is the source of truth for *application* code
  (autocomplete, type-safe queries, `$inferSelect`/`$inferInsert`).
- **`migrations/*.sql`** is the source of truth for *the database*.

A drift between the two is a real bug; catching it currently relies on
TS compile-time errors when a query references a missing/wrong field.
A future improvement: a CI check that diffs `drizzle-kit pull`'s output
against the hand-written schema.
