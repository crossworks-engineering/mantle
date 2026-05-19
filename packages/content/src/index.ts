/**
 * @mantle/content — CRUD for the small content types: notes, todos,
 * events. All three store their payload in `nodes.data` (jsonb) under
 * dedicated ltree roots (`notes`, `todos`, `events`). The extractor
 * picks them up automatically via the `node_ingested` pg_notify trigger.
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
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  listDueReminders,
  markReminderSent,
  ownersWithEvents,
  type EventRow,
  type CreateEventInput,
  type UpdateEventInput,
} from './events';

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
