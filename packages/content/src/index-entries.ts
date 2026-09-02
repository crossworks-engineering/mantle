/**
 * @mantle/content · entries
 *
 * Entry types — notes, tasks, events, journal entries, comments, contacts and ranking.
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
  sanitizeTodos,
  TASKS_CHANGED_CHANNEL,
  TASK_TODOS_MAX,
  TASK_TODO_TEXT_MAX,
  type TaskRow,
  type TaskStatus,
  type TaskStatusFilter,
  type TaskPriority,
  type TaskTodo,
  type TaskTodoInput,
  type CreateTaskInput,
  type UpdateTaskInput,
} from './tasks';

export { isValidRank, rankBetween, ranksAfter, RANK_RE } from './rank';

export {
  COMMENT_BODY_MAX,
  COMMENTS_CHANGED_CHANNEL,
  addNodeComment,
  deleteNodeComment,
  getNodeComment,
  isNodeTeamVisible,
  listNodeComments,
  resolveAgentAuthor,
  toNodeCommentDto,
  updateNodeComment,
  type CommentAuthor,
  type CommentViewer,
  type NodeComment,
  type NodeCommentAuthorKind,
} from './node-comments';

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
  KINDS,
  KIND_KEYS,
  USER_KIND_KEYS,
  AGENT_KIND_KEYS,
  GAP_STATUSES,
  kindLabel,
  kindLane,
  legacyCategoryToKind,
  normalizeEntryDate,
  type KindKey,
  type JournalLane,
  type GapStatus,
} from '@mantle/content-core/journal-options';

export {
  JOURNAL_ROOT_LABEL,
  listJournals,
  countJournals,
  listJournalTags,
  getJournal,
  createJournal,
  updateJournal,
  deleteJournal,
  resolveGapEntry,
  type JournalRow,
  type CreateJournalInput,
  type UpdateJournalInput,
  type ResolveGapInput,
} from './journal';
