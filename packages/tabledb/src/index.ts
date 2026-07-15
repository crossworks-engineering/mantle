export { runTableStorageProbes } from './probes';
export type { ProbeReport, ProbeResult } from './probes';

export {
  ENGINE_VERSION,
  MATERIALIZE_MAX,
  SCHEMA_VERSION,
  TableTooLargeError,
  fileStats,
  importMaxRows,
  readDocFile,
  shapeHashOf,
  snapshotFile,
  writeDocFile,
} from './engine';
export type { TabStats, WorkbookStats, WriteDocMeta, WriteResult } from './engine';

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
