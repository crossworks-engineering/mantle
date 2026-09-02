/**
 * @mantle/content · nodes
 *
 * Nodes — the generic node layer: reads, chunking, dedup, export, backup, capacity and Recall.
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
  CAPACITY_POLICY,
  capacityZone,
  computeCapacity,
  corpusCapacity,
  type BrainCapacity,
  type CapacityMetric,
  type CapacityZone,
} from './capacity';

export {
  mergeEntities,
  findDuplicateCandidates,
  dismissMergeCandidate,
  normaliseOrgName,
  isEmailName,
  isPhoneName,
  isNameSubset,
  type MergeTier,
  type MergeCandidate,
} from './entity-dedup';

export {
  RECALL_TAG,
  RECALL_PROMPT_TAG,
  compileRecallMap,
  embedPendingRecallPrompts,
  findPageRoot,
  getRecallMap,
  recallAfterPageDelete,
  recallAfterPageMove,
  recallAfterPageWrite,
  removeRecallForPage,
  isRecallTreePage,
  type RecallCompileResult,
} from './recall';
export {
  resolveExport,
  EXPORT_MIME,
  EXPORTABLE_TYPES,
  type ExportResult,
  type ExportFormat,
  type ExportKind,
  type ResolveExportOptions,
} from './export-node';

export { chunkDocText, type DocChunk } from './chunk';
export { chunkSpreadsheetProfile, hasSheetMarkers, isSpreadsheetTitle } from './chunk-spreadsheet';
export { clampPieces } from './chunk-clamp';

export {
  DEFAULT_BACKUP_CONFIG,
  ephemeralBackupDirMessage,
  isBackupDirPersistent,
  isBackupDue,
  isResolvedBackupDirPersistent,
  listBackups,
  loadBackupConfig,
  loadBackupStatus,
  maybeRunScheduledBackups,
  normalizeBackupConfig,
  parseProcMounts,
  resolveBackupDir,
  runBackup,
  saveBackupConfig,
  type BackupConfig,
  type BackupFile,
  type BackupFrequency,
  type BackupStatus,
} from './backup';

export { getOwnedNode } from './nodes';
