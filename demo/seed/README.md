# demo/seed — turning the manifest into a brain

```sh
demo/scripts/seed.sh          # stack → migrate → generate → seed → verify
demo/scripts/seed.sh --keep   # seed into the existing demo brain (no wipe)
```

One command, on purpose: the refresh plan depends on a re-seed being a cron
job rather than an afternoon. A manual re-seed happens twice and then never —
which is how v1 died.

## What runs where

| step | how |
|---|---|
| infra | `demo/scripts/stack-up.sh` — the isolated demo stack |
| schema | `pnpm --filter @mantle/db migrate` + `pgboss:init` |
| content | `demo/generator/gen.mjs` → `out/manifest.json` + real file bytes |
| guard | `demo/generator/guard.mjs` — blocks on any finding |
| bootstrap | real signup → saveKey → provision → finish |
| creation | HTTP POSTs to the same endpoints the UI calls |
| extraction | **server/api** — the `node_ingested` listener, not this script |
| assertions | `verify.ts` — waits for the queue, then checks the minimums |

## Seeding one kind at a time

```sh
DEMO_SEED_ONLY=tables,draws demo/scripts/seed.sh --keep
```

`DEMO_SEED_ONLY` names the kinds to seed into an EXISTING brain
(`contacts`, `simple`, `pages`, `recall` = the Recall map's pages only,
`tables`, `oddments`, `heartbeats`, `draws`, `docs`, `files`, `emails`). It
exists for iterating on one content type without a wipe-and-refill; it does
not reconcile, so running it twice adds the kind twice. The full seed is
still one command.

## Tables travel as a grid and land as a document

The generator writes tables the way a person would: column names, positional
rows, aggregates and views keyed by column NAME (`GenTable` in
`lib/types.ts`). The app stores a `TableDoc`: columns with ids, rows as
`{id, cells: {<columnId>: value}}`, select options as `{id, label}` with the
cell holding the label, aggregates and views keyed by column id, formula
cells never stored. `tableDocFromGen` in `seed.ts` does that translation
once, before the POST. Until 2026-09-17 the grid was posted as-is and
`ensureTableDoc`, tolerant by design, kept every row with an empty cells
map — eleven tables with columns and no data, on the public demo. A date
cell is a day offset like every other date here; the seeder resolves it.

## Real product paths, and the two deliberate exceptions

Content is created over the HTTP API, and markdown becomes ProseMirror through
the app's own `markdownToDoc`. Pages are emitted parents-first so the sub-page
tree actually forms. Nothing hand-writes a chunk, a fact or an embedding —
those come from the real extractor, which is the whole point.

Two things have no API, and are done in SQL narrowly and on purpose:

**Timestamps.** No create endpoint accepts a historical `created_at`, and a
demo with no history has no story. The manifest carries day *offsets*; the
seeder resolves them against seed time and backdates afterwards. So a fresh
seed always looks current, and "40% of activity in the last 30 days" stays
true whenever it runs.

**Emails.** Mail arrives by IMAP; there is no create endpoint. The seeder
writes the node + `emails` row against a **disabled** demo mailbox that can
never connect anywhere — which is what the sync worker would have produced.

## The safety guard

Seeding writes content and **rewrites timestamps**, so pointing it at a real
brain would be destructive. `assertDemoDatabase` refuses to run unless the
target is either on the demo stack's port (56432) or carries the
`mantle-demo-brain` comment marker the seeder stamps on success. Any other
target must be empty *and* explicitly `--force`ed.

`seed.sh` also unsets `MANTLE_DETACHED_DEV` / `NEXT_PUBLIC_MANTLE_API_BASE`
and sets `DATABASE_URL` explicitly, so a developer's own `.env.local` — which
may point at a real brain — cannot leak into a seeding run.

It never stops anything. If a `next dev` already holds `server/web` (Next
allows one per project directory, not per port) the script names the process
and exits rather than killing it.

## Extraction needs a model

Chunks and embeddings need the embedder; **summaries, facts and entities need a
chat model**. Without one, content lands but the brain does not — content
present, brain absent, which is exactly v1's failure shape. `verify.ts` says so
in those words when derived data is zero.

Set `DEMO_OPENROUTER_KEY` before seeding to give the extractor a working model.
The bootstrap otherwise saves a placeholder key so onboarding can complete.

## Layer-2 assertions

`verify.ts` waits for the extractor queue to settle, then asserts every
minimum in `demo/world/targets.json` — node counts, emails, and the derived
counts (chunks, facts, entities, edges). Non-zero derived data is the proof
that extraction actually ran. A seed under any minimum exits non-zero: an
under-produced demo should fail in CI, not in public.
