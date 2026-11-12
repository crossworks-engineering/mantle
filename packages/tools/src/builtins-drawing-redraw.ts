/**
 * drawing_redraw: rebuild one uploaded DWG, DXF or DGN as a Present canvas
 * from its own file database (the P&ID symbol plan, phase 2): lines from
 * Segments, each symbol from Symbols placed by Placements, texts from Texts,
 * with switches for each and a Layers panel. No model call, no parser call.
 *
 * Rights, two checks and no new one: the caller may read the file (the read
 * file_sql makes, readableFileDb), and the canvas is saved as present_create
 * or present_update saves it for the caller (saveBuiltCanvas). An agent may
 * redraw, as a person may by hand.
 *
 * A canvas past the Present size cap is refused with a window that fits:
 * never cut. The drawing's names and texts are the uploader's, so the result
 * is fenced as data.
 */
import { fileDataExt, isCadExt } from '@mantle/files';
import { CANVAS_MAX_BYTES } from '@mantle/content-core/canvas';
import { readableFileDb } from './builtins-file-sql';
import { saveBuiltCanvas } from './builtins-presents';
import { FILE_ID_PRE } from './builtins-common';
import { CS } from './client-sourced-rule';
import { boolOpt as bool, str, strOptTrim } from './coerce';
import { buildRedraw, windowThatFits, type RedrawWindow } from './drawing-redraw/build';
import { readRedrawRows } from './drawing-redraw/read';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

/** The line an owner runs on a box so a drawing gets its Symbols tab. */
export const SYMBOLS_PASS_LINE =
  'scripts/box-maintain.sh --files-writable <box> dwg-reindex --symbols --apply';

const fail = (error: string): ToolHandlerResult => ({ ok: false, error });

function windowOf(raw: unknown): { window?: RedrawWindow } | { error: string } {
  if (raw === undefined || raw === null) return {};
  const n = Array.isArray(raw) ? raw.map(Number) : [];
  if (n.length !== 4 || !n.every(Number.isFinite)) {
    return { error: 'window must be four numbers, x0, y0, x1, y1, e.g. [1200, 400, 2400, 1100]' };
  }
  const [x0, y0, x1, y1] = n as [number, number, number, number];
  if (x1 <= x0 || y1 <= y0) {
    return {
      error: `window must have x1 above x0 and y1 above y0 (got [${n.join(', ')}]); leave it out to redraw the whole drawing`,
    };
  }
  return { window: [x0, y0, x1, y1] };
}

export const drawing_redraw: BuiltinToolDef = {
  slug: 'drawing_redraw',
  policy: {
    // The read of the file; the canvas lands by present_create's home rule.
    matrix: { action: 'read', param: 'file_id', kinds: ['file'] },
    effect: 'write',
    spends: 'none',
    scope: 'any',
    keyArea: 'files',
    creates: 'present',
    // With canvas_id it saves a new version of that canvas (present_update).
    itemArgs: [{ param: 'canvas_id' }],
    clientSourced: CS.creates('canvas_id'),
    // Layer names and texts are the uploader's: fenced as data.
    outside: { untrusted: true },
  },
  preconditions: FILE_ID_PRE,
  name: 'Redraw a drawing as a canvas',
  description:
    'Rebuild one uploaded DWG, DXF or DGN as a Present canvas from its own file database: its lines, its symbols placed as in the file, and its texts, with switches for each and a Layers panel; the frame layers start off. Returns the canvas id and url, the counts and the layer list; no picture unless `look`. Live at once, like `present_create`. Pass `canvas_id` to redraw into a canvas you saved before. No model call. For a picture of the original use `dwg_render`; for one piping circuit use `circuit_trace`.',
  inputSchema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        format: 'uuid',
        description: "The drawing's file id, from `file_list` or `search`.",
      },
      window: {
        type: 'array',
        items: { type: 'number' },
        minItems: 4,
        maxItems: 4,
        description:
          'Only this part, in drawing units: x0, y0, x1, y1, e.g. [1200, 400, 2400, 1100]. A refused large drawing names one that fits.',
      },
      frame: {
        type: 'string',
        enum: ['off', 'on'],
        default: 'off',
        description: "The layers taken for the sheet's frame: start off, or on.",
      },
      hide_layers: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 1000,
        description: "Layers that start off, by name, e.g. ['TITLEBLOCK'].",
      },
      canvas_id: {
        type: 'string',
        format: 'uuid',
        description: 'A canvas to redraw into (a new version of it), from an earlier answer.',
      },
      title: { type: 'string', description: "The canvas's name, e.g. 'P-101 redraw'." },
      look: {
        type: 'boolean',
        default: false,
        description: 'Draw the saved canvas and return it as a picture.',
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id).trim();
    if (!fileId) return fail('file_id required: find it with file_list or search_nodes.');
    const asked = windowOf(input.window);
    if ('error' in asked) return fail(asked.error);
    const frame = input.frame === 'on' ? 'on' : 'off';
    const hideLayers = Array.isArray(input.hide_layers)
      ? input.hide_layers.filter((v): v is string => typeof v === 'string')
      : [];
    const canvasId = strOptTrim(input.canvas_id);

    const got = await readableFileDb(ctx.ownerId, fileId, false);
    if (!got.ok) return fail(got.message);
    const { row, abs } = got;
    if (!isCadExt(fileDataExt(row))) {
      return fail(
        `file_id must be a .dwg, .dxf or .dgn drawing; ${row.title} is not one. Find the drawing with file_list or search_nodes.`,
      );
    }
    let read: ReturnType<typeof readRedrawRows>;
    try {
      read = readRedrawRows(abs);
    } catch {
      return fail('The drawing database could not be read just now: call again in a moment.');
    }
    if (!read.hasSymbols) {
      return fail(
        `This drawing's database has no Symbols tab: it was read before the symbols pass, or it places no block. An owner runs this once on the box: \`${SYMBOLS_PASS_LINE}\`. To look at the drawing meanwhile use dwg_render.`,
      );
    }

    const title = strOptTrim(input.title) ?? `${row.title} (redraw)`;
    const opts = { window: asked.window, frame, hideLayers, title, source: row.title } as const;
    const built = buildRedraw(read.rows, opts);
    if (built.bytes > CANVAS_MAX_BYTES) {
      const fits = windowThatFits(read.rows, opts, built, CANVAS_MAX_BYTES);
      return fail(
        `This redraw would be ${Math.ceil(built.bytes / 1000)} KB, over the canvas limit of ${CANVAS_MAX_BYTES / 1000} KB, so nothing was saved. ` +
          (fits
            ? `Redraw a part: window [${fits.join(', ')}] fits (the middle of the drawing; move it to see other parts).`
            : 'Even a small window is too dense here: hide layers with hide_layers, or look at it with dwg_render.'),
      );
    }

    const c = built.counts;
    const saved = await saveBuiltCanvas(ctx, {
      ...(canvasId ? { id: canvasId } : {}),
      source: built.html,
      title,
      summary: `Redraw of the drawing ${row.title} from its file database: ${c.placements} symbols placed, ${c.lines} lines, ${c.texts} texts.`,
      tags: ['drawing-redraw'],
      look: bool(input.look) === true,
    });
    if (!saved.ok) return saved;
    const out = saved.output as Record<string, unknown>;
    return {
      ...saved,
      output: {
        canvas_id: out.id,
        url: out.url,
        title: out.title,
        rev: out.rev,
        page_embed: out.page_embed,
        file_id: row.id,
        window: built.window,
        counts: c,
        layers: built.layers.map((l) => ({
          name: l.name,
          off: l.off,
          ...(l.frame ? { frame: true } : {}),
        })),
        ...(built.unknownLayers.length ? { unknown_layers: built.unknownLayers } : {}),
        ...(c.texts > c.texts_with_height
          ? {
              text_note: `${c.texts - c.texts_with_height} texts have no Height in this database, so their size is a guess from the gaps between them. The next symbols pass on the box gives them their own size.`,
            }
          : {}),
        ...(out.open_link ? { open_link: out.open_link } : {}),
        ...(out.asset_problems ? { asset_problems: out.asset_problems } : {}),
        render: out.render,
      },
    };
  },
};

export const DRAWING_REDRAW_TOOLS: BuiltinToolDef[] = [drawing_redraw];
