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
  readDocFile,
  shapeHashOf,
  snapshotFile,
  writeDocFile,
} from './engine';
export type {
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
