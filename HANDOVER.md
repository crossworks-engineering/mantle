# Session handover — Tables v2: sqlite-native storage, P0→P4 + audit (2026-07-15)

> **TL;DR.** The whole Tables v2 plan (`~/.claude/plans/tables-v2-sqlite-native.md`,
> dev-brain file `935d25f7`) is BUILT on branch **`feat/tables-v2`** (worktree
> `.claude/worktrees/tables-v2`): P0 foundations, P1 storage + durability gates,
> P2 intelligence (`table_sql`, profile-only indexing), P3 (draft ops + etag,
> promote-commit, windowed reads, un-split imports), P4 migration machinery —
> then a three-auditor review whose top-3 finding clusters are fixed. 8 commits,
> **NOT merged, NOT released**. Suite 2081 green; everything live-verified on
> the workstation's dev-clone stack, including a real-browser UI smoke.
> Jason decides merge + ship. Full running log: dev-brain task `c381fe96`.

## What this branch delivers

One sqlite file per Table node (`${TABLE_DB_DIR}/<owner>/<node>.sqlite` +
`.draft.sqlite`; compose dual-mounts `table-dbs` into web AND api). The
Postgres `tables` row is the registry + writer-coordination point
(`SELECT … FOR UPDATE` spine). Highlights, in plan order:

- **P0**: node:sqlite capability probes behavior-pinned into vitest, the prod
  image (release.yml runs them INSIDE the built image), api boot, and /debug
  sanity. Migration `0120` (registry columns), from-scratch 0000→0120 replay
  verified. dev:fe needs no proxy (tables surface is fully client-fetched).
  Benchmark: 10k-row draft rebuild = 23ms (no FTS) / 515ms (trigram).
- **P1**: sqlite-first create/import; materializer bridge keeps the UI, all
  21 table tools, and the 3 MCP readers unchanged; JSONB dual-written for
  rollback (`storage_path` NULL = legacy path resumes). Durability gates:
  `mustExist` (missing file = surfaced error, NEVER silently recreated),
  VACUUM INTO snapshots in the scheduled backup + `db-dump.sh`
  (`mantle-table-dbs-*.tgz`), `/debug` sanity `tables.storage` + api-boot
  dual-mount tripwire.
- **P2** (per Jason's signed §12 amendments): **profile-only chunks — no rows
  embedded, ever** (L1 profile + L2 overview; first-200-rows go to `data_text`
  only); `table_sql` builtin (read-only, statement-gated, worker thread + 5s
  watchdog kill, row caps 200/1000); FTS5 trigram shadows on published files
  only; shape-hash gate (cell-only commits reuse the summary — no LLM);
  `tool_grounding` gained "table hit → table_sql" + the identifier-sweep rung.
- **P3**: draft edits are atomic op batches under the lock with a `draft_rev`
  etag (409 on stale); **commit promotes the server draft** (client posts no
  doc — truncation-by-commit structurally impossible); keyset/offset rows
  route; `.sqlite` export; parity-gated SQL pushdown for the read tools;
  **part-splitting is dead** (sheets import whole; explicit-error ceiling
  `TABLE_IMPORT_MAX_ROWS`, default 2M). Big tables render read-only in the
  grid with load-more paging; agent row tools edit at any size.
- **P4**: legacy tables convert lazily (first op/commit) + background sweep in
  the api runtime (5/tick / 5min, `MANTLE_TABLE_MIGRATE_SWEEP_MS`); operator
  scripts `retire-table-blobs.ts` (release N+1, dry-run default) and
  `merge-part-tables.ts` (dry-run default).

## The audit (and what it changed)

Three parallel reviewers (concurrency/data-loss, security, correctness/parity)
→ 19 findings. **Security: no exploitable path** through any route/tool. The
top-3 clusters are fixed in `d741bc5d`:

1. **Commit-promote integrity** — promote now snapshots the draft via
   `VACUUM INTO` (reads through the WAL; a concurrent reader can no longer
   cause silent op loss) and atomically renames over the published file
   (never deleted first — the crash-brick window is gone). Autosave/discard
   dispatch from the LOCKED registry row (racing the migration sweep lost
   drafts); whole-doc writes refused when the table's true rowcount exceeds
   the 10k window (the exactly-10k clipped round-trip could truncate); UI
   commit aborts if the draft flush fails.
2. **Pushdown parity** — numeric `eq/neq` are numeric-compared with
   JS-canonical target gating (SQLite text-casts 9 to `'9.0'`, so integer eq
   matched nothing); `contains`-on-number and free-text sorts fall back to
   the doc path; checkbox eq mirrors JS; ops-path column retype re-coerces
   from doc-shaped values; `table_get` reports true totals for big tables.
3. **Verbatim date storage** — normalize-on-write removed: migration must
   never mutate stored cell text (it was rewriting dates en masse,
   timezone-dependently). Imports arrive ISO anyway; the profile flags
   MIXED DATE FORMATS instead.

**Open follow-ups from the audit** (logged on dev-brain task `c381fe96`, none
ship-blocking): quoteIdent the ~20 read-back interpolations of in-file
physical names (defense-in-depth for restored/imported files) + per-op zod on
draft-ops; PG-tx-fails-after-file-mutation divergence (plan-accepted crash
window; versioned filenames + pointer swap would close it); batch-nonce
idempotency for the op etag; `table_rows_list` clipped-path cell formatting;
`updateTable` response drops `totalRows`/`docClipped`.

## Before ship (in order)

1. **Extractor rehearsal on dev** — the table profile-chunk + reuse-summary
   pass needs the new image + a live worker. This is also the **NATREF gate**:
   re-validate Rea's reference-table lookups (the GRADESEQNO case) against the
   `table_sql` grounding before that box upgrades.
2. **Merge from the integrator** — main is 2 ahead (v0.133.1/2 landed the 0119
   journal fix independently, same `when` values → clean merge; our duplicate
   journal commit is a no-op).
3. **Release + COMPOSE REFRESH on every box** — the `table-dbs` mount is a
   compose change; tag-only registry pulls will miss it (known drift trap).
   The changelog entry must say so.
4. After one clean release: run `retire-table-blobs.ts --apply` (release N+1
   blob retirement, dry-run first).

## Jason's next idea (logged as a dev-brain roadmap task)

Three-parter, post-ship direction for Tables:
1. **Database schema surface for the AI** — a brain-wide data dictionary
   (every table's tabs/columns/types/FTS names) the responder can load,
   beyond today's per-table `table_get.sql` block + corpus map.
2. **Ledger skills for querying tables** — a manifest skill teaching the
   Ledger specialist the `table_sql`/`table_query` ladder (when to SQL, how
   to join, MATCH quoting), instead of relying on tool descriptions alone.
3. **Tabs in tables — each tab is a table** — multi-tab workbook nodes + the
   grid tab bar (the engine's file layout already supports N tabs; import
   maps sheet→tab instead of sheet→table). Deferred from P3, now explicit.

## Deferred / not built (by design)

In-grid cell editing past the 10k window (agent row tools + table_sql cover
it); multi-tab workbooks + tab bar (see idea above); P5 items (prose-column
row-embeddings, query-builder UI, /apps read access to tables, cross-node
scratch joins, MinIO write-back, peer file transfer).

## Where things are

- Branch: `feat/tables-v2` in `.claude/worktrees/tables-v2` (integrator stays
  on main). Commits: `f8bf4072`, `7fa11662`, `4cb107b3`, `8785a429`,
  `ddfe4444`, `e9fc3664`, `f3dec4bb`, `d741bc5d`.
- Dev brain: running log task `c381fe96` (P0–P4 + audit detail), plan file
  `935d25f7`, summary page `81d4a74e`, L3-lite decision task `e2e5ffff`
  (folded into P2 per the §12.1 amendment).
- Local dev note: `TABLE_DB_DIR` unset → cwd-relative `.table-dbs`
  (gitignored); the 0119+0120 migrations are applied on the workstation
  clone DB via the real migrator.
