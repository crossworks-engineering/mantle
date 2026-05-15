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

The `meta/_journal.json` file exists because `drizzle-orm`'s migrator
reads it to know which migrations to apply. The corresponding empty
`meta/0000_snapshot.json` is intentional: nothing diffs against it.

## Adding a migration

1. Edit the relevant `src/schema/*.ts` file so application types reflect
   the new shape.
2. Hand-write `migrations/NNNN_<description>.sql` with the DDL.
3. Add a journal entry in `migrations/meta/_journal.json`:
   ```json
   { "idx": N, "version": "7", "when": <epoch_ms>, "tag": "NNNN_<description>", "breakpoints": false }
   ```
4. `pnpm db:migrate` — verify it applies cleanly against a fresh schema.
5. Spot-check both sides against the live DB (`docker exec ... psql ...`).

## Source-of-truth contract

- **`src/schema/*.ts`** is the source of truth for *application* code
  (autocomplete, type-safe queries, `$inferSelect`/`$inferInsert`).
- **`migrations/*.sql`** is the source of truth for *the database*.

A drift between the two is a real bug; catching it currently relies on
TS compile-time errors when a query references a missing/wrong field.
A future improvement: a CI check that diffs `drizzle-kit pull`'s output
against the hand-written schema.
