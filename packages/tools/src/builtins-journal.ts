/**
 * Journal builtins — the user's personal journal: short first-person entries
 * about who they are, what they do, and how they feel, each with an optional
 * mood + life-area category.
 *
 * Why agents get these: Journal entries are the source of the always-on "who you are"
 * identity block (see @mantle/content buildIdentityContext). Letting the
 * assistant *add* to them means a user can say "remember that I just started a
 * new job as a teacher" or "log that I'm feeling anxious about the move" and
 * have it become durable self-knowledge that grounds every future turn.
 *
 * All `nodes` of type='journal'; create/update goes through @mantle/content
 * which fires the extractor, so each entry is summarised + embedded + its
 * facts land in the brain (search_nodes finds them too). Entries also feed the
 * identity context. Delete is left OFF the auto-grant (destructive).
 */

import {
  createJournal,
  deleteJournal,
  getJournal,
  listJournals,
  nodeUrl,
  updateJournal,
  MOOD_KEYS,
  CATEGORY_KEYS,
  type JournalRow,
} from '@mantle/content';
import type { BuiltinToolDef, ToolPrecondition } from './types';
import { str } from './coerce';
import { notFound } from './errors';

// Shared referential precondition (checked centrally in dispatch — see
// preconditions.ts): the id must name an EXISTING journal entry the owner holds.
const JOURNAL_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'journal', lookup: 'journal_list / search_nodes' },
];

function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}
function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** Compact projection — light context, everything an agent needs to reason. */
function compact(n: JournalRow) {
  return {
    id: n.id,
    // Clickable permalink — /n/<id> opens the entry on /journal. Absolute.
    url: nodeUrl(n.id),
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

const journal_list: BuiltinToolDef = {
  slug: 'journal_list',
  name: 'List journal entries',
  description:
    "Browse the user's Journal — their own notes about who they are, their work, family, faith, health, goals, and feelings, newest first. Use to recall what the user has told you about themselves. Optional `mood` / `category` / `query` narrow the list. For a topic search across everything, `search_nodes` is broader.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'substring match on title/body' },
      mood: { type: 'string', description: `filter by mood (${MOOD_KEYS.join(', ')})` },
      category: { type: 'string', description: `filter by area (${CATEGORY_KEYS.join(', ')})` },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 30,
        description: 'Max entries to return.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Rows to skip for paging.',
      },
    },
  },
  handler: async (input, ctx) => {
    const limit = Math.min(num(input.limit, 30), 100);
    const offset = Math.max(0, num(input.offset, 0));
    const rows = await listJournals(ctx.ownerId, {
      query: strOpt(input.query),
      mood: strOpt(input.mood),
      category: strOpt(input.category),
      limit,
      offset,
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: { count: rows.length, journals: rows.map(compact) } };
  },
};

const journal_get: BuiltinToolDef = {
  slug: 'journal_get',
  name: 'Read a journal entry',
  description: 'Fetch one journal entry by its node id. Returns the full entry.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: "The entry's id (UUID) — from `journal_list` / `search_nodes`.",
      },
    },
    required: ['id'],
  },
  preconditions: JOURNAL_ID_PRE,
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const row = await getJournal(ctx.ownerId, id);
    if (!row) return notFound('journal entry', id, 'journal_list');
    return { ok: true, output: compact(row) };
  },
};

// ─── write ─────────────────────────────────────────────────────────────────

const journal_create: BuiltinToolDef = {
  slug: 'journal_create',
  name: 'Add a journal entry',
  description:
    'Record a short, first-person entry in the user\'s Journal — something durable about who they are, what they\'re doing, or how they feel (e.g. "I started a new role as a maths teacher", "feeling anxious about the move next month", "I value honesty above almost everything"). Keep `body` to a short paragraph. This becomes part of the assistant\'s always-on understanding of the user, so write it in the user\'s voice. ' +
    'Use when the user shares something about themselves and asks you to remember it, or clearly wants it on the record — not for transient task/calendar items (use task_create / event_create) or secrets (secret_create).',
  inputSchema: {
    type: 'object',
    properties: {
      body: { type: 'string', description: 'the entry — a short first-person paragraph' },
      title: {
        type: 'string',
        description: 'optional short title; auto-derived from body if omitted',
      },
      mood: { type: 'string', description: MOOD_DESC },
      category: { type: 'string', description: CATEGORY_DESC },
      entry_date: {
        type: 'string',
        description: 'optional ISO date the entry is about (defaults to now)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['health'].",
      },
    },
    required: ['body'],
  },
  handler: async (input, ctx) => {
    const body = str(input.body).trim();
    if (!body) return { ok: false, error: 'body is required' };
    try {
      const row = await createJournal(ctx.ownerId, {
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

const journal_update: BuiltinToolDef = {
  slug: 'journal_update',
  name: 'Update a journal entry',
  description:
    'Patch a journal entry — only the fields you pass change (omit to keep stored value). Pass an empty string for `mood`/`category`/`entry_date` to clear it. Use when the user corrects or refines something about themselves.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: "The entry's id (UUID) — from `journal_list` / `search_nodes`.",
      },
      body: { type: 'string', description: 'New entry text; omit to keep current.' },
      title: { type: 'string', description: 'New title; omit to keep current.' },
      mood: {
        type: 'string',
        description: `${MOOD_DESC} Empty string clears it, omit to keep current.`,
      },
      category: {
        type: 'string',
        description: `${CATEGORY_DESC} Empty string clears it, omit to keep current.`,
      },
      entry_date: {
        type: 'string',
        description: 'ISO date the entry is about; empty string clears it, omit to keep current.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Replaces the whole tag list, e.g. ['health']; omit to keep current.",
      },
    },
    required: ['id'],
  },
  preconditions: JOURNAL_ID_PRE,
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const row = await updateJournal(ctx.ownerId, id, {
        body: typeof input.body === 'string' ? input.body : undefined,
        title: typeof input.title === 'string' ? input.title : undefined,
        mood: typeof input.mood === 'string' ? input.mood : undefined,
        category: typeof input.category === 'string' ? input.category : undefined,
        entryDate: typeof input.entry_date === 'string' ? input.entry_date : undefined,
        tags: Array.isArray(input.tags)
          ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
          : undefined,
      });
      if (!row) return notFound('journal entry', id, 'journal_list');
      ctx.step?.setOutput({ id: row.id, title: row.title });
      return { ok: true, output: compact(row) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const journal_delete: BuiltinToolDef = {
  slug: 'journal_delete',
  name: 'Delete a journal entry',
  description:
    'Remove a journal entry by id. Use only when the user explicitly asks to delete it. Returns ok=true on success; ok=false if not found.',
  requiresConfirm: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: "The entry's id (UUID) — from `journal_list` / `search_nodes`.",
      },
    },
    required: ['id'],
  },
  preconditions: JOURNAL_ID_PRE,
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const ok = await deleteJournal(ctx.ownerId, id);
    if (!ok) return notFound('journal entry', id, 'journal_list');
    ctx.step?.setOutput({ id });
    return { ok: true, output: { id } };
  },
};

export const JOURNAL_TOOLS: BuiltinToolDef[] = [
  journal_list,
  journal_get,
  journal_create,
  journal_update,
  journal_delete,
];

export const JOURNAL_TOOL_SLUGS: readonly string[] = JOURNAL_TOOLS.map((t) => t.slug);

/** Subset auto-granted to conversational agents (responder/assistant) at boot.
 *  Read + add/update — NOT delete (destructive ops are explicit grants). */
export const JOURNAL_AUTO_GRANT_SLUGS: readonly string[] = [
  'journal_list',
  'journal_get',
  'journal_create',
  'journal_update',
];
