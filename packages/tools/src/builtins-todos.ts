/**
 * Builtin todo tools — Saskia's task surface.
 *
 * Mirrors the MCP todo tools so the responder / assistant can read and
 * write the same todos Claude Code can, without going through MCP. Same
 * underlying @mantle/content helpers; same data shape.
 *
 * None require_confirm: a todo is trivially reversible (toggle status,
 * delete + recreate). Operators who want an approval gate can flip
 * requires_confirm on the row in the tools table via the UI.
 *
 * Time-aware: `dueAt` is a UTC ISO 8601 instant — the system-prompt time
 * context tells Saskia to convert the user's natural-language date to UTC
 * before calling, exactly like event_create's startsAt.
 */

import {
  createTodo,
  deleteTodo,
  getTodo,
  listTodos,
  nodeUrl,
  updateTodo,
  type TodoPriority,
  type TodoStatus,
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

const todo_list: BuiltinToolDef = {
  slug: 'todo_list',
  name: 'List todos',
  description:
    "List the user's todos / tasks, **sorted open-first then by due date**. `status` filters by 'open' (default view is everything) or 'done'; `priority` filters by low/normal/high; `query` substring-matches title/body/summary; `tag` narrows to a tag. " +
    "**Use this for the active task picture** — 'what's open', 'anything due this week', 'high-priority todos'. For topic search across todos ('todos about the printer') use `search_nodes` with `type='task'` — that's similarity-ranked, not due-date-ordered. For a single todo's full body use `todo_get`.",
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
      const rows = await listTodos(ctx.ownerId, {
        status: input.status as TodoStatus | 'all' | undefined,
        priority: input.priority as TodoPriority | 'all' | undefined,
        query: strOpt(input.query),
        tag: strOpt(input.tag),
      });
      ctx.step?.setMeta({ count: rows.length });
      return { ok: true, output: { todos: rows, count: rows.length } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const todo_get: BuiltinToolDef = {
  slug: 'todo_get',
  name: 'Get a todo',
  description:
    "Read one todo by id — full row including body, status, priority, due_at. " +
    "Use after `todo_list` or `search_nodes` returns the id you want details on. " +
    "For browsing/filtering todos use `todo_list`. " +
    'Returns a `url` permalink — link the todo as a markdown `[title](url)` when you reference it to the user.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const row = await getTodo(ctx.ownerId, id);
    if (!row) return { ok: false, error: `todo ${id} not found` };
    return { ok: true, output: { ...row, url: nodeUrl(row.id) } };
  },
};

const todo_create: BuiltinToolDef = {
  slug: 'todo_create',
  name: 'Create a todo',
  description:
    "Create a todo / task. `title` is a short imperative ('Renew passport'). `body` holds any detail. `priority` defaults to 'normal'. `dueAt`, if given, MUST be a UTC ISO 8601 instant — convert from the user's natural-language date using the system-prompt time context. Use this whenever the user asks you to remember to do something, add a task, or put something on their list.",
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
      const row = await createTodo(ctx.ownerId, {
        title,
        body: strOpt(input.body),
        priority: input.priority as TodoPriority | undefined,
        dueAt: strOpt(input.dueAt) ?? null,
        tags: strArr(input.tags),
      });
      ctx.step?.setMeta({ todoId: row.id, title, priority: row.priority, dueAt: row.dueAt });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const todo_update: BuiltinToolDef = {
  slug: 'todo_update',
  name: 'Update a todo',
  description:
    "Update an existing todo. Any field omitted stays unchanged. Set `status: 'done'` to complete it. `dueAt` is a UTC ISO 8601 instant. Use this to mark tasks done, reprioritise, or edit details.",
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
      const row = await updateTodo(ctx.ownerId, id, {
        title: strOpt(input.title),
        body: strOpt(input.body),
        status: input.status as TodoStatus | undefined,
        priority: input.priority as TodoPriority | undefined,
        dueAt: strOpt(input.dueAt),
        tags: strArr(input.tags),
      });
      if (!row) return { ok: false, error: `todo ${id} not found` };
      ctx.step?.setMeta({ todoId: id, status: row.status });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const todo_delete: BuiltinToolDef = {
  slug: 'todo_delete',
  name: 'Delete a todo',
  description:
    "Delete a todo by id. Prefer todo_update with status='done' to complete a task; only delete when the user explicitly wants it gone. Confirm first unless they named this specific todo.",
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const ok = await deleteTodo(ctx.ownerId, id);
    ctx.step?.setMeta({ todoId: id, deleted: ok });
    return ok
      ? { ok: true, output: { deleted: true, id } }
      : { ok: false, error: `todo ${id} not found` };
  },
};

export const TODO_TOOLS: readonly BuiltinToolDef[] = [
  todo_list,
  todo_get,
  todo_create,
  todo_update,
  todo_delete,
];

/** Canonical slug list — granted to conversational agents at boot so
 *  "add a todo" works without manual /settings/tools setup. */
export const TODO_TOOL_SLUGS: readonly string[] = TODO_TOOLS.map((t) => t.slug);
