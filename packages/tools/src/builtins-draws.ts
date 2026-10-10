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
 *
 * The text loses positions, colours, ticks and layout, so `draw_get` can also
 * hand back the committed snapshot as a PNG (`image: true`). That is an
 * option on the same tool, not a second tool, on purpose: one slug means one
 * grant, so the picture is reachable on exactly the surfaces, groups, API key
 * areas and peers the text is, with nothing to keep in step. Text stays the
 * default because a picture costs image tokens on every later round.
 */

import { createHash } from 'node:crypto';
import {
  listDraws,
  nodeUrl,
  readableDraw,
  readableDrawText,
  readableDrawSvg,
  renderDrawSvgPng,
  cachedDrawPng,
  cacheDrawPng,
  validRegion,
  DRAW_PNG_LONG_EDGE,
  type DrawReader,
  type DrawRegion,
  type DrawPng,
} from '@mantle/content';
import type { BuiltinToolDef, ToolHandlerContext, ToolPrecondition } from './types';
import { str } from './coerce';
import { notFound } from './errors';
import { errorMessage } from '@mantle/std';

const DRAW_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'draw', lookup: 'draw_list / search_nodes' },
];

/** A picture larger than this is drawn again smaller: every provider takes
 *  it, and it costs less on every later round of the turn. */
const MAX_PNG_BYTES = 3_500_000;
const SMALLER_LONG_EDGE = 1400;
/** Past this width-to-height ratio the whole scene's small print gets thin;
 *  the reply suggests `region`. */
const WIDE_RATIO = 3.5;

/** Who this call reads for, from the surface the server stamped (never from
 *  model arguments). */
function drawReaderOf(ctx: ToolHandlerContext): DrawReader {
  const s = ctx.surface;
  if (s?.kind === 'team' && s.loginId) return { kind: 'member', loginId: s.loginId };
  if (s?.kind === 'client') return { kind: 'client' };
  return { kind: 'scope' };
}

function regionOf(raw: unknown): DrawRegion | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  const region = {
    x: Number(r.x ?? 0),
    y: Number(r.y ?? 0),
    width: Number(r.width ?? 1),
    height: Number(r.height ?? 1),
  };
  return validRegion(region) ? region : 'invalid';
}

const draw_list: BuiltinToolDef = {
  slug: 'draw_list',
  readOnly: true,
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
      return { ok: false, error: errorMessage(err) };
    }
  },
};

/** The picture for one reader, from the cache or freshly drawn. The key is
 *  the stored snapshot, the image ids the renderer keeps for this reader,
 *  and the view, so a recommit, a re-render or a change in what the reader
 *  may see is a new picture, never a stale one. */
async function pictureOf(
  svg: string,
  visibleFileIds: ReadonlySet<string> | null,
  region: DrawRegion | null,
): Promise<DrawPng> {
  const hash = createHash('sha256')
    .update(svg)
    .update('\0')
    .update(visibleFileIds ? [...visibleFileIds].sort().join('\n') : '*')
    .digest('hex');
  const view = region ? `${region.x},${region.y},${region.width},${region.height}` : 'all';
  const key = `${hash}:${view}`;
  const hit = cachedDrawPng(key);
  if (hit) return hit;
  const opts = {
    ...(region ? { region } : {}),
    ...(visibleFileIds ? { keepImagesOf: visibleFileIds } : {}),
  };
  let png = await renderDrawSvgPng(svg, opts);
  if (png.png.length > MAX_PNG_BYTES) {
    png = await renderDrawSvgPng(svg, { ...opts, longEdge: SMALLER_LONG_EDGE });
  }
  cacheDrawPng(key, png);
  return png;
}

const draw_get: BuiltinToolDef = {
  slug: 'draw_get',
  readOnly: true,
  preconditions: DRAW_ID_PRE,
  name: 'Get a drawing',
  description:
    'Read one drawing by id: title, tags, summary, and the COMMITTED scene as text (`content`: frame names as headings, shape labels, labelled arrows as `A -> B: label`). The text loses positions, colours, ticks and layout: when those matter, set `image: true` to also get the committed drawing as a PNG (a model that cannot see images gets the text only); `region` zooms into part of a wide scene. A picture costs image tokens, so ask only when the text is not enough. Uncommitted canvas edits are in neither until the owner commits: say so rather than reporting work missing. Tools cannot author or edit drawings. Returns a `url` permalink: cite the drawing as `[title](url)`.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'draw node id (from draw_list / search_nodes)' },
      image: {
        type: 'boolean',
        default: false,
        description:
          'Also return the committed drawing as a PNG picture, white background, whole scene.',
      },
      region: {
        type: 'object',
        description:
          'Zoom: draw only this part of the scene, as fractions of its width and height from the top-left, e.g. {"x":0.5,"y":0,"width":0.5,"height":0.5} for the top-right quarter. Implies `image`.',
        properties: {
          x: { type: 'number', minimum: 0, maximum: 1, description: 'Left edge, e.g. 0.5.' },
          y: { type: 'number', minimum: 0, maximum: 1, description: 'Top edge, e.g. 0.' },
          width: {
            type: 'number',
            exclusiveMinimum: 0,
            maximum: 1,
            description: 'Share of the scene width, e.g. 0.5.',
          },
          height: {
            type: 'number',
            exclusiveMinimum: 0,
            maximum: 1,
            description: 'Share of the scene height, e.g. 0.5.',
          },
        },
        additionalProperties: false,
      },
    },
    required: ['id'],
  },
  handler: async (input, ctx) => {
    const id = str(input.id).trim();
    if (!id) return { ok: false, error: 'id is required' };
    const region = regionOf(input.region);
    if (region === 'invalid') {
      return {
        ok: false,
        error:
          'region must be fractions of the scene inside 0..1, with x + width and y + height at most 1, e.g. {"x":0,"y":0,"width":0.5,"height":0.5} for the top-left quarter. Leave it out for the whole drawing.',
      };
    }
    const wantImage = input.image === true || region !== null;
    try {
      // Metadata only: no scene, and above all no DRAFT. One helper decides
      // what this reader may get, for the text and the picture alike
      // (draw-reader.ts in @mantle/content).
      const draw = await readableDraw(ctx.ownerId, id);
      if (!draw) return notFound('drawing', id, 'draw_list / search_nodes');
      const reader = drawReaderOf(ctx);
      const content = (await readableDrawText(ctx.ownerId, id, reader)) ?? '';
      const output: Record<string, unknown> = {
        id: draw.id,
        title: draw.title,
        tags: draw.tags,
        summary: draw.summary,
        url: nodeUrl(draw.id),
        has_uncommitted_draft: draw.hasDraft,
        content,
      };
      if (!wantImage) return { ok: true, output };

      const snap = draw.hasSvg ? await readableDrawSvg(ctx.ownerId, id, reader) : null;
      if (!snap) {
        output.image = null;
        output.image_note =
          'No picture: this drawing has no committed snapshot yet (one is made when it is committed on the canvas). Use `content`.';
        return { ok: true, output };
      }
      let png: DrawPng;
      try {
        png = await pictureOf(snap.snapshot, snap.visibleFileIds, region);
      } catch (err) {
        output.image = null;
        output.image_note = `The picture could not be drawn (${errorMessage(err)}). Use \`content\`.`;
        return { ok: true, output };
      }
      const notes: string[] = [];
      if (draw.hasDraft) {
        notes.push('The picture is the last commit; uncommitted canvas edits are not in it.');
      }
      const ratio =
        Math.max(png.sceneWidth, png.sceneHeight) / Math.min(png.sceneWidth, png.sceneHeight);
      if (!region && ratio > WIDE_RATIO) {
        notes.push(
          'This scene is long and thin, so small text may be hard to read: ask again with `region` to zoom into a part.',
        );
      }
      output.image = {
        format: 'png',
        width: png.width,
        height: png.height,
        ...(region ? { region } : {}),
      };
      if (notes.length) output.image_note = notes.join(' ');
      ctx.step?.setMeta({
        image_bytes: png.png.length,
        image_px: `${png.width}x${png.height}`,
        ...(png.width !== DRAW_PNG_LONG_EDGE && png.height !== DRAW_PNG_LONG_EDGE
          ? { image_smaller: true }
          : {}),
      });
      return {
        ok: true,
        output,
        // No caption: the title is author-written, and the picture rides in a
        // user-role message; the title stays in the JSON output only.
        modelImages: [{ mimeType: 'image/png', base64: png.png.toString('base64') }],
      };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  },
};

export const DRAW_TOOLS: BuiltinToolDef[] = [draw_list, draw_get];
export const DRAW_TOOL_SLUGS = DRAW_TOOLS.map((t) => t.slug);
