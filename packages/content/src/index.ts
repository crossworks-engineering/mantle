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

export { docToText } from './doc-to-text';

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
  // Pure helpers (unit-tested) — exposed for callers + form validation
  digitsOnly,
  deriveContactTitle,
  formatCell,
  hasIdentity,
  isPlausibleEmail,
  normalizeCountryCode,
  normalizeEmail,
  toE164,
  type ContactCounts,
  type ContactLastAt,
  type ContactMethod,
  type ContactRow,
  type CreateContactInput,
  type UpdateContactInput,
} from './contacts';
