/**
 * @mantle/content — CRUD for the content surfaces: notes, tasks, events,
 * and pages. Notes/tasks/events store their payload in `nodes.data` (jsonb);
 * pages keep the TipTap document in a `pages` sidecar with a derived
 * plaintext rendering. All live under dedicated ltree roots and the
 * extractor picks them up via the `node_ingested` pg_notify trigger.
 *
 * Web + MCP both import from here so the assistant and the UI agree on
 * shape and validation.
 */
export {
  NOTES_ROOT_LABEL,
  listNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  type NoteRow,
  type CreateNoteInput,
  type UpdateNoteInput,
} from './notes';

export {
  TASKS_ROOT_LABEL,
  TASK_STATUSES,
  TASK_PRIORITIES,
  listTasks,
  countTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  type TaskRow,
  type TaskStatus,
  type TaskPriority,
  type CreateTaskInput,
  type UpdateTaskInput,
} from './tasks';

export {
  EVENTS_ROOT_LABEL,
  listEvents,
  countEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  listDueReminders,
  markReminderSent,
  rollForwardRecurrence,
  ownersWithEvents,
  upsertExternalEvent,
  listExternalEventUids,
  deleteExternalEvents,
  deleteAllExternalEvents,
  type EventRow,
  type CreateEventInput,
  type UpdateEventInput,
  type UpsertExternalEventInput,
  type RecurFreq,
} from './events';

export {
  PAGES_ROOT_LABEL,
  EMPTY_DOC,
  listPages,
  countPages,
  listPageTags,
  getPage,
  createPage,
  updatePage,
  movePage,
  PageCycleError,
  addPageMention,
  MentionTargetNotFoundError,
  MentionAnchorNotFoundError,
  saveDraft,
  discardDraft,
  commitPage,
  deletePage,
  splitPage,
  NoSplitHeadingsError,
  extractSectionToChild,
  SectionNotFoundError,
  type PageRow,
  type PageDetail,
  type PageVisibility,
  type PageWidth,
  type CreatePageInput,
  type UpdatePageInput,
  type SplitPageResult,
  type ExtractSectionResult,
  type AddMentionResult,
} from './pages';
export {
  splitDocByHeading,
  extractSection,
  headingText,
  type SplitLevel,
  type SplitResult,
  type ExtractResult,
} from './page-split';
export {
  APPS_ROOT_LABEL,
  DEFAULT_ENTRY,
  emptySource,
  sourceToText,
  workingSource,
  listApps,
  countApps,
  listAppTags,
  getApp,
  createApp,
  updateAppMeta,
  saveDraftSource,
  writeDraftFile,
  deleteDraftFile,
  setManifest,
  setDraftBuild,
  discardDraft as discardAppDraft,
  publishApp,
  deleteApp,
  CannotDeleteEntryError,
  NoGreenBuildError,
  AppSourceLimitError,
  assertSourceWithinLimits,
  MAX_APP_FILES,
  MAX_APP_FILE_BYTES,
  MAX_APP_PATH_LEN,
  type AppRow,
  type AppDetail,
  type AppSort,
  type CreateAppInput,
  type UpdateAppInput,
} from './apps';
export {
  computeDiffOverlay,
  type DiffOverlay,
  type RemovedGhost,
} from './page-diff';

export {
  PEERS_ROOT_LABEL,
  PEER_TOKEN_PREFIX,
  createPeer,
  listPeers,
  getPeer,
  getOutboundToken,
  rotateInboundToken,
  setOutboundToken,
  setPeerEnabled,
  deletePeer,
  verifyInboundToken,
  grantPeerShare,
  revokePeerShare,
  listPeerShares,
  grantPeerTypeShare,
  revokePeerTypeShare,
  listPeerTypeShares,
  peerShareableTypeCounts,
  isPeerShareableType,
  PEER_SHAREABLE_TYPES,
  queryForPeer,
  searchChunksForPeer,
  activePeerGrantNodeIds,
  getNodeForPeer,
  markPeerContacted,
  hashToken,
  mintInboundToken,
  tokenMatchesHash,
  type PeerRow,
  type CreatePeerInput,
  type PeerShareRow,
  type PeerTypeShareRow,
  type PeerShareableType,
  type PeerQueryOpts,
  type PeerQueryHit,
  type PeerChunkHit,
  type PeerNodeDetail,
} from './peers';

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
  queryPeer,
  getPeerNode,
  searchPeerChunks,
  type PeerClientResult,
  type PeerQueryResult,
  type PeerChunkSearchResult,
} from './peers-client';

export {
  listPdfPasswords,
  createPdfPassword,
  deletePdfPassword,
  getPdfPasswordCandidates,
  markPdfPasswordUsed,
  type PdfPasswordRow,
} from './pdf-passwords';

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

export { docToText } from './doc-to-text';

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
} from './table-model';

export { evalFormula } from './table-formula';

export { tableToText, formatCellText } from './table-to-text';

export {
  listRows,
  type RowListResult,
  type RowListEntry,
  type RowListColumn,
  type ListRowsOptions,
} from './table-list';

export { markdownToDoc } from './markdown-to-doc';
export { docToMarkdown } from './doc-to-markdown';

export { ensureBlockIds, repairTableRows, allBlocksHaveIds, BLOCK_NODE_TYPES } from './block-ids';

export { listBlocks, type BlockListEntry, type ListBlocksOptions } from './block-list';

export {
  findBlock,
  replaceBlock,
  insertAfterBlock,
  deleteBlock,
  type FindResult,
  type PMBlockNode,
} from './block-edit';

export { diffBlocks, type BlockDiff, type BlockChange } from './block-diff';

export { referencedFileIds } from './doc-assets';

export {
  SHAREABLE_TYPES,
  isShareable,
  getActiveShareForNode,
  createShare,
  revokeShare,
  resolveActiveShareByToken,
  recordShareView,
  publicBaseUrl,
  shareUrlForToken,
  nodeUrl,
  shareModeOf,
  setShareMode,
  type ShareMode,
  type ShareableType,
  type ShareSummary,
} from './shares';
export {
  recordAppAccess,
  listAppAccess,
  type AppAccessKind,
  type AppAccessEntry,
  type AppAccessRow,
} from './app-access-log';

export {
  listTeamHubSections,
  listTeamApps,
  teamHubContentCounts,
  resolveTeamHubApp,
  TEAM_HUB_STAT_TYPES,
  type TeamHubSection,
  type TeamAppCard,
  type TeamHubStatType,
  type TeamHubApp,
} from './team-hub';

export {
  appendTeamMessage,
  updateTeamMessageOutcome,
  countTeamInboundSince,
  listTeamThread,
  recentTeamMessages,
  listTeamMemberActivity,
  markTeamThreadRead,
  type AppendTeamMessageInput,
  type UpdateTeamMessageOutcomeInput,
  type TeamMemberActivity,
} from './team-messages';

export {
  listTeamRequests,
  notifyTeamRequester,
  TEAM_REQUEST_TAG,
  type TeamRequest,
  type NotifyTeamRequesterResult,
} from './team-requests';

export {
  recordTeamAccess,
  listTeamAccess,
  type TeamAccessKind,
  type TeamAccessEntry,
  type TeamAccessRow,
} from './team-access-log';

export {
  renderPageEmail,
  cidForPageImage,
  type RenderPageEmailOptions,
  type RenderPageEmailResult,
} from './render-page-email';

export { renderDocx, type RenderDocxOptions, type LoadedImage } from './render-docx';
export { renderXlsx, type RenderXlsxOptions } from './render-xlsx';
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
export {
  chunkSpreadsheetProfile,
  hasSheetMarkers,
  isSpreadsheetTitle,
} from './chunk-spreadsheet';
export { fileFamilyKey } from './file-family';

export {
  mentionRefs,
  buildMentionParagraph,
  type MentionRefs,
  type MentionRef,
} from './mention-refs';

export {
  DEFAULT_PREFERENCES,
  loadProfilePreferences,
  updateProfilePreferences,
  noteInboundChannel,
  isValidTimezone,
  isValidLocale,
  isReminderChannel,
  isStreamThoughtsEnabled,
  resolveThoughtTrailMode,
  isPersistThoughtsEnabled,
  isTeamPrivateReadsEnabled,
  TEAM_PRIVATE_READ_SLUGS,
  resolveThinkingBudget,
  projectThinkingBudget,
  projectSiteName,
  projectTeamHubAppId,
  SITE_NAME_MAX,
  type ThoughtTrailMode,
  formatInProfile,
  buildTimeContextLine,
  type ProfilePreferences,
  type ReminderChannel,
} from './profile-preferences';

export {
  DEFAULT_BACKUP_CONFIG,
  isBackupDue,
  listBackups,
  loadBackupConfig,
  loadBackupStatus,
  maybeRunScheduledBackups,
  normalizeBackupConfig,
  resolveBackupDir,
  runBackup,
  saveBackupConfig,
  type BackupConfig,
  type BackupFile,
  type BackupFrequency,
  type BackupStatus,
} from './backup';

export {
  CONTACTS_ROOT_LABEL,
  // CRUD
  createContact,
  deleteContact,
  getContact,
  listContacts,
  countContacts,
  updateContact,
  // Gate + activity helpers used by the send path
  contactEmails,
  findContactsByEmails,
  recordContactSent,
  type ContactWriteResult,
  // Pure helpers (unit-tested) — exposed for callers + form validation
  classifyEntry,
  digitsOnly,
  deriveContactTitle,
  formatCell,
  hasIdentity,
  isPlausibleEmail,
  isPlausibleEmailOrDomain,
  normalizeCountryCode,
  normalizeEmail,
  normalizeEmailEntries,
  normalizeEmailEntry,
  partitionEmailEntries,
  toE164,
  type ContactCounts,
  type ContactLastAt,
  type ContactMethod,
  type ContactRow,
  type CreateContactInput,
  type EmailEntryKind,
  type UpdateContactInput,
} from './contacts';
export {
  enableTeamMember,
  disableTeamMember,
  rotateTeamToken,
  verifyTeamToken,
  teamStatusByContact,
  teamStatusFor,
  isTeamMember,
  markTeamTokenUsed,
  generateTeamToken,
  hashTeamToken,
  TEAM_TOKEN_LENGTH,
  type TeamStatus,
} from './team-tokens';

export { loadContactGate, type ContactGate } from './contact-gate';

export {
  MOODS,
  MOOD_KEYS,
  CATEGORIES,
  CATEGORY_KEYS,
  moodDisplay,
  categoryLabel,
  normalizeEntryDate,
  type MoodKey,
  type CategoryKey,
} from './journal-options';

export {
  JOURNAL_ROOT_LABEL,
  listJournals,
  countJournals,
  listJournalTags,
  getJournal,
  createJournal,
  updateJournal,
  deleteJournal,
  type JournalRow,
  type CreateJournalInput,
  type UpdateJournalInput,
} from './journal';

export {
  LOCATIONS_ROOT_LABEL,
  listLocations,
  countLocations,
  listLocationTags,
  getLocation,
  createLocation,
  updateLocation,
  deleteLocation,
  findNearbyLocations,
  haversineMeters,
  type LocationRow,
  type NearbyLocation,
  type CreateLocationInput,
  type UpdateLocationInput,
} from './locations';

export {
  sanitizeLocationPing,
  buildLocationContextLine,
  type LocationPing,
  type LocationSource,
} from './location-ping';

export {
  applyAutoTimezone,
  decideAutoTimezone,
  locationTrustedForTimezone,
  timezoneForCoords,
  TZ_TRUST_ACCURACY_M,
  type AutoTzDecision,
} from './auto-timezone';

export { buildIdentityContext } from './identity-context';

export {
  PURPOSE_ARCHETYPES,
  PURPOSE_ARCHETYPE_KEYS,
  isPurposeArchetype,
  purposeArchetypeLabel,
  deriveDisplayName,
  type PurposeArchetype,
} from './onboarding-questions';

export {
  PERSONA_PRESETS,
  DEFAULT_PERSONA_NAMES,
  buildPersonaPrompt,
  type PersonaGender,
  type PersonaPresetKey,
  type PersonaPreset,
} from './persona-bank';

export { getOwnedNode } from './nodes';
