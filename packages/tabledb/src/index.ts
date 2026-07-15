export { runTableStorageProbes } from './probes';
export type { ProbeReport, ProbeResult } from './probes';

export {
  ENGINE_VERSION,
  MATERIALIZE_MAX,
  SCHEMA_VERSION,
  TableTooLargeError,
  describeWorkbook,
  fileStats,
  importMaxRows,
  readDocClipped,
  readDocFile,
  shapeHashOf,
  shapeHashOfFile,
  snapshotFile,
  writeDocFile,
} from './engine';
export type {
  ClippedDoc,
  TabStats,
  WorkbookColumnRef,
  WorkbookStats,
  WorkbookTabRef,
  WriteDocMeta,
  WriteResult,
} from './engine';

export { ftsTableName, quoteFtsTerm } from './fts';
export { profileFile, profileToText, sampleRows } from './profile';
export type { ColumnProfile, TabProfile } from './profile';
export {
  SQL_ROW_CAP_DEFAULT,
  SQL_ROW_CAP_MAX,
  assertReadOnlySelect,
  runTableSql,
} from './sql-runner';
export type { SqlRunResult } from './sql-runner';

export { applyOpsToFile, finalizePublishedFile } from './ops';
export type { ApplyResult, CoerceFn, TableOp } from './ops';

export {
  aggregateWindow,
  compileFilters,
  compileSort,
  listRowsWindow,
  queryRowsWindow,
  readRowById,
} from './window';
export type { QueryWindowResult, RowWindow } from './window';

export { TableFileMissingError, openTableFile } from './sqlite';
export type { OpenOptions, SqliteDb } from './sqlite';

export {
  draftPath,
  draftPathFor,
  publishedPath,
  relativeStoragePath,
  resolveStoragePath,
  tableDbRoot,
} from './paths';

export type {
  AggregateKind,
  CellValue,
  Column,
  ColumnType,
  Filter,
  Row,
  TableDocLike,
  View,
} from './doc-types';
