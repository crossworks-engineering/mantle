# Session changelog — 2026-06-03 (Tables: a whole new content type)

The session that shipped **Tables** — a typed database-grid content type
(Airtable/Notion-database), built as a deliberate mirror of Pages — then polished
it across a long string of UI refinements, gave it a specialist agent with an
in-editor panel, and fixed two unrelated bugs surfaced along the way. **20
commits on `main`, `624dd30 … 3ad1f03`** (+5400 / −23 across 46 files). All
ff-merged from a worktree; not yet pushed to origin or deployed to the VPS.

**Canonical feature doc:** [`tables.md`](./tables.md) — read that for the
architecture. This is the session diary.

---

## 1. Tables — the feature (Phases A–E, `624dd30`→`3d08a40`)

Why: TipTap (Pages) table cells are free-text — no column types, no totals, no
row addressing. Coercing real data tables out of Pages was a fight. Tables is the
structured-data twin, sharing Pages' tree / search / draft-commit / delegation /
brain-indexing machinery. Decisions locked with Jason up front: **typed grid**
(not rich-text tables), **TanStack Table** UI, **draft/commit parity** with
Pages, and **all four** of totals / xlsx-csv import / filter-sort views /
formulas in v1.

- **A — storage + model + brain** (`624dd30`): `nodes.type='table'` + `tables`
  sidecar (migrations **0067** enum + **0068**); pure `TableDoc` model
  (`table-model.ts` — typed cells, stable row/col ids, aggregates, views, a
  **dependency-free safe formula evaluator** `table-formula.ts`), `table-to-text`
  (markdown render + Totals row), `table-list` (windowed row TOC); CRUD with
  draft/commit (`tables.ts`); extractor reads `tables.data_text`.
- **B — import** (`94a4204`): `parseSheetToGrid` (SheetJS) → typed columns + rows
  per sheet, value-sampled inference, one table per sheet.
- **C — tools + agent** (`27af4c0`): `table_*` builtins (CRUD + windowed
  `table_rows_list` + row/column/cell edits + `table_set_aggregate` + formula
  columns + saved views + `table_from_file`), MCP read-only tools, the
  `table_authoring` skill + the Tables delegate agent wired into `delegate_to`.
- **D — `/tables` UI** (`6d67990`): master-detail list + a TanStack grid editor
  (typed editable cells, column menus, totals footer, draft autosave → Commit
  state machine, spreadsheet Import). `table-model` made a **browser-safe leaf**
  (Web Crypto, no `node:crypto`) so the client reuses the shared ops.
- **E — docs + polish** (`3d08a40`): canonical `tables.md`, formula×aggregate test.

Verified end-to-end during the build: 1143 repo tests green, full typecheck, a
real tool/CRUD/commit smoke (indexed markdown with a Totals row), and a live
browser pass (authed preview, minted session cookie) — which caught a
nested-`<button>` hydration bug in the grid header, fixed before merge.

## 2. Post-build UI refinements (`be03bf8`→`527c735`)

A rapid round of operator feedback, each a small commit:

- **`be03bf8` cell focus** — text/number/url cells churned the whole doc on every
  keystroke (focus loss + per-keystroke draft save), the same jank Pages hit. Now
  they hold **local state and commit on blur/Enter**; columns are memoized on a
  structure key so edits elsewhere never remount the focused cell.
- **`2c01412` selection style** — list rows used `bg-accent` fills; switched to the
  app-wide rule (style §2): left-accent-bar-only selection, neutral
  `hover:bg-muted/50`, matching Notes.
- **`998f964`/`d25857c` readable menus** — the column Type/Total dropdowns hid
  their labels on a saturated accent; selected option now reads in the theme
  `primary`, hover stays neutral, and the Type/Total **sub-trigger** text flips to
  `accent-foreground` (was unreadable white-on-accent).
- **`226907f`/`feb03e2`/`a3c584e` icons** — every Type and Total option got a
  fitting glyph; the header menu trigger now shows the column's **type icon**, and
  an active **Total icon** appears in the header when a column is aggregated.
- **`896ec9d` centered title** — editor header is now `grid-cols-[1fr_auto_1fr]`
  so "All tables" never wraps and the title sits dead-center.
- **`b8e068d` per-table emoji** — a small emoji input (macOS ⌃⌘Space) sets each
  table's icon (the model/API already carried `icon`; this was the missing UI).
- **`f842803` direct open** — dropped the master-detail preview pane; list rows are
  now links straight to the editor (cmd/middle-click → new tab), delete moved to a
  per-row hover button.
- **`527c735`** — list row meta leads with "Updated <date>".

## 3. `table_from_text` — paste → table (`a49cfa8`)

The "build a table from these results" path. `parseTextToGrid`
(`@mantle/files/sheet-to-grid`) detects a markdown pipe table, TSV, or quote-aware
CSV and returns a typed grid; the new `table_from_text` builtin ingests the whole
block in **one call** + creates the indexed table — so the agent no longer adds
rows one-by-one (which hit the per-turn iteration cap on bigger pastes). Skill +
agent prompt updated to prefer it; tests for markdown/TSV/CSV. Smoke-tested.

## 4. "Ledger" — the in-editor assist panel (`4b1a3c4`)

The Pages-style AI panel, for grids. `/tables/[id]` gets an **Assist** toggle that
opens a side panel talking to the Tables specialist about the open grid
(`POST /api/tables/[id]/ai-assist` → `invokeAgent('tables', …)` with the grid
structure preloaded; runs **in the web process**). The agent edits the draft via
the table tools; the panel reloads it live; the header Commit/Discard publish or
revert. Renamed the agent display to **"Ledger"** (slug stays `tables` — do NOT
rename the slug; it breaks `delegate_to` + the route), added a "powerful moves"
section to the skill (formulas / totals / views / re-typing / cleanup / column
splits), and raised its loop ceiling to 30. **Verified with a real agent run:**
asked Ledger to sum a column *and* add a `{Price}*2` formula column — both landed
in the draft.

## 5. Bug fix — the "icon.svg indexed every minute" loop (`7570e44`)

Operator noticed one `icon.svg` re-indexing every ~2 min (**543** `photo_ingest`
traces on one node). Root cause: an image the vision worker can't read (an SVG
vector) made `extractNode` return early after the `photo_ingest` trace **without
recording an `extractor_run`** — and the periodic extract sweep keys its
loop-safety on the presence of an `extractor_run`, so the node (embedding NULL, no
`extractor_run`) was re-queued forever. Fix at the source: record a terminal
`recordSkippedTrace({ kind: 'extractor_run', disposition: 'no_vision_text' })`
before the early return, so the node counts as processed and drops out of the
sweep — **self-healing** for any already-stuck node on its next cycle. Cleaned up
the stray `icon.svg` (disk + node + 545 traces).

**Durable lesson:** the sweep's "processed" invariant must hold for *every*
terminal extraction path. An image/PDF branch that records only `photo_ingest`
and returns — without an `extractor_run` — is invisible to the sweep's
loop-guard. Any new early-return in `extractNode` must leave a terminal
`extractor_run` (success or skip).

## 6. Bug fix — Turbopack/webpack config warning (`3ad1f03`)

`next dev --turbo` warned "Webpack is configured while Turbopack is not." The
`webpack()` hook in `next.config.ts` externalizes the native `@napi-rs/canvas`
binding and is needed only for the production `next build` (webpack). Now gated on
`process.env.TURBOPACK` (set under `--turbo`, unset for `next build`): the hook is
attached only for the webpack build, so dev is warning-free and prod still
externalizes the binding. Safe in the prod direction — `next build` never sets
`TURBOPACK`, so the externals can't be skipped.

---

## State at session end
- **Tables is live on dev** (web HMR has all of it). The **Ledger** agent +
  `table_authoring` skill were (re)seeded on the dev DB through the session, so
  delegation + the assist panel work now. Migrations through **0068** applied.
- **Restarts:** `apps/agent` needs a restart to pick up the extractor sweep fix
  (`7570e44`) and to have the latest `table_*` builtins for the *Saskia-delegation*
  path (the in-editor panel runs in `web`, already current). `next dev` needs a
  restart for the `next.config` change (`3ad1f03`).
- **Not pushed / not deployed:** all 20 commits are on local `main` only — not
  pushed to origin, not on the Contabo VPS. Prod deploy of Tables (incl. migrations
  0067/0068) is a future step via `update-prod.md`.

## Still open / next
- **Tables deferred (not v1):** public sharing (`/s/[token]` + `renderTableDoc`),
  row drag-reorder, cross-table relations/rollups, real-time multi-cell collab.
- CSV/markdown/text imports infer `true`/`false` as **text** (no real types) —
  xlsx booleans infer as checkbox; retype in the UI when needed.
- Stray `probe-sample-*.svg` / `probe-notes-*.txt` residue from the removed
  integrity probe still sits in `data/files/` root (not churning) — optional tidy.
