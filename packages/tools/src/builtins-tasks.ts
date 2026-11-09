/**
 * Builtin task tools — Saskia's task surface.
 *
 * Mirrors the MCP task tools so the responder / assistant can read and
 * write the same tasks Claude Code can, without going through MCP. Same
 * underlying @mantle/content helpers; same data shape.
 *
 * None require_confirm: a task is trivially reversible (toggle status,
 * delete + recreate). Operators who want an approval gate can flip
 * requires_confirm on the row in the tools table via the UI.
 *
 * Time-aware: `dueAt` is a UTC ISO 8601 instant — the system-prompt time
 * context tells Saskia to convert the user's natural-language date to UTC
 * before calling, exactly like event_create's startsAt.
 */

import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TODOS_MAX,
  TASK_TODO_TEXT_MAX,
  countTasks,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  nodeUrl,
  updateTask,
  addTaskFile,
  readTaskFile,
  removeTaskFile,
  withTaskFiles,
  TASK_FILE_EXTS,
  TASK_FILE_MAX_BYTES,
  TASK_FILES_MAX,
  type TaskPriority,
  type TaskStatus,
  type TaskStatusFilter,
  type TaskTodoInput,
} from '@mantle/content';
import type { BuiltinToolDef, ToolHandlerResult, ToolPrecondition } from './types';
import { str, strArr, strArrOpt, strOpt } from './coerce';
import { notFound } from './errors';
import { errorMessage } from '@mantle/std';
import { CS } from './client-sourced-rule';

// Shared referential precondition (checked centrally in dispatch — see
// preconditions.ts): the id must name an EXISTING task the owner holds.
const TASK_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'task', lookup: 'task_list / search_nodes' },
];

/** Coerce a `todos` arg (full-replace checklist). `[]` clears the list.
 *  STRICT on malformed items: silently dropping them would wipe a checklist
 *  when a model mis-names a field (e.g. `title` for `text`) and still report
 *  success — instead the error names the fix so the model retries once. */
function todosOpt(v: unknown): { todos?: TaskTodoInput[]; error?: string } {
  if (!Array.isArray(v)) return {};
  const out: TaskTodoInput[] = [];
  for (const [i, raw] of v.entries()) {
    const item = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    if (!item || typeof item.text !== 'string' || !item.text.trim()) {
      return {
        error: `todos[${i}] has no usable \`text\` — each checklist item is {text, done?, id?}; re-send the FULL edited list (read the task first with task_get)`,
      };
    }
    out.push({
      id: typeof item.id === 'string' ? item.id : undefined,
      text: item.text,
      done: item.done === true,
    });
  }
  return { todos: out };
}

/** JSON-schema fragment for the `todos` param (shared by create/update). */
const TODOS_SCHEMA = {
  type: 'array',
  maxItems: TASK_TODOS_MAX,
  items: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Existing item id when editing; omit for new items.',
      },
      text: {
        type: 'string',
        minLength: 1,
        maxLength: TASK_TODO_TEXT_MAX,
        description: "The step itself, e.g. 'Book the venue'.",
      },
      done: { type: 'boolean', description: 'Whether this step is finished.' },
    },
    required: ['text'],
  },
} as const;

const task_list: BuiltinToolDef = {
  slug: 'task_list',
  usageTier: 3,
  policy: { effect: 'read', spends: 'none', scope: 'any', keyArea: 'tasks' },
  name: 'List tasks',
  description:
    "List the user's tasks, **sorted not-done-first then by board order and due date**. `status` filters by lifecycle state ('active' = everything not done); `priority` filters by urgency; `query` substring-matches title/body/summary; `tag` narrows to a tag. " +
    "**Use this for the active task picture** — 'what's open', 'anything due this week', 'high-priority tasks'. For topic search across tasks ('tasks about the printer') use `search_nodes` with `type='task'` — that's similarity-ranked, not due-date-ordered. For a single task's full body use `task_get`.",
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...TASK_STATUSES, 'active', 'all'],
        description: "Filter by lifecycle state; 'active' = everything not done.",
      },
      priority: {
        type: 'string',
        enum: [...TASK_PRIORITIES, 'all'],
        description: 'Filter by urgency; omit to include everything.',
      },
      query: { type: 'string', description: 'Optional substring filter against title/body.' },
      tag: { type: 'string', description: 'Only return tasks carrying this tag.' },
      archived: {
        type: 'string',
        enum: ['only', 'all'],
        description:
          "Archived tasks are hidden by default. 'only' searches the archive, 'all' spans both. Omit unless the user asks about filed-away work.",
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: 100,
        description: 'Max tasks to return.',
      },
      offset: {
        type: 'number',
        minimum: 0,
        default: 0,
        description: 'Skip this many tasks (paging through a long list).',
      },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    try {
      const limit = typeof input.limit === 'number' ? Math.min(500, Math.max(1, input.limit)) : 100;
      const offset = typeof input.offset === 'number' ? Math.max(0, input.offset) : 0;
      const opts = {
        status: input.status as TaskStatusFilter | undefined,
        priority: input.priority as TaskPriority | 'all' | undefined,
        query: strOpt(input.query),
        tag: strOpt(input.tag),
        archived: input.archived as 'only' | 'all' | undefined,
      };
      const [rows, total] = await Promise.all([
        listTasks(ctx.ownerId, { ...opts, limit, offset }),
        countTasks(ctx.ownerId, opts),
      ]);
      ctx.step?.setMeta({ count: rows.length, total });
      // A clipped page self-announces so it can't be mistaken for the whole.
      const truncated = offset + rows.length < total;
      return { ok: true, output: { tasks: rows, count: rows.length, total, truncated } };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

const task_get: BuiltinToolDef = {
  slug: 'task_get',
  usageTier: 2,
  policy: {
    matrix: { action: 'read', param: 'id', kinds: ['task'] },
    effect: 'read',
    spends: 'none',
    scope: 'any',
    keyArea: 'tasks',
  },
  name: 'Get a task',
  description:
    'Read one task by id — full row including body, status, priority, due_at, and `files` (the screenshots, logs and PDFs on it; open one with `task_file_get`). ' +
    'Use after `task_list` or `search_nodes` returns the id you want details on. ' +
    'For browsing/filtering tasks use `task_list`. ' +
    'Returns a `url` permalink — link the task as a markdown `[title](url)` when you reference it to the user.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: "The task's id (UUID) — from `task_list` / `search_nodes`.",
      },
    },
    required: ['id'],
  },
  preconditions: TASK_ID_PRE,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const row = await getTask(ctx.ownerId, id);
    if (!row) return notFound('task', id, 'task_list');
    // The one-task read carries its files (task_file_get opens one).
    return {
      ok: true,
      output: { ...(await withTaskFiles(ctx.ownerId, row)), url: nodeUrl(row.id) },
    };
  },
};

const task_create: BuiltinToolDef = {
  slug: 'task_create',
  usageTier: 4,
  policy: {
    matrix: {
      none: 'a create naming no folder: it lands by the home rule (turn-create-home tests)',
    },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    creates: 'task',
    keyArea: 'tasks',
    clientSourced: CS.creates(),
  },
  name: 'Create a task',
  description:
    "Create a task. `title` is a short imperative ('Renew passport'). `body` holds any detail; `todos` breaks the work into checklist steps. `priority` defaults to 'normal'. `dueAt`, if given, MUST be a UTC ISO 8601 instant — convert from the user's natural-language date using the system-prompt time context. Use this whenever the user asks you to remember to do something, add a task, or put something on their list.",
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: "Short imperative title, e.g. 'Renew passport'.",
      },
      body: { type: 'string', description: 'Optional details / notes.' },
      status: {
        type: 'string',
        enum: [...TASK_STATUSES],
        default: 'open',
        description: 'Starting lifecycle state.',
      },
      priority: {
        type: 'string',
        enum: [...TASK_PRIORITIES],
        description: "How urgent it is; defaults to 'normal' when omitted.",
      },
      dueAt: {
        type: 'string',
        description: "Optional UTC ISO 8601 due date, e.g. '2026-06-01T09:00:00Z'.",
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['work'].",
      },
      todos: {
        ...TODOS_SCHEMA,
        description: 'Optional checklist breaking the task into steps.',
      },
    },
    required: ['title'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const title = str(input.title).trim();
    if (!title) return { ok: false, error: 'title required' };
    const todos = todosOpt(input.todos);
    if (todos.error) return { ok: false, error: todos.error };
    try {
      const row = await createTask(ctx.ownerId, {
        title,
        body: strOpt(input.body),
        status: input.status as TaskStatus | undefined,
        priority: input.priority as TaskPriority | undefined,
        dueAt: strOpt(input.dueAt) ?? null,
        tags: strArrOpt(input.tags),
        todos: todos.todos,
      });
      ctx.step?.setMeta({ taskId: row.id, title, priority: row.priority, dueAt: row.dueAt });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

const task_update: BuiltinToolDef = {
  slug: 'task_update',
  policy: {
    destructive: true, // todos replaces the whole checklist; no revision
    matrix: { action: 'edit', param: 'id', kinds: ['task'] },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'id' }],
    keyArea: 'tasks',
    clientSourced: CS.onNodes('id'),
  },
  name: 'Update a task',
  description:
    "Update an existing task. Any field omitted stays unchanged. Set `status: 'done'` to complete it, 'in_progress'/'blocked' to track work. To undo a completion, send `reopen: true` with no status: the task goes back to the status it had before it was marked done. `dueAt` is a UTC ISO 8601 instant; pass '' to clear it (same for `body`, and `tags: []` empties the list). `todos` replaces the WHOLE checklist — read the task first, then send the edited list. Use this to mark tasks done, reprioritise, tick checklist steps, or edit details. Tasks have no comments: record progress or a note in `body` (read it first and append).",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: "The task's id (UUID) — from `task_list` / `search_nodes`.",
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'New title; omit to keep current.',
      },
      body: {
        type: 'string',
        description: "New details / notes; omit to keep current, '' to clear.",
      },
      status: {
        type: 'string',
        enum: [...TASK_STATUSES],
        description: 'New lifecycle state; omit to keep current.',
      },
      priority: {
        type: 'string',
        enum: [...TASK_PRIORITIES],
        description: 'New urgency; omit to keep current.',
      },
      dueAt: {
        type: 'string',
        description: "New due instant (UTC ISO 8601), e.g. '2026-07-10T09:00:00Z'; '' clears it.",
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Replaces the whole tag list, e.g. ['work']; omit to keep current, [] to clear.",
      },
      todos: {
        ...TODOS_SCHEMA,
        description:
          'Replaces the whole checklist; keep item `id`s when editing so history stays stable. [] clears it.',
      },
      archived: {
        type: 'boolean',
        description:
          'true files the task away (hidden from lists and the board without deleting it); false restores it. Archiving does not change the status. Prefer this over deleting finished work.',
      },
      reopen: {
        type: 'boolean',
        description:
          "true takes a done task back to the status it had before it was marked done ('open' when unknown). An explicit `status` wins over it.",
      },
    },
    required: ['id'],
  },
  preconditions: TASK_ID_PRE,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const todos = todosOpt(input.todos);
    if (todos.error) return { ok: false, error: todos.error };
    try {
      const row = await updateTask(ctx.ownerId, id, {
        title: strOpt(input.title),
        // '' is a deliberate clear for body/dueAt; [] empties tags/todos —
        // strOpt/strArrOpt would eat those, so coerce explicitly here.
        body: typeof input.body === 'string' ? input.body : undefined,
        status: input.status as TaskStatus | undefined,
        priority: input.priority as TaskPriority | undefined,
        dueAt: input.dueAt === '' ? null : strOpt(input.dueAt),
        tags: Array.isArray(input.tags) ? strArr(input.tags) : undefined,
        todos: todos.todos,
        // Server owns the clock, same as the HTTP route.
        ...(typeof input.archived === 'boolean'
          ? { archivedAt: input.archived ? new Date().toISOString() : null }
          : {}),
        ...(input.reopen === true ? { reopen: true } : {}),
      });
      if (!row) return notFound('task', id, 'task_list');
      ctx.step?.setMeta({ taskId: id, status: row.status });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

const task_delete: BuiltinToolDef = {
  slug: 'task_delete',
  policy: {
    destructive: true, // the task is gone
    matrix: { action: 'delete', param: 'id', kinds: ['task'] },
    deletesItem: true,
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'id' }],
    keyArea: 'tasks',
    clientSourced: CS.onNodes('id'),
  },
  name: 'Delete a task',
  description:
    "Delete a task by id, with the files on it. Prefer task_update with status='done' to complete a task; only delete when the user explicitly wants it gone. Confirm first unless they named this specific task.",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: "The task's id (UUID) — from `task_list` / `search_nodes`.",
      },
    },
    required: ['id'],
  },
  preconditions: TASK_ID_PRE,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const ok = await deleteTask(ctx.ownerId, id);
    ctx.step?.setMeta({ taskId: id, deleted: ok });
    return ok ? { ok: true, output: { deleted: true, id } } : notFound('task', id, 'task_list');
  },
};

// ─── Files on tasks (plan page 74b70ac6) ─────────────────────────────────────
// A task file is a normal file node in the task's own Auto-filed folder. The
// task's right is the one rule: read the task to open its files, edit it to
// add or remove one (@mantle/content task-files.ts).

const FILE_ID_SCHEMA = {
  type: 'string',
  description: "The file's id, from the task's `files` (task_get).",
} as const;

/** Image types a model can see (ToolModelImage). */
const MODEL_IMAGE: Record<string, 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
/** Text types whose words come back as `content`. */
const TEXT_TYPES = new Set(['txt', 'log', 'md', 'json', 'csv']);
/** The most text one read gives the model. */
const TEXT_READ_MAX = 200_000;

const task_file_add: BuiltinToolDef = {
  slug: 'task_file_add',
  policy: {
    matrix: { action: 'edit', param: 'id', kinds: ['task'] },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'id' }],
    keyArea: 'tasks',
    clientSourced: CS.onNodes('id'),
  },
  name: 'Put a file on a task',
  description: `Put one file on a task: a screenshot, a log or a PDF. Pass \`content_base64\` (binary) or \`content_text\` (utf-8). Types: ${TASK_FILE_EXTS.join(', ')}. At most ${TASK_FILE_MAX_BYTES / 1024 / 1024} MB per file and ${TASK_FILES_MAX} files per task. A name already on the task gets -2, -3. Who reads the task opens the file.`,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: "The task's id (UUID), from `task_list` / `search_nodes`.",
      },
      filename: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: "Name with its extension, e.g. 'error.log' or 'screenshot.png'.",
      },
      content_base64: { type: 'string', description: 'base64 bytes, for an image or a PDF' },
      content_text: { type: 'string', description: 'utf-8 text, for a log or a text file' },
    },
    required: ['id', 'filename'],
  },
  preconditions: TASK_ID_PRE,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    const filename = str(input.filename);
    if (!id || !filename) return { ok: false, error: 'id and filename required' };
    const text = typeof input.content_text === 'string' ? input.content_text : undefined;
    const b64 = typeof input.content_base64 === 'string' ? input.content_base64 : undefined;
    if ((text == null) === (b64 == null)) {
      return {
        ok: false,
        error: 'task_file_add: pass content_text or content_base64 (one of them)',
      };
    }
    const bytes = text != null ? Buffer.from(text, 'utf8') : Buffer.from(b64!, 'base64');
    try {
      const file = await addTaskFile({ ownerId: ctx.ownerId, taskId: id, filename, bytes });
      if (!file) return notFound('task', id, 'task_list');
      ctx.step?.setMeta({ taskId: id, fileId: file.id });
      return { ok: true, output: { file, taskId: id } };
    } catch (err) {
      return { ok: false, error: `task_file_add: ${errorMessage(err)}` };
    }
  },
};

const task_file_get: BuiltinToolDef = {
  slug: 'task_file_get',
  policy: {
    matrix: { action: 'read', param: 'id', kinds: ['task'] },
    effect: 'read',
    spends: 'none',
    scope: 'any',
    keyArea: 'tasks',
  },
  name: 'Open a file on a task',
  description:
    "Open one file on a task. An image comes back as a picture you can see; a text file or a log as `content`; a PDF as its name and size only. The ids are in the task's `files` (task_get).",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: "The task's id (UUID), from `task_list` / `search_nodes`.",
      },
      file_id: FILE_ID_SCHEMA,
    },
    required: ['id', 'file_id'],
  },
  preconditions: TASK_ID_PRE,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    const fileId = str(input.file_id);
    if (!id || !fileId) return { ok: false, error: 'id and file_id required' };
    const res = await readTaskFile(ctx.ownerId, id, fileId);
    if (!res)
      return {
        ok: false,
        error: `no file ${fileId} on task ${id}: read the task's files with task_get`,
      };
    const { row, bytes } = res;
    const file = {
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    };
    const ext = row.extension.toLowerCase();
    const image = MODEL_IMAGE[ext];
    if (image) {
      return {
        ok: true,
        output: { file, shown: 'the picture follows as an image' },
        modelImages: [{ mimeType: image, base64: bytes.toString('base64') }],
      };
    }
    if (TEXT_TYPES.has(ext)) {
      const all = bytes.toString('utf8');
      const truncated = all.length > TEXT_READ_MAX;
      return {
        ok: true,
        output: { file, content: truncated ? all.slice(0, TEXT_READ_MAX) : all, truncated },
      };
    }
    return { ok: true, output: { file, note: 'A PDF is not read here: its name and size only.' } };
  },
};

const task_file_remove: BuiltinToolDef = {
  slug: 'task_file_remove',
  policy: {
    destructive: true, // the file is deleted
    matrix: { action: 'edit', param: 'id', kinds: ['task'] },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    itemArgs: [{ param: 'id' }],
    keyArea: 'tasks',
    clientSourced: CS.onNodes('id'),
  },
  name: 'Take a file off a task',
  description:
    "Take one file off a task. The file is deleted. The ids are in the task's `files` (task_get). Confirm first unless the user named this file.",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: "The task's id (UUID), from `task_list` / `search_nodes`.",
      },
      file_id: FILE_ID_SCHEMA,
    },
    required: ['id', 'file_id'],
  },
  preconditions: TASK_ID_PRE,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    const fileId = str(input.file_id);
    if (!id || !fileId) return { ok: false, error: 'id and file_id required' };
    const ok = await removeTaskFile(ctx.ownerId, id, fileId);
    ctx.step?.setMeta({ taskId: id, fileId, removed: ok });
    return ok
      ? { ok: true, output: { removed: true, id, fileId } }
      : {
          ok: false,
          error: `no file ${fileId} on task ${id}: read the task's files with task_get`,
        };
  },
};

export const TASK_TOOLS: readonly BuiltinToolDef[] = [
  task_list,
  task_get,
  task_create,
  task_update,
  task_delete,
  task_file_add,
  task_file_get,
  task_file_remove,
];

/** Canonical slug list — granted to conversational agents at boot so
 *  "add a task" works without manual /settings/tools setup. */
export const TASK_TOOL_SLUGS: readonly string[] = TASK_TOOLS.map((t) => t.slug);
