# Tables

Typed database grids — the Airtable/Notion-database content type. Where **Pages**
([`pages.md`](./pages.md)) is rich *prose* (TipTap/ProseMirror, free-text table
cells), **Tables** is structured *data*: typed columns, per-row addressing,
totals, formulas, sort/filter views, and spreadsheet import. It exists because
coercing a real data table out of the Pages editor is a fight — Pages tables have
no column types, no totals, no formatting, no clean way to say "update row 3".

Tables is built as a deliberate mirror of Pages, one layer per concern, so the
two share the same tree, search, draft/commit, delegation, and brain-indexing
machinery.

| Concern | Pages | Tables |
|---|---|---|
| Node type | `nodes.type='page'` | `nodes.type='table'` |
| Sidecar | `pages` (`doc`/`doc_text`/`draft_doc`/`version`) | `tables` (`data`/`data_text`/`draft_data`/`version`) |
| Source of truth | ProseMirror `doc` | `TableDoc` (`{columns, rows, aggregates, views}`) |
| Addressing | `block-ids.ts` (UUID per block) | native stable `column.id` / `row.id` |
| Pure ops | `block-edit.ts` / `block-list.ts` | `table-model.ts` / `table-list.ts` |
| Derived text | `doc-to-text.ts` | `table-to-text.ts` (markdown pipe table + totals row) |
| CRUD + draft/commit | `packages/content/src/pages.ts` | `packages/content/src/tables.ts` |
| Builtin tools | `builtins-pages.ts` (`page_*`) | `builtins-tables.ts` (`table_*`) |
| Specialist agent | `Pages` + `rich_writing` | `Tables` + `table_authoring` |
| UI | `/pages` + TipTap | `/tables` + TanStack grid |

---

## 1. The data model — `TableDoc`

`packages/content/src/table-model.ts` is the heart: a pure, DB-free, **browser-safe
leaf** (Web Crypto, no `node:crypto`) so the API, the agent tools, and the client
grid all share one implementation.

```ts
type TableDoc = {
  columns: Column[];
  rows: Row[];
  aggregates?: Record<columnId, AggregateKind>;  // footer totals
  views?: View[];                                // saved sort + filter
};
type Column = {
  id; name;
  type: 'text'|'number'|'currency'|'percent'|'date'|'datetime'
       |'checkbox'|'select'|'multiselect'|'url'|'formula';
  format?: { currency?; decimals? };
  options?: { id; label; color? }[];   // select / multiselect
  formula?: string;                    // formula columns
  width?: number;
};
type Row = { id; cells: Record<columnId, CellValue> };   // ← the addressing unit
```

Every column and row carries a **stable id** — that's the native addressing
primitive. "Update row X" / "total column Y" map straight onto `row.id` /
`column.id`; no tree walking (the equivalent of Pages' block-ids, but free).

Pure ops (all return a new doc): `addRow`/`updateRow`/`deleteRow`/`setCell`,
`addColumn`/`updateColumn`/`deleteColumn` (re-coerces cells on a type change),
`setAggregate`, `computeAggregate`, `applyView` (filter+sort), `setView`,
`ensureTableDoc` (tolerant normaliser, same-ref-when-unchanged like
`ensureBlockIds`), `tableDocFromGrid` (the import assembler).

### Formulas — `table-formula.ts`
Same-row scalar expressions, referencing columns by name in braces:
`{Qty} * {Price}`, `ROUND({Total} * 0.15, 2)`, `IF({Paid}, 0, {Due})`. A small
hand-written tokenizer + recursive-descent parser — **never `eval`** — over a
fixed grammar (`+ - * / %`, comparisons, and `IF/ROUND/ABS/MIN/MAX/SUM/FLOOR/
CEIL/CONCAT`). Broken/hostile input returns `null` (renders blank, never throws).
Formula columns are read-only and recomputed on read via `resolveCell`. They do
**not** reference other formula columns (cycle guard) and do **not** do
cross-row math — that's the aggregates footer.

---

## 2. Storage, draft/commit, brain

`tables` sidecar (migration `0068`; `0067` adds the `table` enum value):
`data` (the committed `TableDoc`) · `data_text` (derived markdown) · `draft_data`
(working copy) · `version`. FK cascade off the node.

`packages/content/src/tables.ts` mirrors `pages.ts`: `createTable`, `getTable`,
`listTables`/`countTables`/`listTableTags`, `updateTable` (metadata only),
`saveTableDraft`, `discardTableDraft`, `commitTable`, `deleteTable`.

**Draft/commit (parity with Pages, by design):** every structural edit autosaves
to `draft_data`. `commitTable` promotes it to `data`, recomputes
`data_text = tableToText(doc)`, bumps `version`, and fires
`notifyNodeIngested(id)` — the **only** path that re-indexes, so a long editing
session costs exactly one extraction per commit (cost-safe). `table` is in the
extractor's `DEFAULT_EXTRACT_TYPES`; `readNodeBodyRaw` reads `tables.data_text`,
so summary + 768-dim embedding + facts + `content_chunks` land like any node.
The rendered markdown includes a **Totals** row when a column has an aggregate,
so "what did the budget add up to?" is answerable from the index.

---

## 3. Import — `@mantle/files/sheet-to-grid`

`parseSheetToGrid(buf)` (SheetJS) → one `ParsedSheet` per non-empty sheet, each
with typed columns (value-sampled inference: number/checkbox/date/datetime/text,
UTC-safe date detection) + aligned rows. `tableDocFromGrid` (in `table-model`)
assembles a `TableDoc`. `@mantle/files` stays free of the model — it emits plain
shapes; the caller (tool / API) builds the doc. **One table per sheet:** a
multi-sheet workbook yields several tables. (CSV has no real types, so its
`true`/`false` infer as text — retype in the UI; xlsx booleans infer as checkbox.)

`parseTextToGrid(text)` is the same path for **pasted tabular text** (no file):
it detects a markdown pipe table, TSV, or CSV (quote-aware) and returns a
`ParsedSheet`. This powers the `table_from_text` tool — "build a table from these
results" in one call, instead of the agent adding rows one at a time.

---

## 4. Tools + the Tables agent

`packages/tools/src/builtins-tables.ts` — 18 `table_*` builtins. Reads:
`table_list`, `table_get`, `table_rows_list` (windowed id+preview snapshot —
read this *before* editing, so you target rows by id), `table_row_get`.
Edits (→ `draft_data`, return a review hint): `table_row_add`/`update`/`delete`,
`table_cell_set`, `table_column_add`/`update`/`delete`, `table_set_aggregate`
("add totals"), `table_set_view`. Plus `table_create`, `table_from_file`
(spreadsheet import), `table_from_text` (build a grid from a pasted CSV/TSV/
markdown block in one call — the "results → table" path), `table_update`
(metadata), `table_commit`, `table_delete` (`requiresConfirm`). Cells accept column **name or id**. Oversized
`table_get`/`table_rows_list` spill to the `read_result` store automatically.
MCP exposes read-only `table_list`/`table_get`/`table_rows_list`.

**Tables agent** (`seed:tables`) + **`table_authoring` skill** (`seed:tables-skill`):
the typed-grid analog of Pages + rich_writing. Granted the safe authoring subset
(no `table_delete`) plus file/search tools; wired into every entry agent's
`delegate_to`. Discipline (in the skill): always `table_rows_list` before editing;
edits write to draft; report the table id + `/tables/<id>` review URL; only
`table_commit` when the user says save/publish.

```bash
ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:tables-skill
ALLOWED_USER_ID=<uuid> pnpm -C apps/web seed:tables
# then restart apps/agent so the new agent + grants register
```

---

## 5. UI — `/tables`

Master-detail list (`tables/page.tsx` + `tables-client.tsx`): URL-driven
search/tag/pager, `useRealtime(['table'])`, a create dialog, accent-only
selection (house rule). The grid editor (`tables/[id]/` + `components/table-grid/`)
is a **TanStack-backed** typed grid: editable cells per type (number, currency-/
percent-formatted, date input, `Checkbox`, `Select`, read-only formula), a column
header menu (rename · retype · set total · sort · insert · delete), add/delete
rows, a totals footer, and the Pages-style draft autosave → **Commit**/Discard
status machine. **Import** (xlsx/csv → draft; extra sheets become sibling tables).
`table-model` is imported as a browser-safe leaf so the client reuses the shared
ops. API routes under `app/api/tables/` mirror `/pages`
(`route` · `[id]` · `[id]/draft` · `[id]/commit` · `[id]/discard-draft` · `[id]/import`).

---

## 6. Deliberately deferred (not v1)
Public sharing of tables (`/s/[token]` + a `renderTableDoc`), row drag-reorder,
cross-table relations/rollups, real-time multi-cell collab, and an in-editor
AI-assist side panel (Saskia delegation to the Tables agent already covers the
capability from `/assistant`).
