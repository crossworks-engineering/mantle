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
| schema | `pnpm --filter @mantle/db migrate` + `pgboss:init` + `provision` (the DBOS database) + `objectstore:ensure` (the bucket): the root compose's `migrate` step |
| content | `demo/generator/gen.mjs` → `out/manifest.json` + real file bytes |
| guard | `demo/generator/guard.mjs` — blocks on any finding |
| bootstrap | real signup → saveKey → provision → finish |
| creation | HTTP POSTs to the same endpoints the UI calls |
| extraction | **server/api** — the `node_ingested` listener, not this script |
| assertions | `verify.ts` — waits for the queue, then checks the minimums |

## The order, and seeding one kind at a time

`seed.ts` creates in the generator's `CREATE_ORDER`: contacts, files, tables,
drawings, secrets and formulas, apps, pages, notes, then journal, tasks and
events. A page or note may refer to anything created before it (an image in
Files, a table, a drawing), and the generator checks that no reference
points forward. Then the folder shares, then the public links.

```sh
DEMO_SEED_ONLY=recall,heartbeats demo/scripts/seed.sh --keep
```

`DEMO_SEED_ONLY` seeds into an EXISTING brain, and only the kinds nothing else
refers to: `recall` (replaces a map of the same slug), `heartbeats`, `docs`,
`emails`. Everything else comes with the full seed, because pages and notes
point at the files, tables and drawings made before them.

## Folders, and pages that do not nest

Every kind has one folder tree on main (`docs/folder-tree.md`): folders with
an icon and a colour, at most three levels deep, and an item is never a
parent. Pages stopped nesting in v0.232.365 (migration 0210). The manifest
carries `folders` (`GenFolder` in `lib/types.ts`) and each page or note names
its folder in `meta.folder`.

- Folders go first, parents first: `POST /api/tree/:kind/folders` with
  `parentId`, `name`, `icon`, `color`.
- A page is born in its folder (`POST /api/pages` takes `folderId`). A note
  is created and then filed with `POST /api/tree/notes/move`, which is what
  dragging it does.
- A page that used to have sub-pages sits NEXT TO the folder of its own
  name and ends in a Folder index block. The generator names that folder by
  its own id (`[Folder index](folder:gen:<id>)`) and the seeder puts the real
  id in. `[Folder index](folder:here)` lists the page's own folder and needs
  nothing.
- Shares come last. A share that changes who can see items is refused first
  (409 `visibility`, with the list) and goes ahead when the call is repeated
  with `confirm: true` and the count shown. The seeder reads the refusal and
  confirms exactly that count; it never sends a blind confirm.

## The Recall map is native

Page-built Recall maps were retired in v0.232.363: migration 0209 deletes
them, and `scripts/roll.sh` refuses a box that still has one. The manifest
carries `recall_maps` (`GenRecallMap`) and the seeder builds each map through
the owner Recall API (`docs/recall.md`): the map (`POST /api/recall/maps`),
the cards (`POST .../cards`), then the options by card slug (`PUT
.../cards/:slug`), once every target exists. Every write sends the map
`version` and takes the next one from the answer. A prompt card is made with
`prompt: true`; a card that is left waiting is confirmed through `POST
.../cards/:slug/prompt`. The seeder then reads the map back and fails the
seed when a card, an option or the confirmed prompt is missing.

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

## The team is logins, and the chats come after the drain

Main retired the contact team token, the team portal cookie, team links and
the Team Forum (member logins, migrations 0162 to 0178; `docs/member-logins.md`).

| script | when | what it makes |
|---|---|---|
| `enable-team.ts` | `seed.sh` | a member login for each of the owner's colleagues (`POST /api/users`, role `member`); the member chat opened (the `team-responder` agent at team level); one client login for Gordon Bekker |
| `turns.ts` | `turns.sh`, after `drain.sh` | the owner's four real chats |
| `seed-member-chat.ts` | `turns.sh`, after the owner chats | a member (Tessa) asks one question; the brain answers with a real turn |

What the team and the client read is decided by the FOLDER an item sits in:
each workspace's Team and Client folders are shared by `seed.ts`.

Three brain rules shaped it, and the seed follows each one:

- An agent may hold only tool groups at or below its own level. On a fresh
  brain the team responder's groups are all admin level, so the admin-only
  group comes off, the two member-facing groups go to team level, and only
  then does the agent.
- A client login is refused until an admin has acknowledged the list of
  everything clients can read. The script reads the report and acknowledges
  exactly it, by its fingerprint.
- Tasks, events, contacts and secrets are admin-only kinds. They sit in
  project folders, never in a shared one.

A member signs in with the same `mantle_session` cookie as the owner, so one
visitor is one of them, never both. The public demo injects the OWNER's
session: a visitor sees the team from the admin side (the Team screen, the
member chats, what the team reads). Showing a member's own view needs a
second origin that injects a member's session. That is a decision about the
site box, not something the seed can settle.

## What the read-only role still breaks

The serve-time app connects as `demo_reader`, which cannot write. A read
that writes therefore fails only on the demo, and it fails quietly: the page
answers 200 and its data call answers 500. Measured on the bench with main
v0.232.366 (2026-10-01):

| read | as `demo_reader` | why |
|---|---|---|
| `GET /api/tree/files` | 200 | |
| `GET /api/tree/{notes,pages,tables,tasks,recall,apps}` | 500 | `ensureKindRoot` inserts the kind's root folder (`INSERT ... ON CONFLICT DO NOTHING`); Postgres checks the INSERT right before it looks for the row (42501) |
| `GET /api/app-nav` | 500 | the same, through the Apps layout reconcile |
| `GET /api/recall/maps`, `/api/pages`, `/api/notes`, `/api/search`, the team and client screens' reads | 200 | |

On screen: the left tree of Notes, Pages, Tables, Tasks, Recall and Apps
stays on "Loading". The fix belongs on main (skip a refused write, as
`reapAbandonedTraces` and the embedding cache already do), then main is
merged into demo again. `check-readonly.sh` asks for these reads now, so the
gate is red until then. To LOOK at those screens before the fix, a bench can
serve as the owner role: `DEMO_SERVE_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56432/postgres demo/scripts/serve.sh`
(the edge still refuses writes; never on the box).

## Real product paths, and the two deliberate exceptions

Content is created over the HTTP API, and markdown becomes ProseMirror through
the app's own `markdownToDoc`. Folders are created parents first, then the
pages in them. Nothing hand-writes a chunk, a fact or an embedding: those
come from the real extractor, which is the whole point.

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

Set `DEMO_OPENROUTER_KEY` before seeding (or keep the key in the file
`seed.sh` names). It is required: on main, onboarding's `finish` refuses a
brain with no assistant, and Set up cannot make one from a placeholder key.
`seed.sh` stops before it brings the stack up when there is no key.

## Layer-2 assertions

`verify.ts` waits for the extractor queue to settle, then asserts every
minimum in `demo/world/targets.json` — node counts, emails, and the derived
counts (chunks, facts, entities, edges). Non-zero derived data is the proof
that extraction actually ran. A seed under any minimum exits non-zero: an
under-produced demo should fail in CI, not in public.
