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
  addNodeComment,
  countTasks,
  createTask,
  deleteTask,
  getTask,
  listNodeComments,
  listTasks,
  nodeUrl,
  toNodeCommentDto,
  updateTask,
  type TaskPriority,
  type TaskStatus,
  type TaskTodoInput,
} from '@mantle/content';
import type { BuiltinToolDef, ToolHandlerResult, ToolPrecondition } from './types';
import { str, strArr, strArrOpt } from './coerce';
import { notFound } from './errors';

// Shared referential precondition (checked centrally in dispatch — see
// preconditions.ts): the id must name an EXISTING task the owner holds.
const TASK_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'task', lookup: 'task_list / search_nodes' },
];

function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Coerce a `todos` arg (full-replace checklist). `[]` clears the list. */
function todosOpt(v: unknown): TaskTodoInput[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: TaskTodoInput[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.text !== 'string' || !item.text.trim()) continue;
    out.push({
      id: typeof item.id === 'string' ? item.id : undefined,
      text: item.text,
      done: item.done === true,
    });
  }
  return out;
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
  name: 'List tasks',
  description:
    "List the user's tasks, **sorted not-done-first then by board order and due date**. `status` filters by lifecycle state (open/in_progress/blocked/done); `priority` filters by low/normal/high; `query` substring-matches title/body/summary; `tag` narrows to a tag. " +
    "**Use this for the active task picture** — 'what's open', 'anything due this week', 'high-priority tasks'. For topic search across tasks ('tasks about the printer') use `search_nodes` with `type='task'` — that's similarity-ranked, not due-date-ordered. For a single task's full body use `task_get`.",
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...TASK_STATUSES, 'all'],
        description: 'Filter by lifecycle state; omit to include everything.',
      },
      priority: {
        type: 'string',
        enum: [...TASK_PRIORITIES, 'all'],
        description: 'Filter by urgency; omit to include everything.',
      },
      query: { type: 'string', description: 'Optional substring filter against title/body.' },
      tag: { type: 'string', description: 'Only return tasks carrying this tag.' },
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
        status: input.status as TaskStatus | 'all' | undefined,
        priority: input.priority as TaskPriority | 'all' | undefined,
        query: strOpt(input.query),
        tag: strOpt(input.tag),
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const task_get: BuiltinToolDef = {
  slug: 'task_get',
  name: 'Get a task',
  description:
    'Read one task by id — full row including body, status, priority, due_at. ' +
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
    return { ok: true, output: { ...row, url: nodeUrl(row.id) } };
  },
};

const task_create: BuiltinToolDef = {
  slug: 'task_create',
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
        description: "Starting lifecycle state; defaults to 'open'.",
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
    try {
      const row = await createTask(ctx.ownerId, {
        title,
        body: strOpt(input.body),
        status: input.status as TaskStatus | undefined,
        priority: input.priority as TaskPriority | undefined,
        dueAt: strOpt(input.dueAt) ?? null,
        tags: strArrOpt(input.tags),
        todos: todosOpt(input.todos),
      });
      ctx.step?.setMeta({ taskId: row.id, title, priority: row.priority, dueAt: row.dueAt });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const task_update: BuiltinToolDef = {
  slug: 'task_update',
  name: 'Update a task',
  description:
    "Update an existing task. Any field omitted stays unchanged. Set `status: 'done'` to complete it, 'in_progress'/'blocked' to track work. `dueAt` is a UTC ISO 8601 instant; pass '' to clear it (same for `body`, and `tags: []` empties the list). `todos` replaces the WHOLE checklist — read the task first, then send the edited list. Use this to mark tasks done, reprioritise, tick checklist steps, or edit details.",
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
    },
    required: ['id'],
  },
  preconditions: TASK_ID_PRE,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
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
        todos: todosOpt(input.todos),
      });
      if (!row) return notFound('task', id, 'task_list');
      ctx.step?.setMeta({ taskId: id, status: row.status });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const task_delete: BuiltinToolDef = {
  slug: 'task_delete',
  name: 'Delete a task',
  description:
    "Delete a task by id. Prefer task_update with status='done' to complete a task; only delete when the user explicitly wants it gone. Confirm first unless they named this specific task.",
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

const task_comments_list: BuiltinToolDef = {
  slug: 'task_comments_list',
  name: 'List task comments',
  description:
    "Read a task's comment thread, oldest first — who said what (`authorKind` owner/member/agent + `authorName`) and when. Use before commenting so you reply in context, or when the user asks what was discussed on a task. For the task's own fields use `task_get`.",
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
    const rows = await listNodeComments(ctx.ownerId, id);
    // Agents have no login/contact identity — nothing is ever "mine" here.
    const comments = rows.map((r) => toNodeCommentDto(r, {}));
    ctx.step?.setMeta({ taskId: id, count: comments.length });
    return { ok: true, output: { comments, count: comments.length } };
  },
};

const task_comment_add: BuiltinToolDef = {
  slug: 'task_comment_add',
  name: 'Comment on a task',
  description:
    "Add a comment to a task's discussion thread — a progress note, a question, or an answer the owner and team members will see attributed to you. Use when reporting work done on a task or responding to the thread; for changing the task itself (status, checklist, due date) use `task_update` instead.",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: "The task's id (UUID) — from `task_list` / `search_nodes`.",
      },
      body: {
        type: 'string',
        minLength: 1,
        maxLength: 10_000,
        description: 'The comment text (markdown).',
      },
    },
    required: ['id', 'body'],
  },
  preconditions: TASK_ID_PRE,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    const body = str(input.body).trim();
    if (!id) return { ok: false, error: 'id required' };
    if (!body) return { ok: false, error: 'body required' };
    // Attribution from the runtime context (never from model args): the
    // calling agent's slug, or a neutral name on the MCP/background paths.
    const row = await addNodeComment(
      ctx.ownerId,
      id,
      { kind: 'agent', name: ctx.agent?.slug ?? 'Assistant' },
      body,
    );
    if (!row) return notFound('task', id, 'task_list');
    ctx.step?.setMeta({ taskId: id, commentId: row.id });
    return { ok: true, output: toNodeCommentDto(row, {}) };
  },
};

export const TASK_TOOLS: readonly BuiltinToolDef[] = [
  task_list,
  task_get,
  task_create,
  task_update,
  task_delete,
  task_comments_list,
  task_comment_add,
];

/** Canonical slug list — granted to conversational agents at boot so
 *  "add a task" works without manual /settings/tools setup. */
export const TASK_TOOL_SLUGS: readonly string[] = TASK_TOOLS.map((t) => t.slug);
