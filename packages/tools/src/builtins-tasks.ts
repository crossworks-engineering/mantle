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
  createTask,
  deleteTask,
  getTask,
  listTasks,
  nodeUrl,
  updateTask,
  type TaskPriority,
  type TaskStatus,
} from '@mantle/content';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === 'string');
  return out.length > 0 ? out : undefined;
}

const task_list: BuiltinToolDef = {
  slug: 'task_list',
  name: 'List tasks',
  description:
    "List the user's tasks, **sorted open-first then by due date**. `status` filters by 'open' (default view is everything) or 'done'; `priority` filters by low/normal/high; `query` substring-matches title/body/summary; `tag` narrows to a tag. " +
    "**Use this for the active task picture** — 'what's open', 'anything due this week', 'high-priority tasks'. For topic search across tasks ('tasks about the printer') use `search_nodes` with `type='task'` — that's similarity-ranked, not due-date-ordered. For a single task's full body use `task_get`.",
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['open', 'done', 'all'] },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'all'] },
      query: { type: 'string', description: 'Optional substring filter against title/body.' },
      tag: { type: 'string' },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    try {
      const rows = await listTasks(ctx.ownerId, {
        status: input.status as TaskStatus | 'all' | undefined,
        priority: input.priority as TaskPriority | 'all' | undefined,
        query: strOpt(input.query),
        tag: strOpt(input.tag),
      });
      ctx.step?.setMeta({ count: rows.length });
      return { ok: true, output: { tasks: rows, count: rows.length } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const task_get: BuiltinToolDef = {
  slug: 'task_get',
  name: 'Get a task',
  description:
    "Read one task by id — full row including body, status, priority, due_at. " +
    "Use after `task_list` or `search_nodes` returns the id you want details on. " +
    "For browsing/filtering tasks use `task_list`. " +
    'Returns a `url` permalink — link the task as a markdown `[title](url)` when you reference it to the user.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const row = await getTask(ctx.ownerId, id);
    if (!row) return { ok: false, error: `task ${id} not found` };
    return { ok: true, output: { ...row, url: nodeUrl(row.id) } };
  },
};

const task_create: BuiltinToolDef = {
  slug: 'task_create',
  name: 'Create a task',
  description:
    "Create a task. `title` is a short imperative ('Renew passport'). `body` holds any detail. `priority` defaults to 'normal'. `dueAt`, if given, MUST be a UTC ISO 8601 instant — convert from the user's natural-language date using the system-prompt time context. Use this whenever the user asks you to remember to do something, add a task, or put something on their list.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string', description: 'Optional details / notes.' },
      priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      dueAt: {
        type: 'string',
        description: "Optional UTC ISO 8601 due date, e.g. '2026-06-01T09:00:00Z'.",
      },
      tags: { type: 'array', items: { type: 'string' } },
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
        priority: input.priority as TaskPriority | undefined,
        dueAt: strOpt(input.dueAt) ?? null,
        tags: strArr(input.tags),
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
    "Update an existing task. Any field omitted stays unchanged. Set `status: 'done'` to complete it. `dueAt` is a UTC ISO 8601 instant. Use this to mark tasks done, reprioritise, or edit details.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body: { type: 'string' },
      status: { type: 'string', enum: ['open', 'done'] },
      priority: { type: 'string', enum: ['low', 'normal', 'high'] },
      dueAt: { type: 'string', description: 'UTC ISO 8601.' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['id'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    try {
      const row = await updateTask(ctx.ownerId, id, {
        title: strOpt(input.title),
        body: strOpt(input.body),
        status: input.status as TaskStatus | undefined,
        priority: input.priority as TaskPriority | undefined,
        dueAt: strOpt(input.dueAt),
        tags: strArr(input.tags),
      });
      if (!row) return { ok: false, error: `task ${id} not found` };
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
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const ok = await deleteTask(ctx.ownerId, id);
    ctx.step?.setMeta({ taskId: id, deleted: ok });
    return ok
      ? { ok: true, output: { deleted: true, id } }
      : { ok: false, error: `task ${id} not found` };
  },
};

export const TASK_TOOLS: readonly BuiltinToolDef[] = [
  task_list,
  task_get,
  task_create,
  task_update,
  task_delete,
];

/** Canonical slug list — granted to conversational agents at boot so
 *  "add a task" works without manual /settings/tools setup. */
export const TASK_TOOL_SLUGS: readonly string[] = TASK_TOOLS.map((t) => t.slug);
