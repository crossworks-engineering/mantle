/**
 * Journal builtins — the brain's experience log, two lanes in one node type:
 *
 *   user lane  (identity/context/preference/goal): durable self-knowledge the
 *     user wants every agent to carry — the "# About the user" block.
 *   agent lane (lesson/expectation/gap): what an agent has learned about doing
 *     its job, plus open questions for the user — the "# Working notes" block.
 *
 * Provenance is stamped SERVER-SIDE from the tool-loop context (ctx.agent):
 * an agent call records author='agent' + its slug; the model cannot spoof
 * authorship, and calls with no agent context (MCP upstream) record as the
 * user. Gap entries are born open; `journal_resolve_gap` closes one and files
 * the user's answer as new user-lane knowledge.
 *
 * All `nodes` of type='journal'; create/update goes through @mantle/content
 * which fires the extractor, so each entry is summarised + embedded + its
 * facts land in the brain (search_nodes finds them too). Delete is left OFF
 * the auto-grant (destructive).
 */

import {
  createJournal,
  deleteJournal,
  getJournal,
  listJournals,
  nodeUrl,
  resolveGapEntry,
  updateJournal,
  KIND_KEYS,
  USER_KIND_KEYS,
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
    author: n.author,
    agent_slug: n.agentSlug,
    kind: n.kind,
    status: n.status,
    entry_date: n.entryDate,
    tags: n.tags,
    summary: n.summary,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
  };
}

// ─── read ──────────────────────────────────────────────────────────────────

const journal_list: BuiltinToolDef = {
  slug: 'journal_list',
  readOnly: true,
  name: 'List journal entries',
  description:
    "Browse the Journal — the user's durable self-knowledge (kinds identity/context/preference/goal) and the agents' working notes (lesson/expectation/gap), newest first. Use to recall what the user has said about themselves or what agents have learned. `kind`/`author`/`status`/`query` narrow the list; `kind='gap', status='open'` lists the unanswered questions. For a topic search across everything, `search_nodes` is broader.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'substring match on title/body' },
      kind: {
        type: 'string',
        enum: [...KIND_KEYS],
        description: 'filter by kind',
      },
      author: {
        type: 'string',
        enum: ['user', 'agent'],
        description: 'filter by who wrote the entry',
      },
      status: {
        type: 'string',
        enum: ['open', 'resolved'],
        description: "gap lifecycle filter — pair with kind='gap'",
      },
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
    const author = strOpt(input.author);
    const rows = await listJournals(ctx.ownerId, {
      query: strOpt(input.query),
      kind: strOpt(input.kind),
      author: author === 'user' || author === 'agent' ? author : undefined,
      status: strOpt(input.status),
      limit,
      offset,
    });
    ctx.step?.setOutput({ count: rows.length });
    return { ok: true, output: { count: rows.length, journals: rows.map(compact) } };
  },
};

const journal_get: BuiltinToolDef = {
  slug: 'journal_get',
  readOnly: true,
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
    'Record one short journal entry. User lane (kinds identity/context/preference/goal): durable self-knowledge, written in the user\'s voice, when the user shares something about themselves and wants it remembered ("I lead the ops team", "always answer me in short sentences"). Agent lane, YOUR working log: `lesson` when an approach clearly worked or failed, `expectation` when the user corrects you or sets a standard, `gap` when you could not do your job because knowledge is missing (write it as one answerable question — it will be shown to the user). ' +
    'Not for facts about the world (the extractor learns those from content), transient items (`task_create` / `event_create`), or secrets (`secret_create`).',
  inputSchema: {
    type: 'object',
    properties: {
      body: { type: 'string', description: 'the entry — a short first-person paragraph' },
      title: {
        type: 'string',
        description: 'optional short title; auto-derived from body if omitted',
      },
      kind: {
        type: 'string',
        enum: [...KIND_KEYS],
        description: 'what the entry is — picks the lane it renders in',
      },
      entry_date: {
        type: 'string',
        description: 'optional ISO date the entry is about (defaults to now)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Labels for organisation and filtering, e.g. ['deploys'].",
      },
    },
    required: ['body', 'kind'],
  },
  handler: async (input, ctx) => {
    const body = str(input.body).trim();
    if (!body) return { ok: false, error: 'body is required' };
    try {
      const row = await createJournal(ctx.ownerId, {
        body,
        title: strOpt(input.title),
        kind: strOpt(input.kind),
        entryDate: strOpt(input.entry_date),
        tags: Array.isArray(input.tags)
          ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
          : [],
        // Provenance comes from the runtime, never the model's arguments.
        author: ctx.agent ? 'agent' : 'user',
        agentSlug: ctx.agent?.slug,
      });
      ctx.step?.setOutput({ id: row.id, title: row.title, kind: row.kind });
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
    'Patch a journal entry — only the fields you pass change (omit to keep stored value). Use when the user corrects or refines an entry, or to re-kind one. To answer an open question use `journal_resolve_gap` instead — it also records the answer.',
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
      kind: {
        type: 'string',
        enum: [...KIND_KEYS],
        description: 'New kind; omit to keep current.',
      },
      entry_date: {
        type: 'string',
        description: 'ISO date the entry is about; empty string clears it, omit to keep current.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Replaces the whole tag list, e.g. ['deploys']; omit to keep current.",
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
        kind: typeof input.kind === 'string' ? input.kind : undefined,
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

const journal_resolve_gap: BuiltinToolDef = {
  slug: 'journal_resolve_gap',
  name: 'Resolve an open question',
  description:
    "Close one open `gap` entry with the user's answer. Two effects: the question is marked resolved (and leaves every agent's Open-questions list), and the answer is saved as a new user-lane journal entry so all agents carry it from now on. Use the moment the user answers an open question — asked or volunteered. For editing any other entry use `journal_update`.",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description: "The gap entry's id (UUID) — from `journal_list` (kind='gap', status='open').",
      },
      answer: {
        type: 'string',
        description: "The user's answer, as one short durable statement in the user's voice.",
      },
      answer_kind: {
        type: 'string',
        enum: [...USER_KIND_KEYS],
        default: 'context',
        description: 'Kind for the saved answer.',
      },
    },
    required: ['id', 'answer'],
  },
  preconditions: JOURNAL_ID_PRE,
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    const answer = str(input.answer).trim();
    if (!id) return { ok: false, error: 'id is required' };
    if (!answer) return { ok: false, error: 'answer is required' };
    try {
      const result = await resolveGapEntry(ctx.ownerId, id, {
        answer,
        answerKind: strOpt(input.answer_kind),
        author: ctx.agent ? 'agent' : 'user',
        agentSlug: ctx.agent?.slug,
      });
      if (!result) {
        return {
          ok: false,
          error: `journal entry ${id} is not a gap entry (or not found) — list open questions with journal_list (kind='gap', status='open'), then re-issue`,
        };
      }
      ctx.step?.setOutput({ id, answer_id: result.answer.id });
      return {
        ok: true,
        output: { resolved: compact(result.gap), answer: compact(result.answer) },
      };
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
  journal_resolve_gap,
  journal_delete,
];

export const JOURNAL_TOOL_SLUGS: readonly string[] = JOURNAL_TOOLS.map((t) => t.slug);

/** Subset auto-granted to conversational agents (responder/assistant) at boot.
 *  Read + add/update/resolve — NOT delete (destructive ops are explicit grants). */
export const JOURNAL_AUTO_GRANT_SLUGS: readonly string[] = [
  'journal_list',
  'journal_get',
  'journal_create',
  'journal_update',
  'journal_resolve_gap',
];
