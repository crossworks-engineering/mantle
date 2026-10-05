export * from './schema/index';
export {
  db,
  systemDb,
  closeDb,
  withSpace,
  withTeamDrafts,
  withHumanViewer,
  type Db,
} from './client';
export {
  VIEWER_LEVELS,
  currentViewerLevel,
  currentSpaceScope,
  readsDrafts,
  isViewerLevel,
  asViewerLevel,
  lowerLevel,
  levelCovers,
  levelsMeet,
  itemLevelAbove,
  ViewerLevelConflictError,
  withViewer,
  asSystem,
  afterCommit,
  afterRollback,
  viewerRoleName,
  type LimitedLevel,
  type SpaceScope,
  type ViewerLevel,
} from './viewer';
export { ensureViewerRoles, LIMITED_LEVELS } from './viewer-roles';
export {
  ACCESS_MATRIX,
  WORKSPACE_NODE_TYPES,
  applyViewerGrants,
  type TableAccess,
} from './access-matrix';
export { getDefaultWorker, getAgentTtsWorker, bumpWorkerUsage } from './ai-workers-resolve';
export {
  PROVIDER_ALERT_VISIBLE_AFTER_MS,
  PROVIDER_SUBJECTS,
  countDeadLetteredExtracts,
  countExtractBacklog,
  isAlertShown,
  listOpenProviderAlerts,
  listProviderAlerts,
  recordProviderFailure,
  recordProviderProbeFailure,
  requestProviderProbeNow,
  resolveProviderAlert,
  setProviderAlertPaused,
  type ProviderFailure,
  type ProviderSubject,
} from './provider-alerts';
export {
  closedRangeEndAfter,
  getChatThread,
  listChatThreads,
  openChatThread,
} from './chat-threads';
export { bumpAgentUsage } from './agents-resolve';
export {
  resolveContextRef,
  CONTEXT_KINDS,
  type ContextKind,
  type ContextRef,
  type ResolvedContextRef,
} from './context-ref-resolve';
export { notifyNodeIngested, notifyNodeIndexed } from './notify';
export {
  FORUM_ARCHIVE_SOURCE,
  TEAM_REQUEST_SOURCE,
  CLIENT_REQUEST_SOURCE,
  REQUEST_SOURCES,
  isExtractExempt,
  extractExemptSql,
  unextractedNodeConds,
  noExtractSinceWriteSql,
  EXTRACT_SKIPPED_KEY,
  TERMINAL_EXTRACT_SKIPS,
  extractSkippedStamp,
  extractSkippedSql,
} from './extract-exempt';
export { backfillTerminalSkips, type TerminalSkipBackfill } from './extract-skip-backfill';
export {
  WRITE_RETRY_AFTER_MS,
  bestEffortWrite,
  forgetWriteRefusals,
  isWriteRefused,
} from './write-refused';
export {
  BUSY_MESSAGE,
  BusyError,
  SAVE_BUSY_MESSAGE,
  withBusyRetry,
  isBusy,
  isCheckViolation,
  isUniqueViolation,
  pgConstraint,
  pgErrorCode,
} from './pg-error';
export {
  countUsers,
  resolveSingleOwnerId,
  isBrainOwnerId,
  waitForOwner,
  type WaitForOwnerOpts,
} from './resolve-owner';
export {
  noteRef,
  activeNotes,
  applyPersonaUpdate,
  capNotes,
  dedupeNewNotes,
  MAX_PERSONA_NOTES,
  type PersonaUpdate,
  type PersonaUpdateResult,
} from './persona-notes';
export {
  sql,
  eq,
  ne,
  and,
  or,
  not,
  isNull,
  isNotNull,
  inArray,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  desc,
  asc,
} from 'drizzle-orm';
export { carrySpaceRows, spaceFilesPath, SPACE_FILES_ROOT } from './space-carry';
export { takeShareReadLock, takeShareWriteLock } from './share-lock';
