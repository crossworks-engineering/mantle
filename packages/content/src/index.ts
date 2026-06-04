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
  type EventRow,
  type CreateEventInput,
  type UpdateEventInput,
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
  type PageRow,
  type PageDetail,
  type PageVisibility,
  type PageWidth,
  type CreatePageInput,
  type UpdatePageInput,
} from './pages';

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

export { ensureBlockIds, allBlocksHaveIds, BLOCK_NODE_TYPES } from './block-ids';

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

export { chunkDocText, type DocChunk } from './chunk';

export { mentionRefs, type MentionRefs } from './mention-refs';

export {
  DEFAULT_PREFERENCES,
  loadProfilePreferences,
  updateProfilePreferences,
  isValidTimezone,
  isValidLocale,
  formatInProfile,
  buildTimeContextLine,
  type ProfilePreferences,
} from './profile-preferences';

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

export { buildIdentityContext } from './identity-context';
