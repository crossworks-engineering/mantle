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

import { createNote } from '@mantle/content';
import { recordIngest } from '@mantle/tracing';
import type { BuiltinToolDef } from './types';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
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

export const NOTE_TOOLS: BuiltinToolDef[] = [note_create];
