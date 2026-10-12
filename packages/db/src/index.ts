export * from './schema/index';
export { teamReadsSql, teamReadsAliasSql, teamWritesSql } from './grant-reads';
export {
  GRANT_DRIFT_SQL,
  WORKSPACES_CHECK_SQL,
  parseWorkspacesCheck,
  runWorkspacesCheck,
  workspacesCheckFindings,
  type WorkspacesCheck,
} from './workspaces-check';
export {
  db,
  systemDb,
  closeDb,
  withSystemTx,
  withViewer,
  viewerScopeFor,
  withScope,
  withTurnScope,
  ScopeLostError,
  scopeHoldsAdmin,
  scopeHasArea,
  loginHasArea,
  loginHoldsAdmin,
  withHeads,
  withSubtreeHeads,
  withNodeInsertHeads,
  withNodeMoveHeads,
  withNodeDeleteHeads,
  withWriterHeads,
  folderHeadIds,
  headsOrSpace,
  withSpaceRows,
  onSpaceRows,
  lockMoreHeads,
  withDeadlockRetry,
  loginScopeFor,
  resolveCreateHome,
  type CreateHomeRefusal,
  loginScopeColumns,
  seedLoginScope,
  brainOnWorkspacesNow,
  isWriteSql,
  executeWrite,
  NotAWriteError,
  readTransaction,
  type Db,
} from './client';
export {
  VIEWER_LEVELS,
  currentScope,
  isSystemScope,
  SCOPE_AREAS,
  type ScopeArea,
  currentWorkspaceScope,
  scopeLeftForSystem,
  withoutLeftScope,
  withGateScope,
  currentGateScope,
  currentTurnStamp,
  withTurnStamp,
  isUnscoped,
  inTurnScope,
  inScopeTransaction,
  currentSpaceScope,
  readsDrafts,
  isViewerLevel,
  asViewerLevel,
  lowerLevel,
  levelCovers,
  levelsMeet,
  ViewerLevelConflictError,
  asSystem,
  AS_SYSTEM_TURN_REASONS,
  TurnScopeExitError,
  type AsSystemReason,
  SYSTEM_DB_MODULES,
  assertSystemDbCaller,
  afterCommit,
  afterRollback,
  viewerRoleName,
  type SpaceScope,
  type ViewerLevel,
  type ScopeKind,
  type WorkspaceScope,
  type ViewerFor,
  type AppRunFor,
  type CurrentScope,
  type TurnStamp,
  runInRequestSlot,
  hasRequestSlot,
  enterRequestScope,
  noteRequestSystem,
  noteRequestWriteScope,
  requestWriteScope,
  noteRequestCreateHome,
  withCreateHome,
  currentCreateHome,
  type CreateHome,
  noteRequestSystemWrite,
  requestSystemWrites,
  noteRequestOwnRule,
  noteOwnRuleSystemRead,
  ownRuleSystemReads,
  currentRequestOutcome,
  currentRequestMode,
  adminReadsOnSystemPool,
  narrowsWorkspaceScope,
  type RequestScopeMode,
  type RequestOutcome,
} from './viewer';
export { ensureViewerRoles } from './viewer-roles';

export { draftColumn, draftAllowed } from './draft-read';
export {
  CONCURRENT_INDEXES,
  ensureConcurrentIndexes,
  type ConcurrentIndex,
  type ConcurrentIndexOutcome,
} from './concurrent-indexes';
export { ensureTsMatchLeakproof, tsMatchLeakproof, TS_MATCH_SIGNATURE } from './leakproof';
export {
  EMAIL_ATTACHMENTS_LABEL,
  EMAIL_ATTACHMENT_MARK,
  emailAttachmentFileSql,
  emailAttachmentSql,
} from './email-attachment';
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
  EXTRACT_PARKED_KEY,
  extractParkedStamp,
  extractParkedSql,
} from './extract-exempt';
export { backfillTerminalSkips, type TerminalSkipBackfill } from './extract-skip-backfill';
export { parkedExtractions, type ParkedExtractions } from './extract-parked';
export { MIGRATION_TAGS } from './migration-tags';
export { llmWorkAllowed } from './llm-guard';
export { OLDER_SUMMARY_LABEL, olderSummaryOf } from './mixed-summaries';
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
  isHeadsCheckError,
  isCheckViolation,
  isUniqueViolation,
  isScopeWriteRefusal,
  pgConstraint,
  pgErrorCode,
} from './pg-error';
export {
  snapshotCopyOf,
  isSnapshotCopy,
  assertNotSnapshotCopy,
  SnapshotCopyReadOnlyError,
  SNAPSHOT_COPY_READ_ONLY_MESSAGE,
  SNAPSHOT_COPY_NO_SHARE,
} from './snapshot-copy';
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
export { itemReadByWorkspace, nodeReadByWorkspace, scopeReadsNodes } from './scope-readable';
export {
  itemWriteRefusal,
  itemNotInScopeError,
  itemNoRightError,
  READ_ONLY_COPY_ERROR,
  type ItemNeed,
} from './item-rights';
export { VAULT_PAIR_MAKER_NO_KEYS, vaultPairRunRefusal } from './vault-pair';
