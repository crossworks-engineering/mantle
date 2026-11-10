/**
 * dwg_render: a picture of one uploaded DWG, DXF or DGN, on request. The picture
 * the extractor stores is one fixed frame; a caller that needed another (the
 * fine print, a note off the sheet) had no way to ask for one, and built its
 * own converter in a sandbox (a client brain, 2026-11-01), with
 * no fallback for a file dwg2dxf mangles. This asks the parser's CAD tier for
 * a `view` of the crop job, so the reading stays in the parser (docs/parser.md).
 *
 * Read only: the picture goes back to the caller and nothing is saved. The
 * drawing's text is the uploader's, so the result is fenced as data. A model
 * sees it as an image; a mini app asks for `bytes` and gets it in the output
 * (app-bytes.ts), so an app can show a drawing with no sandbox step.
 */
import {
  fileById,
  isCadExt,
  parserDwgCrop,
  readFileById,
  type DwgFrame,
  type DwgWindow,
} from '@mantle/files';
import { APP_BYTES_MAX, appBytesRefusal, appBytesTooLarge } from './app-bytes';
import { FILE_ID_PRE } from './builtins-common';
import { boolOpt as bool, str } from './coerce';
import type { BuiltinToolDef } from './types';

/** A view's long edge, in pixels: dwg_crop.py's MIN_EDGE and MAX_VIEW_EDGE. */
const EDGE = { min: 480, max: 4000, default: 2000 } as const;

/** The largest drawing this draws, as a real sheet is far under it. A larger
 *  file is read whole into memory only to wait for the parser. */
const DWG_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** Drawings this process draws at once. The parser takes one job at a time,
 *  for the whole brain, and extraction waits in the same line: a burst from
 *  an app is turned away here, before a byte is read, rather than queued with
 *  every file in memory. */
const DWG_RENDER_IN_FLIGHT = 2;

let drawing = 0;

/** The caller's window, or the words that fix it. */
function windowOf(raw: unknown): { window?: DwgWindow } | { error: string } {
  if (raw === undefined) return {};
  const n: number[] =
    Array.isArray(raw) && raw.length === 4 && raw.every((v) => Number.isFinite(v)) ? raw : [];
  if (n.length !== 4 || !Number.isFinite(n[2]! - n[0]!) || !Number.isFinite(n[3]! - n[1]!)) {
    return { error: 'window must be four numbers, x0, y0, x1, y1, e.g. [1200, 400, 2400, 1100]' };
  }
  const [x0, y0, x1, y1] = n as DwgWindow;
  if (x1 <= x0 || y1 <= y0) {
    return {
      error: `window must have x1 above x0 and y1 above y0 (got [${n.join(', ')}]); leave it out to draw the sheet`,
    };
  }
  return { window: [x0, y0, x1, y1] };
}

const frameOutput = (f: DwgFrame | undefined) =>
  f
    ? {
        sheet: f.sheet,
        full_extents: f.full,
        off_sheet: f.offSheet.map((g) => ({ window: g.window, entities: g.entities })),
      }
    : {};

export const dwg_render: BuiltinToolDef = {
  slug: 'dwg_render',
  policy: {
    matrix: { action: 'read', param: 'file_id', kinds: ['file'] },
    effect: 'read',
    spends: 'none',
    scope: 'any',
    keyArea: 'files',
    // Drawing text is the uploader's: fenced as data (the header says why).
    outside: { untrusted: true },
  },
  name: 'Draw a DWG, DXF or DGN',
  description:
    'Draw one uploaded DWG, DXF or DGN file and return the picture with the window it shows. Saves nothing. With no `window` it draws the sheet: anything far off the sheet is left out, and the reply lists each such group with its window. Name a `window` in drawing units to read fine print or an off-sheet note, or set `full` for all of model space. For the text and its coordinates use `file_sql` on the drawing; for a piping circuit use `circuit_trace`.',
  preconditions: FILE_ID_PRE,
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
          'The part to draw, in drawing units: x0, y0, x1, y1, e.g. [1200, 400, 2400, 1100]. An earlier reply of this tool gives windows; `file_sql` on the Texts tab gives coordinates.',
      },
      full: {
        type: 'boolean',
        default: false,
        description: 'Draw all of model space. Not with `window`.',
      },
      edge: {
        type: 'integer',
        minimum: EDGE.min,
        maximum: EDGE.max,
        default: EDGE.default,
        description: "The picture's long edge in pixels.",
      },
      bytes: {
        type: 'boolean',
        description: 'Mini apps only: return the picture as base64 in the output.',
      },
    },
    required: ['file_id'],
  },
  handler: async (input, ctx) => {
    const fileId = str(input.file_id);
    if (!fileId) return { ok: false, error: 'file_id required: find it with file_list.' };
    const asked = windowOf(input.window);
    if ('error' in asked) return { ok: false, error: asked.error };
    const full = bool(input.full) === true;
    if (full && asked.window) {
      return { ok: false, error: 'full and window draw different things: pass one of them' };
    }
    const wantsBytes = bool(input.bytes) === true;
    const refused = wantsBytes ? appBytesRefusal(ctx) : null;
    if (refused) return { ok: false, error: refused };
    const edge = input.edge === undefined ? EDGE.default : Number(input.edge);
    if (!Number.isInteger(edge) || edge < EDGE.min || edge > EDGE.max) {
      return {
        ok: false,
        error: `edge must be a whole number from ${EDGE.min} to ${EDGE.max} (got ${JSON.stringify(input.edge)})`,
      };
    }

    const row = await fileById({ ownerId: ctx.ownerId, fileId });
    if (!row) {
      return {
        ok: false,
        error: 'file not found: find the right id with file_list or search_nodes, then call again.',
      };
    }
    if (!isCadExt(row.extension.toLowerCase())) {
      return {
        ok: false,
        error: `file_id must be a .dwg, .dxf or .dgn drawing; ${row.filename} is not one. A DWF has its sheets as pictures on the file already. Find the drawing with file_list or search_nodes.`,
      };
    }
    if (row.sizeBytes > DWG_FILE_MAX_BYTES) {
      return {
        ok: false,
        error: `${row.filename} is too large to draw here. Its text and coordinates are in its database: read them with file_sql.`,
      };
    }
    if (drawing >= DWG_RENDER_IN_FLIGHT) {
      return {
        ok: false,
        error: 'Other drawings are being drawn: call again in a moment, one drawing at a time.',
      };
    }
    drawing += 1;
    let drawn: Awaited<ReturnType<typeof parserDwgCrop>>;
    try {
      const file = await readFileById({ ownerId: ctx.ownerId, fileId });
      if (!file) {
        return { ok: false, error: 'the file has no bytes to read: call again in a moment.' };
      }
      drawn = await parserDwgCrop(file.bytes, {
        items: [
          {
            id: 'view',
            kind: 'view',
            edge,
            ...(asked.window ? { window: asked.window } : {}),
            ...(full ? { full } : {}),
          },
        ],
        overview: false,
      });
    } finally {
      drawing -= 1;
    }
    if (!drawn.ok) {
      const busy = drawn.code === 'busy' || drawn.code === 'unavailable';
      return {
        ok: false,
        error: busy
          ? `The parser is busy or restarting (${drawn.code}): call again in a moment.`
          : `The parser could not draw this file (${drawn.code}): ${drawn.message}`,
      };
    }
    const crop = drawn.value.crops[0];
    if (!crop) {
      return {
        ok: false,
        error: `The parser returned no picture: this drawing takes too long to draw, or the picture is too large${drawn.value.capped.length ? ` (${drawn.value.capped.join('; ')})` : ''}. A smaller \`edge\` helps only with the size.`,
      };
    }
    const base = {
      file_id: row.id,
      filename: row.filename,
      window: crop.window,
      width: crop.width,
      height: crop.height,
      smallest_text_px: crop.textPx,
      ...frameOutput(drawn.value.frame),
    };
    ctx.step?.setOutput({ width: crop.width, height: crop.height, blank: crop.blank === true });
    if (crop.blank) {
      return {
        ok: true,
        output: {
          ...base,
          note: drawn.value.frame
            ? 'Nothing is drawn in this window, so there is no picture. `sheet` and `off_sheet` give where the drawing is.'
            : 'Nothing is drawn in this window, so there is no picture. The sheet could not be found: model space may be empty, or its entities could not be read.',
        },
      };
    }
    const base64 = crop.png.toString('base64');
    if (wantsBytes) {
      if (crop.png.length > APP_BYTES_MAX) {
        return { ok: false, error: appBytesTooLarge(row.filename, crop.png.length) };
      }
      return { ok: true, output: { ...base, mime_type: 'image/png', content_base64: base64 } };
    }
    return {
      ok: true,
      output: base,
      modelImages: [{ mimeType: 'image/png', base64 }],
    };
  },
};
