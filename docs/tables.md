# Tables

Typed database grids — the Airtable/Notion-database content type. Where **Pages**
([`pages.md`](./pages.md)) is rich *prose* (TipTap/ProseMirror, free-text table
cells), **Tables** is structured *data*: typed columns, per-row addressing,
totals, formulas, sort/filter views, and spreadsheet import. It exists because
coercing a real data table out of the Pages editor is a fight — Pages tables have
no column types, no totals, no formatting, no clean way to say "update row 3".

Since v2.1 a Table is a **workbook**: one node = one SQLite file = N **tabs**
(worksheets, like Excel). A multi-sheet spreadsheet imports as one Table with a
tab per sheet; `table_sql` joins across tabs; a **reference column** in one tab
offers values from another tab's column.

Tables mirrors Pages, one layer per concern, so the two share the same tree,
search, draft/commit, delegation, and brain-indexing machinery.

| Concern | Pages | Tables |
|---|---|---|
| Node type | `nodes.type='page'` | `nodes.type='table'` |
| Sidecar | `pages` (`doc`/`doc_text`/`draft_doc`/`version`) | `tables` (registry: `storage_path`/`stats`/`shape_hash`/`draft_rev` + legacy JSONB mirror) |
| Source of truth | ProseMirror `doc` | the **workbook file** (`TABLE_DB_DIR/<owner>/<node>.sqlite`) |
| Addressing | `block-ids.ts` (UUID per block) | native stable `tab.id` / `column.id` / `row.id` |
| Pure ops | `block-edit.ts` / `block-list.ts` | `table-model.ts` (doc) + `packages/tabledb` ops (file) |
| Derived text | `doc-to-text.ts` | L1 profile + schema chunks (`packages/tabledb/profile.ts`, `schema.ts`) |
| CRUD + draft/commit | `packages/content/src/pages.ts` | `packages/content/src/tables.ts` + `table-storage.ts` |
| Builtin tools | `builtins-pages.ts` (`page_*`) | `builtins-tables.ts` (`table_*`) |
| Specialist agent | `Pages` + `rich_writing` | `Ledger` + `table_authoring` |
| UI | `/pages` + TipTap | `/tables` + TanStack grid + workbook tab bar |

---

## 1. The data model

`packages/content/src/table-model.ts` is the doc-shaped heart: a pure, DB-free,
**browser-safe leaf** (Web Crypto, no `node:crypto`) so the API, the agent
tools, and the client grid all share one implementation.

```ts
type TableDoc = {              // ONE tab's grid
  columns: Column[];
  rows: Row[];
  aggregates?: Record<columnId, AggregateKind>;  // footer totals
  views?: View[];                                // saved sort + filter
};
type WorkbookDoc = { tabs: (TableDoc & { id?; name })[] };  // multi-tab write shape
type Column = {
  id; name;
  type: 'text'|'number'|'currency'|'percent'|'date'|'datetime'
       |'checkbox'|'select'|'multiselect'|'url'|'formula'|'reference';
  format?: { currency?; decimals? };
  options?: { id; label; color? }[];   // select / multiselect
  formula?: string;                    // formula columns
  ref?: { tabId; columnId };           // linked (reference) columns — source
  width?: number;
};
type Row = { id; cells: Record<columnId, CellValue> };   // ← the addressing unit
```

Every tab, column, and row carries a **stable id** — the native addressing
primitive. "Update row X on tab Y" maps straight onto ids; no tree walking.

Pure ops (all return a new doc): `addRow`/`updateRow`/`deleteRow`/`setCell`,
`addColumn`/`updateColumn`/`deleteColumn` (re-coerces cells on a type change),
`setAggregate`, `computeAggregate`, `applyView`, `setView`, `ensureTableDoc` /
`ensureWorkbookDoc` (tolerant normalisers), `tableDocFromGrid` (the import
assembler), and `diffTableDocs` (doc diff → draft-op batch; the grid's save
path — see §5).

### Linked (reference) columns (v2.1)

`type: 'reference'` + `ref: {tabId, columnId}`: a **convenience picker** that
offers values from another tab's column, Excel data-validation style. It is
NOT a relationship — the picked value is **copied as plain text at pick
time** (no row-ids, no join, no live-follow: renaming a source value does not
propagate, by design — better for `table_sql`, which just sees an ordinary
column). Same workbook only (`table_sql` can't `ATTACH` other files).

A reference **stores as `select` (text)** — the engine's `storageType()` maps
`reference → select` at every storage/read/filter site, so linked cells
round-trip through the proven select path (the v0.136.0 single-text reference —
forward-compatible, no migration).

In the grid: **Link column…** in the type menu when unlinked; once linked, a 🔗
icon left of the type icon opens a menu (**Change source…** · **Delete link**).
Picking a standard type unlinks; delete-link keeps values as plain text. Via
tools: `table_column_add` / `table_column_update` take `reference: {tab, column}`.

Soft integrity: free text allowed, values missing from the source flagged
`DANGLING REFS`; deleting the source degrades to plain text, values intact. A
linked column advertises its source edge everywhere schema is
(`describeWorkbook().columns[].refersTo`, the profile, the schema chunk "Join
edge: …").

### Formulas — `table-formula.ts`

Same-row scalar expressions, referencing columns by name in braces:
`{Qty} * {Price}`, `ROUND({Total} * 0.15, 2)`, `IF({Paid}, 0, {Due})`. Evaluated
by **mathjs** (pinned at 15.2.0) through a thin compatibility layer —
`table-formula-mathjs.ts`. Broken/hostile input returns `null` (renders blank,
never throws). Formula columns are read-only, recomputed on read via
`resolveCell`, never stored in the file, and omitted from the SQL views. No
cross-formula references (cycle guard), no cross-row math (that's aggregates),
no cross-tab formulas.

**Joining text uses `CONCAT`, not `+`.** `+` is arithmetic only, as in Excel
(which uses `&`) and Airtable (`CONCATENATE`). This is deliberate: making `+`
loose enough to concatenate means loosening mathjs's type discipline, and that
discipline is what makes unit arithmetic work — an early cut of the migration
extended `+` for strings and silently broke `1 ft + 2 ft`.

Blank and unknown references still read as `0`, applied when binding the scope
rather than in the type system, so spreadsheet ergonomics cost nothing at the
unit layer.

`table-formula.ts` — the previous hand-written tokenizer + recursive-descent
parser — is retained for one release as a revertible fallback and as the
baseline in `table-formula-diff.test.ts`, which runs every expression through
BOTH engines and fails if they disagree outside a declared list. Nothing else
should import it.

---

## 2. Storage — the workbook file + the registry (v2)

Each table lives in its own SQLite file: `TABLE_DB_DIR/<ownerId>/<nodeId>.sqlite`
(+ `.draft.sqlite` while uncommitted edits exist). `TABLE_DB_DIR` defaults to
`/data/table-dbs` in compose — **both** `web` and `api` mount it (tool handlers
run in both processes; the `/debug` sanity check screams if a file is visible
from one side only). Engine: `packages/tabledb`.

In-file layout (engine-managed; agents/users never run DDL): `_meta`, `_tabs`,
`_columns` (incl. `ref_json`), `_views`, `_aggregates`, one physical table
`t_<tabid>` per tab (`_rid` PK + `_pos` row order + `c_<colid>` columns), a
display-named SQL **view** per tab (what `table_sql` queries), and an FTS5
trigram shadow `t_<tabid>_fts` per tab on published files (drafts never carry
shadows; promote rebuilds them).

The Postgres `tables` row is the **registry + lock spine** (migration `0120`):
`storage_path` (NULL = legacy JSONB), `size_bytes`, `stats` (per-tab counts),
`shape_hash`, `engine_version`, `draft_rev` (the draft-op etag). Every writer —
UI autosave, agent op batch, migration — serializes on
`withTableRegistryLock` (`SELECT … FOR UPDATE`).

**Draft/commit:** edits land on the draft file as **op batches**
(`applyTableOps` → `applyOpsToFile`, atomic per batch, `draft_rev` etag; a
stale `if_rev` gets 409). Commit **promotes the server draft**: VACUUM-INTO
snapshot → atomic rename over the published file → FTS rebuild → stats/shape
re-derived from the file. The client never posts the doc at commit time, so a
windowed doc can never truncate the table. Commit is the **only** path that
re-indexes (one extraction per commit, cost-safe).

**Limits:** the doc materializer loads ≤ `MATERIALIZE_MAX` (10k) rows per tab —
beyond it reads go windowed (keyset/offset over the file) and whole-doc writes
are refused. Imports go up to `TABLE_IMPORT_MAX_ROWS` (default 2M) and error
explicitly past it — part-splitting is dead.

**Legacy JSONB:** pre-v2 tables migrate lazily (first write) and via a
background sweep (5/tick, 5-min interval). The JSONB `data`/`draft_data`
columns stay dual-written as a rollback mirror **only** for single-tab,
in-window docs — a multi-tab workbook's file is its sole carrier.
`retire-table-blobs.ts` retires the blobs one release after v2.

**Durability:** the scheduled backup and `db-dump.sh` snapshot every workbook
(VACUUM INTO) alongside `pg_dump`; boot/CI/prod-image probes verify
`node:sqlite`; a missing published file throws (`mustExist` — never silently
recreated).

### Indexing — profile + schema chunks, never rows

Rows are **never embedded** (§12.1 amendment: row dumps were the dominant chunk
pollution on a production brain). A table indexes as:
- one **profile** chunk (title + tab summary + LLM overview),
- one **schema** chunk (v2.1 P3): the data dictionary — tabs, columns, types,
  row counts, view + FTS names, reference join edges — so retrieval lands on
  schema and grounds a `table_sql` call directly,
- one **profile > _tab_** chunk per tab (columns, distinct counts, top values,
  identifier-like/prose/`MIXED DATE FORMATS`/`DANGLING REFS` flags).

The extractor also writes a one-line `schemaDigest` into `nodes.data`, which
the **corpus map** renders inline for every table entry. The first 200 rows
(spent across tabs) live only in `tables.data_text` for list ILIKE. The
`shape_hash` gate keeps the LLM summary when a commit didn't change the shape —
cell edits refresh only the cheap deterministic layers.

---

## 3. Import — `@mantle/files/sheet-to-grid`

`parseSheetToGrid(buf)` (SheetJS) → one `ParsedSheet` per non-empty sheet, each
with typed columns (value-sampled inference: number/checkbox/date/datetime/text,
UTC-safe date detection) + aligned rows. `tableDocFromGrid` assembles a
`TableDoc` per sheet. **One workbook per file: every sheet becomes a TAB** of
the same table (v2.1) — no more sibling-table splitting. (CSV has no real
types, so its `true`/`false` infer as text — retype in the UI; xlsx booleans
infer as checkbox.)

`parseTextToGrid(text)` is the same path for **pasted tabular text** (markdown
pipe table, TSV, or quote-aware CSV) → the `table_from_text` tool.

**Auto-import on ingest.** A spreadsheet uploaded *anywhere* (Files screen,
chat attachment, email, Telegram) becomes ONE table with a tab per sheet
(`maybeAutoTableSpreadsheet` in `apps/api`) — published, indexed, deduped by
`data.sourceFileId` so a re-ingest never doubles. Sheets are capped at
`MAX_AUTO_TABLE_TABLES` (20) tabs per upload; the explicit `table_from_file`
tool is user-initiated and uncapped (but stamps `sourceFileId` too).

---

## 4. Tools + the Ledger agent

`packages/tools/src/builtins-tables.ts` — the `table_*` builtins. Every
row/column/query/view tool takes an optional **`tab`** (name or id; default:
first tab).

Reads: `table_list`, `table_get` (advertises `tabs` + the SQL surface),
**`table_schema`** (the data dictionary for up to 20 tables in ONE call —
survey before fetching any rows), **`table_sql`** (read-only SELECT over the
per-tab views, worker-thread watchdog, row caps, FTS `MATCH` with
double-quoted terms; cross-tab JOINs are just SQL — the schema chunk names the
join edges), `table_rows_list`, `table_row_get`, `table_query` (filter-object
lookups with parity-gated SQL pushdown; aggregates over the full matched set),
`table_aggregate` (GROUP BY).

Edits (→ the draft, atomic op batches, review hint): `table_row_add`/`update`/
`delete`, `table_cell_set`, `table_column_add`/`update`/`delete` (add/update take
`reference: {tab, column}` for linked columns),
`table_set_aggregate`,
`table_set_view`, and the tab CRUD — **`table_tab_add` / `table_tab_rename` /
`table_tab_delete`** (refuses the last tab). Plus `table_create`,
`table_from_file`, `table_from_text`, `table_update` (metadata),
`table_commit`, `table_delete` (`requiresConfirm`), `export_node` (§6). Cells
accept column **name or id**. Oversized reads spill to the `read_result`
store. Windowed reads self-announce truncation (`truncated`/`next_offset`).

**The retrieval ladder** (taught by the `tool_grounding` skill): corpus-map
schema digest → `table_schema` → `table_sql`. Identifier-shaped terms with no
chunk hit sweep the tables' FTS shadows (`WHERE <fts> MATCH '"THE-TERM"'`).
Search only ever indexes a table's profile/schema — rows live behind
`table_sql`.

**"Ledger" — the Tables agent** + **`table_authoring` skill** (system
manifest): granted the safe authoring subset (no `table_delete`) plus
file/search tools; wired into every entry agent's `delegate_to`. The skill
teaches the workbook model (tabs, reference columns), formulas, totals, views,
and the draft discipline: `table_rows_list` before editing, edits write to
draft, report `/tables/<id>`, only `table_commit` when the user says publish.

The `/tables/<id>` editor wires the global assistant overlay to the open grid
(`useSurfaceAssist`): Ledger edits the draft server-side and the grid reloads
it live; the header Commit/Discard publish or revert.

---

## 5. UI — `/tables`

**Master-detail shell** (`tables/page.tsx` + `tables-shell.tsx`): resizable +
collapsible left list (persisted), URL-driven selection/search/tags/pager,
`useRealtime(['table'])`. `/tables/[id]` redirects into `?selected=<id>`.

The editor (`[id]/table-detail-client.tsx` + `components/table-grid/`):

- **Workbook tab bar** (v2.1): switch (flushes pending edits), add
  (auto-switches), rename (double-click or menu), delete (falls back to the
  first tab; refuses the last). Tab changes are draft ops — Discard reverts.
- **Op-based saves**: the grid's whole-doc `onChange` is diffed
  (`diffTableDocs`) into an op batch scoped to the active tab and POSTed to
  `/draft-ops` with the `if_rev` etag (409 → reload). Legacy JSONB tables keep
  the whole-doc PUT. Reordering rows/columns isn't expressible as ops yet —
  single-tab tables fall back to a whole-doc save; multi-tab surfaces the
  limitation.
- **TanStack-backed typed grid**, virtualized (`@tanstack/react-virtual`):
  editable cells per type — number/currency/percent, date/datetime pickers,
  checkbox, select/multiselect combobox with inline create, **reference cells
  as a combobox that fetches the source column's distinct values**
  (`?distinct=` on the rows route, draft-first, typeahead, free text allowed),
  read-only formula. Column header menu (rename · retype · total · sort ·
  insert · delete); the retype menu excludes `reference` (create via the
  assistant / `table_column_add`, which takes the source).
- Past the materialize window the grid is a read-only leading window with
  "Load more" (per tab); edits go through the assistant's row tools.
- Import (xlsx/csv → tabs on this table's draft), export, emoji, the
  draft → **Commit**/Discard status machine.

API routes under `app/api/tables/`: `route` · `[id]` (`?tab=`) · `[id]/draft`
(whole-doc PUT) · `[id]/draft-ops` (op batches + `if_rev`) · `[id]/commit` ·
`[id]/discard-draft` · `[id]/rows` (windowed reads, `?tab=`, `?distinct=`) ·
`[id]/import` · `[id]/export`.

---

## 6. Export

- **`.xlsx`** — `renderXlsx` (`exceljs`-backed) maps the typed doc to formatted
  cells + a totals row. Web: the detail-header Download → `GET /api/export/[id]`.
  Agent: `export_node` saves under `/files/exports`.
- **`.sqlite`** (v2) — the workbook file itself via `[id]/export?format=sqlite`:
  a consistent VACUUM-INTO snapshot, openable in any SQLite client.

---

## 7. Deliberately deferred

Public sharing of tables (`/s/[token]` + a `renderTableDoc`), row/column
drag-reorder ops (the differ falls back today), cross-**workbook** references
(same-file only by design), reference row-id/FK mode with lookup columns,
cross-tab formulas, in-grid editing past the 10k window, real-time multi-cell
collab.
