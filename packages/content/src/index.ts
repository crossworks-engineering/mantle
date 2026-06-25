/**
 * @mantle/content — CRUD for the content surfaces: notes, todos, events,
 * and pages. Notes/todos/events store their payload in `nodes.data` (jsonb);
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
  TODOS_ROOT_LABEL,
  TODO_STATUSES,
  TODO_PRIORITIES,
  listTodos,
  countTodos,
  getTodo,
  createTodo,
  updateTodo,
  deleteTodo,
  type TodoRow,
  type TodoStatus,
  type TodoPriority,
  type CreateTodoInput,
  type UpdateTodoInput,
} from './todos';

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
  queryForPeer,
  getNodeForPeer,
  markPeerContacted,
  hashToken,
  mintInboundToken,
  tokenMatchesHash,
  type PeerRow,
  type CreatePeerInput,
  type PeerShareRow,
  type PeerQueryOpts,
  type PeerQueryHit,
  type PeerNodeDetail,
} from './peers';

export {
  queryPeer,
  getPeerNode,
  type PeerClientResult,
  type PeerQueryResult,
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
  type TableRow,
  type TableDetail,
  type TableVisibility,
  type TableSort,
  type CreateTableInput,
  type UpdateTableInput,
} from './tables';

export {
  emptyTableDoc,
  ensureTableDoc,
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
  type Column,
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
  type ShareableType,
  type ShareSummary,
} from './shares';

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

export { mentionRefs, type MentionRefs } from './mention-refs';

export {
  DEFAULT_PREFERENCES,
  loadProfilePreferences,
  updateProfilePreferences,
  noteInboundChannel,
  isValidTimezone,
  isValidLocale,
  isReminderChannel,
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
} from './lifelog-options';

export {
  LIFELOG_ROOT_LABEL,
  listLifelogs,
  countLifelogs,
  listLifelogTags,
  getLifelog,
  createLifelog,
  updateLifelog,
  deleteLifelog,
  type LifelogRow,
  type CreateLifelogInput,
  type UpdateLifelogInput,
} from './lifelog';

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
  ONBOARDING_QUESTIONS,
  composeBody,
  deriveDisplayName,
  type OnboardingQuestion,
} from './onboarding-questions';

export {
  PERSONA_PRESETS,
  DEFAULT_PERSONA_NAMES,
  buildPersonaPrompt,
  type PersonaGender,
  type PersonaPresetKey,
  type PersonaPreset,
} from './persona-bank';
