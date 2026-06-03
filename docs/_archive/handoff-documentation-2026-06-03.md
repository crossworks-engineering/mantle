# Handoff — documentation node type (2026-06-03)

For the next session: the `documentation` feature is **built and merged to `main`**
(commits `c198be5..670ec3b`) but **not yet enabled/run**. This handoff covers the
as-built state and exactly what's needed to extend it to **user-side documentation**.

Durable design rationale lives in the agent-memory note
`project_documentation_feature` and the plan
`~/.claude/plans/humble-sprouting-curry.md`. This file is the operational handover.

## What it is

A `documentation` node type: markdown files on disk (git-followable), synced into
the brain (summary + embedding + heading-chunks), so agents answer "how does the
system work?" with citations. The markdown-on-disk twin of Pages (which is
DB-sidecar JSON). One node per `.md` file; sub-document retrieval via
`content_chunks`.

Re-indexing on edits is cheap by construction — no custom diff: a file-level
`data.sha256` gate skips unchanged files, and the chunk-level embedding cache
(`sha256(model:text)`) makes unchanged chunks free on re-extract. The new piece is
a **boot reconcile** (`reconcileCollection`) — the only indexing path in prod where
docs are immutable/baked-in.

## What's built (map)

- **Schema** — `documentation` in the `node_type` enum (migration 0069);
  `doc_collections` table (0070): `key/label/origin/root_path/brain_depth/enabled`,
  unique `(owner,key)`. Schema: `packages/db/src/schema/doc-collections.ts`.
- **Sync engine** — `packages/files/src/docs.ts`: `docsRoot()`, `collectionRoot()`,
  `ltreeForDocPath()`, `upsertDocFromDisk()` (sha gate + embedding-null + notify),
  `reconcileCollection()` (walk → `diffDocSets()` → upsert/delete; **empty-root
  deletion guard**), `reconcileEnabledCollections()`, `purgeCollection()`,
  `effectiveBrainDepth()`, and the collection registry
  (`ensureDefaultCollections` / `listDocCollections` / `setCollectionEnabled`).
- **Worker** — `apps/web/workers/docs-sync.ts`: boot reconcile + chokidar over the
  roots of ENABLED collections; refreshes the enabled set every 60s (toggles need
  no restart).
- **Extractor** — `apps/agent/src/extractor.ts`: `documentation` in
  `DEFAULT_EXTRACT_TYPES`, an explicit `readNodeBodyRaw` case, and a
  **retrieval-only gate** — `effectiveBrainDepth(type, data.brain_depth)`; when
  `retrieval`, runs L5 (summary/embedding/chunks) but SKIPS L4
  (reconcile_entities / process_relations / facts).
- **Agent** — new in-app `search_chunks` builtin (`packages/tools/src/builtins.ts`);
  `documentation` added to the `search_nodes` + MCP `search` type enums; **Docs**
  delegate agent (`apps/web/scripts/seed-docs.ts`, `pnpm -C apps/web seed:docs`) with
  `search_nodes`/`search_chunks`/`node_read`, wired into responder+assistant
  `delegate_to`.
- **UI** — read-only viewer `/docs` (`apps/web/app/(app)/docs/*`, master-detail,
  ReactMarkdown, `useRealtime(['documentation'])`); opt-in
  `/settings/documentation` (`.../settings/documentation/*`: per-row Switch +
  enable-all/disable-all; disable purges behind an AlertDialog). Nav entries: Docs
  (Workspace) + Documentation (Settings).
- **Config** — `MANTLE_DOCS_ROOT` (=`/app/docs` in compose; set to the repo `docs/`
  in dev `.env.local`); `worker_docs` compose lane (no volume); `docs/` un-ignored
  in `.dockerignore` so it bakes into the image; `docs` dev lane in root
  `package.json` + `worker:docs:dev`.

## Decisions already locked

- **Opt-in per collection.** Nothing indexes until a collection is enabled at
  `/settings/documentation`. The `system` collection ships **disabled**.
- **Retrieval-only by default** (system docs) — keeps system-meta out of the
  personal facts/graph. `brain_depth='full'` runs the complete pipeline.
- **One node per file.** Markdown lives in `nodes.data.content`; identity is
  `(owner, data.collection, data.rel_path)`. `slug` is null (no slug collisions).
- **v1 is read-only** — no in-app editor. Docs are authored as files on disk.

## Extending to user-side documentation — the work

The model **already supports** user docs: `doc_collections.origin='user'`,
`brain_depth='full'` (so the user's own docs DO produce facts/entities — that's
wanted, unlike system-meta), and a per-collection `root_path` (its own disk dir,
separate from `MANTLE_DOCS_ROOT`). The sync engine, extractor, viewer, and settings
page are all collection-generic — a user collection flows through them unchanged and
shows up in `/docs` + `/settings/documentation` automatically.

**The one real gap: there is no way to CREATE a collection yet.**
`ensureDefaultCollections` hardcodes only the `system` row. To add user docs you
need ONE of:
1. A **"New collection" form** on `/settings/documentation` (label + absolute
   `root_path` + `brain_depth` picker) → inserts a `doc_collections` row. Most
   user-friendly; this is the natural next build.
2. A **seed script** (mirror `seed-docs.ts`) that upserts a named user collection.
3. Extend `ensureDefaultCollections` to also seed a `user` collection from an env
   var (e.g. `MANTLE_USER_DOCS_ROOT`).

Decide up front:
- **Disk vs. authored.** If user docs are markdown files the user manages on disk
  (Obsidian/Syncthing/git), the sync engine already covers them — just register the
  collection + point `root_path` at the dir. If they should be **authored/edited
  in-app** (like Pages), that's NEW work (no editor exists for `documentation`;
  round-tripping markdown↔editor losslessly is the fiddly part the v1 plan deferred).
- **brain_depth for user docs** — default `'full'` (the user's facts matter) vs
  `'retrieval'`. The column default is `'retrieval'`; set `'full'` explicitly when
  creating a user collection if you want their docs feeding the graph.
- **Viewer split** — `/docs` currently lists every collection together (grouped by
  collection key). If system vs user docs should be visually separated, that's a
  small viewer change.

## To run / verify (current state)

1. Restart `pnpm dev` (loads `MANTLE_DOCS_ROOT` + the `docs` lane).
2. `pnpm -C apps/web seed:docs` (creates the Docs delegate).
3. `/settings/documentation` → enable **System docs** → reconciles the repo `docs/`.
4. `/docs` renders; ask the assistant "what is Mantle's memory architecture?" → it
   should delegate to Docs and cite a doc.
5. Retrieval-only invariant: `select count(*) from facts f join nodes n on
   n.id=f.source_node_id where n.type='documentation'` → **0**.

## Gotchas

- **`MANTLE_DOCS_ROOT` only feeds the `system` collection** (its `root_path` is
  null → falls back to `docsRoot()`). User collections MUST set their own
  `root_path` (absolute, shared by every process).
- **The `docs-sync` worker must be running** for boot-reconcile + live file
  watching. Enabling a collection in the UI reconciles inline (the server action),
  so it works without the worker — but new files added later won't index until the
  worker runs (or the next enable/reconcile).
- **Empty-root guard**: if a collection's root has zero `.md` files, reconcile skips
  the deletion pass and warns — a misconfigured `root_path` won't wipe an indexed
  collection. (Tested.)
- **One-way disk→DB.** Docs are never written back to disk by the app; the viewer is
  read-only. Editing a doc = editing the file on disk (or `git pull`), then
  reconcile re-indexes only the changed file.
- Verified to date: all packages typecheck, 1160 unit tests (10 new in
  `packages/files/src/docs.test.ts`), sync engine live-tested end-to-end on the dev
  DB (insert/noop/update/delete/empty-guard/purge). The browser UI + a real
  extractor run were left for the opt-in step above.
