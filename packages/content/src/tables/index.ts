/**
 * Tables surface. A table is a `nodes` row with type='table' plus a `tables`
 * sidecar row holding the typed grid:
 *
 *   nodes.title           display name
 *   nodes.data.icon       optional emoji / icon
 *   nodes.data.summary    extractor-written summary
 *   nodes.data.visibility 'private' | 'public'
 *   tables.data           TableDoc JSON (source of truth)
 *   tables.data_text      derived markdown rendering (extractor + FTS read this)
 *   tables.draft_data     autosaved working copy, promoted on commit
 *
 * All under the `tables` ltree root, lazy-created on first write. `table` is in
 * the extractor's DEFAULT_EXTRACT_TYPES, so summary + embedding land
 * automatically on the next pg_notify('node_ingested'); `readNodeBodyRaw` reads
 * `data_text` from the sidecar. This is the Pages surface re-cut for grids —
 * `data`↔`doc`, `data_text`↔`doc_text`, `draft_data`↔`draft_doc`.
 */

/**
 * Split out of the 951-line tables.ts on 2026-09-02 (audit, tier 3) into
 * tables/{shared,workbook,read,write,draft}.ts. The dependency order is
 * one-way — shared <- workbook, shared <- read, shared <- write,
 * {shared,workbook} <- draft — so no seam imports this barrel.
 *
 * Curated, not `export *`: `@mantle/content/tables` is a public package
 * sub-path, and the split forced a dozen internals (rowOf, detailOf, docsOf,
 * assertTableWritable, the workbook guards, …) to become cross-module
 * exports. None of them is API. The list below is UNCHANGED from the single
 * file it replaces; `tables-exports.test.ts` pins it.
 */

export type {
  TableRow,
  TableDetail,
  TableSort,
  TableVisibility,
  TableTabInfo,
} from '@mantle/content-core/table-model';

export { TABLES_ROOT_LABEL, AppBoundTableError } from './shared';

export { listTables, countTables, listTableTags, getTable } from './read';

export {
  createTable,
  updateTable,
  deleteTable,
  type CreateTableInput,
  type UpdateTableInput,
} from './write';

export {
  applyTableOps,
  saveTableDraft,
  discardTableDraft,
  commitTable,
  type ApplyTableOpsResult,
  type SaveTableDraftResult,
} from './draft';
