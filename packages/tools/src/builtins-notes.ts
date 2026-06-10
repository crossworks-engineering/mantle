/**
 * Note builtins — let an agent persist a markdown note into the user's Mantle.
 * A `note` node insert auto-fires the `node_ingested` trigger (migration 0018),
 * so the extractor indexes it (summary + embedding + facts + entities) with no
 * extra wiring — the note becomes searchable and recallable like any content.
 *
 * The motivating flow: Saskia delegates a question to the `researcher`, gets a
 * synthesis back, and — when the user wants it kept — saves it here. For
 * credentials use secret_create; for file-shaped content use file_create.
 */

import { createNote, getNote, listNotes } from '@mantle/content';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

const note_create: BuiltinToolDef = {
  slug: 'note_create',
  name: 'Create a note',
  description:
    "Save a markdown note into the user's Mantle (a `note` node under /notes). Title required; `content` is markdown. The note is automatically indexed into the brain — summary, embedding, facts, and entities — so it becomes searchable and is recalled in future turns. Use this to capture research findings, decisions, drafts, or anything the user asks you to remember as plain text. Include source URLs in the body when saving research. For passwords/keys use secret_create instead; for file-shaped content use file_create.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'short title, e.g. "Research: best e-bike under R30k"' },
      content: { type: 'string', description: 'markdown body (include sources/links where relevant)' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title'],
  },
  handler: async (input, ctx) => {
    const title = str(input.title).trim();
    if (!title) return { ok: false, error: 'title is required' };
    const content = str(input.content);
    const tags = Array.isArray(input.tags)
      ? (input.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];

    try {
      const row = await createNote(ctx.ownerId, { title: title.slice(0, 200), content, tags });
      ctx.step?.setOutput({ id: row.id, title: row.title });

      // Mirror file_create: record the data-entry moment so the node's
      // biography shows "an agent created this" rather than "appeared from
      // nowhere". The extractor_run trace follows from the INSERT trigger.
      void recordIngest({
        source: 'agent_tool',
        ownerId: ctx.ownerId,
        nodeId: row.id,
        summary: `Note created by tool: ${row.title}`,
        payload: {
          via: 'note_create_tool',
          tags,
          ...(ctx.agent ? { invokingAgent: ctx.agent.slug } : {}),
        },
        snippet: content,
      });

      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ─── Read side: list + get ───────────────────────────────────────────────────

const note_list: BuiltinToolDef = {
  slug: 'note_list',
  name: 'List notes',
  description:
    "List the owner's notes, newest first. `query` substring-matches title/body/summary; `tag` " +
    "narrows to notes carrying that tag. Agent conversation digests are excluded unless `tag` is " +
    "one of their tags (`conversation-digest`, `agent:*`, `topic:*`). " +
    "**Use this for 'recent notes', 'notes mentioning X by literal substring', or to browse by tag.** " +
    "For semantic/embedding search across the whole brain (notes alongside emails, files, pages, etc.) " +
    "use `search_nodes` — that's similarity-ranked and cross-type. For a single note's full markdown body " +
    "use `note_get`.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'substring to match in title/body/summary' },
      tag: { type: 'string', description: 'filter to notes carrying this tag' },
    },
  },
  handler: async (input, ctx) => {
    const query = strOpt(input.query);
    const tag = strOpt(input.tag);
    try {
      const rows = await listNotes(ctx.ownerId, { query, tag });
      ctx.step?.setOutput({ count: rows.length });
      return { ok: true, output: rows };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const note_get: BuiltinToolDef = {
  slug: 'note_get',
  name: 'Get one note by id',
  description:
    "Fetch a single note by id — full row including the markdown content. Use after `note_list` or " +
    "`search_nodes` returns the id you want to read in full. For listing/browsing notes use `note_list`; " +
    "for semantic search across all content (not just notes) use `search_nodes`.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'uuid of the note node' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      const row = await getNote(ctx.ownerId, id);
      if (!row) return { ok: false, error: `note '${id}' not found` };
      ctx.step?.setOutput({ id: row.id, title: row.title });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const NOTE_TOOLS: BuiltinToolDef[] = [note_create, note_list, note_get];
