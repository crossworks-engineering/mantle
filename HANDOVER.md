# Session handover — Tables v2.1 (2026-07-15)

**Branch `feat/tables-v2-1`** (worktree `.claude/worktrees/tables-v2-1`), 8
commits on top of `fbf0c1f9` (v0.134.0). **AUDITED 2026-07-15** (3 adversarial
reviewers; all confirmed findings fixed in `ab217903`, suite 2142 green,
typecheck clean). **NOT merged, NOT released** — Jason decides. Dev-brain
running log: task `659f24dd` (full audit report logged there; plan: page
`3db078ab`).

## What this branch delivers

One Mantle **Table = one SQLite workbook = N tabs** (Excel model), with an
embedded **schema layer** and **cross-tab reference columns**.

| Commit | Phase | Summary |
|---|---|---|
| `f2ba59d2` | P3 | Schema layer: `schema` chunk (data dictionary + `table_sql` surface + join edges, `packages/tabledb/src/schema.ts` + extractor), `table_schema` builtin, corpus-map `schemaDigest` (extractor writes `nodes.data.schemaDigest`; renderer in `messages.ts`), grounding-ladder skill update. |
| `b20f0d35` | P1 | Multi-tab engine: `WorkbookDocLike {tabs:[...]}` writes (bare `TableDocLike` = byte-compatible one-tab), multi-tab `shapeHashOf` (tested equal to `shapeHashOfFile`), per-tab reads (`tabId` optional, default first, unknown throws), `readWorkbookDoc`, op `tabId` targeting + `tab_add/rename/reorder/delete`. |
| `5bb1ab40` | P2 | Tab-aware content/tools/routes + **sheet→tab import flip** (×3 sites: `table_from_file`, `maybeAutoTableSpreadsheet`, UI import route — one node per file now). `getTable(tab)` + draft-aware tabs list; `saveTableDraft`/`commitTable` accept `WorkbookDoc`; **`guardSingleTabWrite`** refuses a bare doc against a multi-tab workbook; JSONB mirrors single-tab-only; structural tools moved whole-doc→op path (`editViaOps`); `table_tab_*` tools; `?tab=` on GET/rows routes. |
| `f5870460` | P4 | Reference columns: `ColumnType 'reference'` + `Column.ref {tabId, columnId}`, persisted in `_columns.ref_json` (additive — pre-v2.1 files lazy-`ALTER` on first ops write via `ensureRefColumn`; every `_columns` read went `SELECT *`). Ops validate (same workbook / exists / not formula / not self); Excel semantics (free text, `DANGLING REFS` profile flag, degrade-to-text with values intact); text family for FTS/pushdown/auto-index; `distinctColumnValues` + rows `?distinct=&prefix=`; tools take `reference {tab, column}`; **defensive FTS-shadow drop before column DDL** (pre-existing footgun the new tests exposed). |
| `0a4f3b1e` | P5 | Grid UI: `TabBar` (switch flushes edits; add auto-switches; rename dbl-click/menu; delete falls back to first tab, refuses last), **op-based saves** — `diffTableDocs` (new, `table-model.ts`) turns the grid's whole-doc `onChange` into an op batch with the `if_rev` etag (409 → reload); `hasDraft` tracks server drafts beyond the active tab so Commit lights up after tab ops/imports; `ReferenceCell` combobox (lazy `?distinct=` fetch, typeahead, free text); retype menu excludes `reference`. Legacy JSONB tables keep whole-doc PUT. |
| `d4901190` | P6 | `docs/tables.md` fully rewritten (was pre-v2); user-guide section updated. (`table_authoring` + `tool_grounding` skill bodies updated in P4/P3 — force-sync on version bump.) |

## Verification status

- Suite green at every phase (2118 tests at last full run) + typecheck clean
  across the monorepo. New unit coverage: `multi-tab.test.ts` (17),
  `reference.test.ts` (8), `schema.test.ts` (4), `table-diff.test.ts` (8),
  corpus-map + workbook-normalizer additions.
- **Live browser smoke** on the local clone stack (minted session, port 3400):
  built a 2-tab workbook with a cross-tab reference via the API (one atomic
  9-op batch incl. `tab_add` + reference `column_add`), committed, opened in
  the UI — tab bar renders, switch reloads the grid, reference dropdown
  fetched the source values and a selection landed in the server draft as an
  op (`draft_rev` advanced), add-tab auto-switched, **delete-active-tab bug
  found and fixed** (now falls back to the first tab), zero console errors.
  Smoke table deleted after.
- NOT yet verified live: the extractor path for the schema chunk/digest (needs
  a live worker — same rehearsal-on-dev gate as v2, at release time).

## Audit — DONE (2026-07-15, fixes in `ab217903`)

Three parallel adversarial reviewers over `git diff fbf0c1f9..HEAD`
(concurrency/data-loss, correctness/parity, security); every finding verified
with a concrete trace or engine-level repro before it counted. Full report on
dev-brain task `659f24dd`. Headlines:

- **Security: zero exploitable findings.** All 15 candidates refuted with
  disproving traces (`?distinct=` resolves columnId against the real column
  list + correct LIKE-escape; quoteIdent/physicalName/bind-params cover every
  SQL sink; path segments regex-guarded; owner scoping uniform). The
  draft-ops route's `{op:string}.passthrough()` was replaced with a typed
  per-op zod schema as hardening.
- **Fixed (all verified, all regression-tested):** formula↔stored retype is
  now DDL (was: bricked the workbook file — CRITICAL); diffTableDocs row
  runs applied reversed + top inserts appended (round-trip suite added);
  autosave dropped edits made during the network await, then committed
  without them (snapshot + serialized saves); guardSingleTabWrite/truncation
  guard read published stats and missed draft-only tabs / draft growth;
  `PUT /draft` had no etag (now if_rev + returns draft_rev); whole-doc
  rebuilds renamed the tab to 'Sheet1' (shape-hash flip → spurious
  re-summarize); import into a >10k table 500'd (replace semantics + 400);
  stale `-wal` sidecars swept BEFORE file-replacing renames (corruption
  vector); getTable default-tab payload could span two tabs; tab names
  colliding with engine `t_*`/FTS names aborted writes; property clears
  (width/format/options/formula/ref) never reached the file (null = clear);
  view reordering silently ignored (now falls back).
- **Non-blocking follow-ups** (logged on the task, not fixed): crash window
  between promote's file swap and the PG commit (divergence, no data loss);
  legacy JSONB promote re-takes the lock; per-tab `draft_rev` (two windows on
  different tabs 409 each other); agent tools never pass `ifRev`; retry after
  a PG-commit failure can wedge autosave on a `_rid` PK violation until
  reload; multi-tab reorder leaves the session unsaveable until reload (UX);
  `distinct=` offers `9.0` for numeric sources (cosmetic).

## After the audit (before ship)

1. Merge from the integrator (`/home/jasons/Projects/mantle`, on `main`).
2. Release: **no migration, no compose change** (0120 + `table-dbs` mount
   shipped with v0.134.0); skill bodies force-sync on the version bump.
3. Extractor rehearsal on dev (schema chunk + digest — index-shape change,
   same NATREF/Rea gate discipline as v2).
4. Still pending from v2: roll v0.134.0 to prod/test/DFM (compose refresh —
   NOT tag-only); NATREF holds for the Rea re-validation gate; next release
   runs `retire-table-blobs.ts` (dry-run first).

## Known limitations (deliberate, plan §8)

Row/column drag-reorder isn't expressible as ops (single-tab falls back to a
whole-doc save; multi-tab surfaces the limitation); reference columns aren't
creatable from the grid's retype menu (assistant / `table_column_add` only);
cross-workbook references, FK/row-id mode + lookup columns, and cross-tab
formulas are out of scope.
