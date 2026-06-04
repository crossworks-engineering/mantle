/**
 * Life Log builtins — the user's personal life log: short first-person entries
 * about who they are, what they do, and how they feel, each with an optional
 * mood + life-area category.
 *
 * Why agents get these: Life Logs are the source of the always-on "who you are"
 * identity block (see @mantle/content buildIdentityContext). Letting the
 * assistant *add* to them means a user can say "remember that I just started a
 * new job as a teacher" or "log that I'm feeling anxious about the move" and
 * have it become durable self-knowledge that grounds every future turn.
 *
 * All `nodes` of type='lifelog'; create/update goes through @mantle/content
 * which fires the extractor, so each entry is summarised + embedded + its
 * facts land in the brain (search_nodes finds them too). Entries also feed the
 * identity context. Delete is left OFF the auto-grant (destructive).
 */

import {
  createLifelog,
  deleteLifelog,
  getLifelog,
  listLifelogs,
  updateLifelog,
  MOOD_KEYS,
  CATEGORY_KEYS,
  type LifelogRow,
} from '@mantle/content';
import type { BuiltinToolDef } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}
function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** Compact projection — light context, everything an agent needs to reason. */
function compact(n: LifelogRow) {
  return {
    id: n.id,
    title: n.title,
    body: n.body,
    mood: n.mood,
    category: n.category,
    entry_date: n.entryDate,
    tags: n.tags,
    summary: n.summary,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
  };
}

const MOOD_DESC = `Optional mood. Prefer one of: ${MOOD_KEYS.join(', ')}.`;
const CATEGORY_DESC = `Optional life area. Prefer one of: ${CATEGORY_KEYS.join(', ')}.`;

// ─── read ──────────────────────────────────────────────────────────────────

const lifelog_list: BuiltinToolDef = {
  slug: 'lifelog_list',
  name: 'List life logs',
  description:
    "Browse the user's Life Log — their own notes about who they are, their work, family, faith, health, goals, and feelings, newest first. Use to recall what the user has told you about themselves. Optional `mood` / `category` / `query` narrow the list. For a topic search across everything, `search_nodes` is broader.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'substring match on title/body' },
      mood: { type: 'string', description: `filter by mood (${MOOD_KEYS.join(', ')})` },
      category: { type: 'string', description: `filter by area (${CATEGORY_KEYS.join(', ')})` },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      offset: { type: 'integer', minimum: 0, default: 0 },
    },
  },
  handler: async (input, ctx) => {
    const limit = Math.min(num(input.limit, 30), 100);
    const offset = Math.max(0, num(input.offset, 0));
    const rows = await listLifelogs(ctx.ownerId, {
      query: strOpt(input.query),
      mood: strOpt(input.mood),
      category: strOpt(input.category),
      limit,
      offset,
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: { count: rows.length, lifelogs: rows.map(compact) } };
  },
};

const lifelog_get: BuiltinToolDef = {
  slug: 'lifelog_get',
  name: 'Read a life log',
  description: 'Fetch one life log entry by its node id. Returns the full entry.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid' } },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const row = await getLifelog(ctx.ownerId, id);
    if (!row) return { ok: false, error: 'life log not found' };
    return { ok: true, output: compact(row) };
  },
};

// ─── write ─────────────────────────────────────────────────────────────────

const lifelog_create: BuiltinToolDef = {
  slug: 'lifelog_create',
  name: 'Add a life log',
  description:
    "Record a short, first-person entry in the user's Life Log — something durable about who they are, what they're doing, or how they feel (e.g. \"I started a new role as a maths teacher\", \"feeling anxious about the move next month\", \"I value honesty above almost everything\"). Keep `body` to a short paragraph. This becomes part of the assistant's always-on understanding of the user, so write it in the user's voice. " +
    'Use when the user shares something about themselves and asks you to remember it, or clearly wants it on the record — not for transient task/calendar items (use todo_create / event_create) or secrets (secret_create).',
  inputSchema: {
    type: 'object',
    properties: {
      body: { type: 'string', description: 'the entry — a short first-person paragraph' },
      title: { type: 'string', description: 'optional short title; auto-derived from body if omitted' },
      mood: { type: 'string', description: MOOD_DESC },
      category: { type: 'string', description: CATEGORY_DESC },
      entry_date: {
        type: 'string',
        description: 'optional ISO date the entry is about (defaults to now)',
      },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['body'],
  },
  handler: async (input, ctx) => {
    const body = str(input.body).trim();
    if (!body) return { ok: false, error: 'body is required' };
    try {
      const row = await createLifelog(ctx.ownerId, {
        body,
        title: strOpt(input.title),
        mood: strOpt(input.mood),
        category: strOpt(input.category),
        entryDate: strOpt(input.entry_date),
        tags: Array.isArray(input.tags)
          ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
          : [],
      });
      ctx.step?.setOutput({ id: row.id, title: row.title });
      return { ok: true, output: compact(row) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const lifelog_update: BuiltinToolDef = {
  slug: 'lifelog_update',
  name: 'Update a life log',
  description:
    'Patch a life log entry — only the fields you pass change (omit to keep stored value). Pass an empty string for `mood`/`category`/`entry_date` to clear it. Use when the user corrects or refines something about themselves.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      body: { type: 'string' },
      title: { type: 'string' },
      mood: { type: 'string', description: MOOD_DESC },
      category: { type: 'string', description: CATEGORY_DESC },
      entry_date: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const row = await updateLifelog(ctx.ownerId, id, {
        body: typeof input.body === 'string' ? input.body : undefined,
        title: typeof input.title === 'string' ? input.title : undefined,
        mood: typeof input.mood === 'string' ? input.mood : undefined,
        category: typeof input.category === 'string' ? input.category : undefined,
        entryDate: typeof input.entry_date === 'string' ? input.entry_date : undefined,
        tags: Array.isArray(input.tags)
          ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
          : undefined,
      });
      if (!row) return { ok: false, error: 'life log not found' };
      ctx.step?.setOutput({ id: row.id, title: row.title });
      return { ok: true, output: compact(row) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const lifelog_delete: BuiltinToolDef = {
  slug: 'lifelog_delete',
  name: 'Delete a life log',
  description:
    'Remove a life log entry by id. Use only when the user explicitly asks to delete it. Returns ok=true on success; ok=false if not found.',
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid' } },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const ok = await deleteLifelog(ctx.ownerId, id);
    if (!ok) return { ok: false, error: 'life log not found' };
    ctx.step?.setOutput({ id });
    return { ok: true, output: { id } };
  },
};

export const LIFELOG_TOOLS: BuiltinToolDef[] = [
  lifelog_list,
  lifelog_get,
  lifelog_create,
  lifelog_update,
  lifelog_delete,
];

export const LIFELOG_TOOL_SLUGS: readonly string[] = LIFELOG_TOOLS.map((t) => t.slug);

/** Subset auto-granted to conversational agents (responder/assistant) at boot.
 *  Read + add/update — NOT delete (destructive ops are explicit grants). */
export const LIFELOG_AUTO_GRANT_SLUGS: readonly string[] = [
  'lifelog_list',
  'lifelog_get',
  'lifelog_create',
  'lifelog_update',
];
