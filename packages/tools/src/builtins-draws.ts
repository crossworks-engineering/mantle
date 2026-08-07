/**
 * Draw builtins — read access to the whiteboard workspace (/draw).
 *
 * READ-ONLY by design (Phase 5 of docs/draw-plan.md): a draw's scene is
 * Excalidraw JSON that only the canvas can author safely, so agents read the
 * committed derived text (`scene_text` — frame names as headings, shape
 * labels, bound arrows as `A -> B: label` relations, plus any folded OCR from
 * pasted images) and never touch the scene itself. Authoring is Phase 6, a
 * separate decision. Mirrors the MCP posture for pages before their agent
 * landed.
 */

import { listDraws, getDrawMeta, getDrawSceneText, nodeUrl } from '@mantle/content';
import type { BuiltinToolDef, ToolPrecondition } from './types';
import { str } from './coerce';
import { notFound } from './errors';

const DRAW_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'draw', lookup: 'draw_list / search_nodes' },
];

const draw_list: BuiltinToolDef = {
  slug: 'draw_list',
  name: 'List drawings',
  description:
    "List the owner's whiteboard drawings (/draw), **newest first**. Optional `query` substring-matches title/body/summary; `tag` filters. Bodies are omitted. " +
    "For topic/semantic search ('the sketch about the ingest pipeline') use `search_nodes` with `type='draw'` instead — similarity-ranked, not date-sorted. For one drawing's readable content use `draw_get`.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'substring match over title/body/summary' },
      tag: { type: 'string', description: 'Only return items carrying this tag.' },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 200,
        default: 50,
        description: 'Max rows to return.',
      },
    },
  },
  handler: async (input, ctx) => {
    const query = str(input.query).trim() || undefined;
    const tag = str(input.tag).trim() || undefined;
    const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(200, input.limit)) : 50;
    try {
      const rows = await listDraws(ctx.ownerId, { query, tag, limit });
      ctx.step?.setOutput({ count: rows.length });
      return {
        ok: true,
        output: rows.map((r) => ({
          id: r.id,
          url: nodeUrl(r.id),
          title: r.title,
          tags: r.tags,
          summary: r.summary,
          updatedAt: r.updatedAt,
        })),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const draw_get: BuiltinToolDef = {
  slug: 'draw_get',
  preconditions: DRAW_ID_PRE,
  name: 'Get a drawing',
  description:
    'Read one drawing by id: title, tags, summary, and the COMMITTED scene rendered as text (`content` — frame names as headings, shape labels, and labelled arrows as `A -> B: label` relations). You read what the drawing says, not its pixels. Uncommitted canvas edits are invisible here until the owner commits — say so rather than reporting work missing. Drawings cannot be authored or edited by tools; the owner draws on the canvas. Returns a `url` permalink — reference the drawing as a markdown `[title](url)`.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'draw node id (from draw_list / search_nodes)' },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    try {
      // getDrawMeta, not getDraw: the latter pulls the whole uncommitted
      // draft scene into memory just so we can report one boolean, which is
      // one careless spread away from handing an agent the draft.
      const draw = await getDrawMeta(ctx.ownerId, id);
      if (!draw) return notFound('drawing', id, 'draw_list / search_nodes');
      const content = (await getDrawSceneText(ctx.ownerId, id)) ?? '';
      return {
        ok: true,
        output: {
          id: draw.id,
          title: draw.title,
          tags: draw.tags,
          summary: draw.summary,
          url: nodeUrl(draw.id),
          has_uncommitted_draft: draw.hasDraft,
          content,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const DRAW_TOOLS: BuiltinToolDef[] = [draw_list, draw_get];
export const DRAW_TOOL_SLUGS = DRAW_TOOLS.map((t) => t.slug);
