/**
 * @mantle/content · tables
 *
 * Tables and formulas — typed grids, the spreadsheet build/export path, and the formula engine surface.
 *
 * Split out of the 962-line index.ts on 2026-09-02 (audit, tier 3). The
 * export lists are UNCHANGED — this package's public surface is exactly what
 * it was. What changed is that adding one export now touches one small file
 * instead of the single barrel that saw 102 commits in 90 days, so two
 * sessions adding a DTO no longer collide. Curation is deliberate here: the
 * alternative, `export *`, would publish every module's internals (tuning
 * constants like EMBED_TEXT_PER_FILE, helpers like renderIdentityBlock) as
 * API nobody chose to promise.
 */

export {
  TABLES_ROOT_LABEL,
  listTables,
  countTables,
  listTableTags,
  getTable,
  createTable,
  updateTable,
  saveTableDraft,
  discardTableDraft,
  commitTable,
  deleteTable,
  applyTableOps,
  type ApplyTableOpsResult,
  type TableRow,
  type TableDetail,
  type TableTabInfo,
  type TableVisibility,
  type TableSort,
  type CreateTableInput,
  type UpdateTableInput,
} from './tables';

export {
  diffTableDocs,
  emptyTableDoc,
  ensureTableDoc,
  ensureWorkbookDoc,
  tableDocFromGrid,
  type GridInput,
  findColumn,
  findColumnByName,
  findRow,
  rowIndex,
  coerceCell,
  resolveCell,
  cellNumber,
  cellIsEmpty,
  addRow,
  updateRow,
  deleteRow,
  setCell,
  addColumn,
  updateColumn,
  deleteColumn,
  setAggregate,
  computeAggregate,
  addSelectOption,
  applyView,
  queryRows,
  type RowQuery,
  groupRows,
  type GroupBucket,
  setView,
  COLUMN_TYPES,
  AGGREGATE_KINDS,
  FILTER_OPS,
  type TableDoc,
  type TableDocOp,
  type WorkbookDoc,
  type WorkbookTab,
  type Column,
  type ColumnRef,
  type ColumnType,
  type ColumnFormat,
  type SelectOption,
  type Row,
  type CellValue,
  type AggregateKind,
  type View,
  type SortSpec,
  type Filter,
  type FilterOp,
} from '@mantle/content-core/table-model';

export {
  evalFormula,
  evalExpression,
  refsIn,
  type RefResolver,
  type EvalValue,
} from '@mantle/content-core/table-formula';

export { tableToText, tableToCsv, formatCellText } from './table-to-text';

export {
  parseFormulaSpec,
  checkLookupCoverage,
  type FormulaSpec,
  type FormulaValue,
  type SpecVariable,
  type SpecExpression,
  type SpecPiecewise,
  type SpecLookup,
  type SpecClassification,
  type CoverageGap,
} from '@mantle/content-core/formula-spec';

export {
  evaluateSpec,
  parseInputText,
  type EvalResult,
  type TraceStep,
} from '@mantle/content-core/formula-eval';

export {
  signatureOf,
  signatureForTarget,
  signatureLine,
  type TargetSignature,
  type SignatureInput,
  type SignatureInputKind,
  type SignatureBranch,
} from '@mantle/content-core/formula-signature';

export { formulaToText } from './formula-to-text';

export {
  FORMULA_SEED,
  FORMULA_SEED_SLUGS,
  SEED_TAG,
  type SeedFormula,
  type SeedExample,
} from '@mantle/content-core/formula-seed';

export { calculate, type CalcResult, type CalcOptions } from './calculate';

export {
  checkDimensions,
  normaliseUnit,
  type DimensionIssue,
} from '@mantle/content-core/formula-dimensions';

export {
  FORMULA_ROOT_LABEL,
  FormulaSpecError,
  isFormulaSpecError,
  createFormula,
  listFormulas,
  countFormulas,
  listFormulaStandards,
  listFormulaSpecIds,
  getFormula,
  readFormulaSpec,
  updateFormula,
  deleteFormula,
  type FormulaRow,
  type CreateFormulaInput,
  type UpdateFormulaInput,
} from './formulas';

export {
  listRows,
  type RowListResult,
  type RowListEntry,
  type RowListColumn,
  type ListRowsOptions,
} from './table-list';
export {
  renderXlsx,
  renderXlsxWorkbook,
  type RenderXlsxOptions,
  type RenderXlsxSheet,
} from './render-xlsx';
export {
  buildSheet,
  validateWorkbookSpec,
  SheetSpecError,
  MAX_SHEETS,
  MAX_ROWS_PER_SHEET,
  MAX_ROWS_PER_WORKBOOK,
  MAX_COLUMNS_PER_SHEET,
  type WorkbookSpec,
  type SheetSpec,
  type SheetColumnSpec,
  type SheetColumnType,
  type SheetTotalKind,
} from './build-sheet';
