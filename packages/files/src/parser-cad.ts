/**
 * The crops of a drawing for the image check (`POST /dwg/crop`), as the
 * brain reads them: the tools `dwg_render` and `circuit_verify` call it.
 * It stays in the core, on its route: only the read of a drawing moved to
 * the package `drawing-cad` (./pipelines/pkg/drawing-cad). The transport,
 * the errors and the per-bytes failure count are the one parser client's
 * (./parser-client.ts). The reply's frame is read as the step reads it.
 */
import { asResult, parserJson, type ParserResult } from './parser-client';
import {
  count,
  finite,
  readFrame,
  text,
  windowOf,
  type DwgFrame,
  type DwgWindow,
} from './pipelines/pkg/drawing-cad/cad-reply';

export type {
  DgnFacts,
  DwgFacts,
  DwgFrame,
  DwgRender,
  DwgSymbolFacts,
  DwgWindow,
} from './pipelines/pkg/drawing-cad/cad-reply';

/** At most 48 crops of at most 2000x2000 px plus an overview, base64. */
const DWG_CROP_WIRE_MAX_BYTES = 160 * 1024 * 1024;

/** One item to crop: a spot (`point`) or a traced path (`path`), in drawing
 *  units; `marks` get a green ring. Mirrors dwg_crop.parse_spec. */
export type DwgCropItem =
  | { id: string; kind: 'point'; at: [number, number]; pad: number; marks?: [number, number][] }
  | {
      id: string;
      kind: 'path';
      points: [number, number][];
      pad: number;
      marks?: [number, number][];
    };

export type DwgCropSpec = {
  items: DwgCropItem[];
  /** The trace drawn over every crop: main red, branch blue, deadleg orange. */
  overlay?: { color: 'main' | 'branch' | 'deadleg'; segs: [number, number, number, number][] }[];
  overview?: boolean;
};

/** A picture to look at: `window`, else the sheet, or all of model space
 *  with `full`, at a long edge of `edge` pixels. Mirrors dwg_crop.parse_spec. */
export type DwgViewItem = {
  id: string;
  kind: 'view';
  window?: DwgWindow;
  full?: boolean;
  edge?: number;
};

export type DwgViewSpec = { items: DwgViewItem[]; overview: false };

export type DwgCrop = {
  id: string;
  /** Which crop of the item (a path is several) and of how many. */
  part: number;
  of: number;
  /** The window in drawing units: [x0, y0, x1, y1]. */
  window: DwgWindow;
  width: number;
  height: number;
  /** The smallest text in the window, in pixels (null: no text there). */
  textPx: number | null;
  /** A view with nothing drawn in its window. */
  blank?: true;
  png: Buffer;
};

export type DwgCrops = {
  converter: string | null;
  crops: DwgCrop[];
  overview: { window: DwgWindow; png: Buffer } | null;
  /** Item ids the CAD tier did not crop (its crop cap or time budget). */
  capped: string[];
  /** The drawing's frame, when a `view` asked for one. */
  frame?: DwgFrame;
};

/**
 * Close-up crops of ONE drawing for the image check (`POST /dwg/crop`): the
 * spec rides ahead of the drawing's bytes as the job's options, one call per
 * sheet for all its items. Never throws: a {@link ParserResult}.
 */
export async function parserDwgCrop(
  dwg: Buffer,
  spec: DwgCropSpec | DwgViewSpec,
): Promise<ParserResult<DwgCrops>> {
  return asResult(async () => {
    const body = await parserJson('dwgCrop', dwg, { spec }, DWG_CROP_WIRE_MAX_BYTES);
    const crops: DwgCrop[] = [];
    for (const c of Array.isArray(body.crops) ? body.crops : []) {
      const o = c as Record<string, unknown>;
      const window = windowOf(o.window);
      if (typeof o.id !== 'string' || !window || typeof o.png_base64 !== 'string') continue;
      crops.push({
        id: o.id,
        part: count(o.part),
        of: Math.max(1, count(o.of)),
        window,
        width: count(o.width),
        height: count(o.height),
        textPx: finite(o.text_px),
        ...(o.blank === true ? { blank: true as const } : {}),
        png: Buffer.from(o.png_base64, 'base64'),
      });
    }
    const ov = body.overview as Record<string, unknown> | null | undefined;
    const ovWindow = ov ? windowOf(ov.window) : null;
    const frame = readFrame(body.frame);
    return {
      converter: typeof body.converter === 'string' ? body.converter : null,
      crops,
      overview:
        ov && ovWindow && typeof ov.png_base64 === 'string'
          ? { window: ovWindow, png: Buffer.from(ov.png_base64, 'base64') }
          : null,
      capped: Array.isArray(body.capped) ? body.capped.map(text).filter(Boolean) : [],
      ...(frame ? { frame } : {}),
    };
  });
}
