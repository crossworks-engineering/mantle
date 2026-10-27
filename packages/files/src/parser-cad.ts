/**
 * The CAD tier of the parser service (server/parser, its Python child:
 * dwg2dxf and ezdwg to convert, ezdxf to parse and render, the bones and the
 * crops of ./dwg.ts's drawings), as the brain reads it: the typed reply of
 * POST /dwg/render and POST /dwg/crop, each read with a cap on every list.
 * The transport, the errors and the per-bytes failure count are the one
 * parser client's (./parser-client.ts).
 *
 * The parser took this tier over from the media sidecar, whose reply shapes
 * these are (the routes kept their bodies), so the readers are unchanged.
 */
import { asResult, parserJson, type ParserResult } from './parser-client';

// ── DWG parse + render ──────────────────────────────────────────────

export type DwgTextEntity = {
  text: string;
  layer: string;
  x: number | null;
  y: number | null;
};

/** One INSERT that carries attributes, its ATTRIB values keyed by TAG. On
 *  circuitized P&IDs a `LineNumber` block holds `LINENO` and `CIRCUIT` side
 *  by side; this record is the only place that pairing survives. */
export type DwgBlockEntity = {
  block: string;
  layer: string;
  handle: string;
  x: number | null;
  y: number | null;
  attribs: Record<string, string>;
};

/** One straight piece of pipe geometry: a LINE, one vertex pair of a
 *  polyline, or an ARC, by its end points (a curve's are its chord; length
 *  is the true arc length). A segment split by a tee comes as two pieces with
 *  the same handle and part. n1/n2 are node ids, run the connected run. */
export type DwgSegment = {
  layer: string;
  handle: string;
  type: string;
  part: number;
  x1: number | null;
  y1: number | null;
  x2: number | null;
  y2: number | null;
  length: number | null;
  n1: number | null;
  n2: number | null;
  run: number | null;
};

/** A point where segment ends meet (snapped within the reply's tolerance).
 *  kind: end (degree 1), joint (2), tee (3+), block (an end joined to
 *  another through a small insert, such as a valve). */
export type DwgNode = {
  id: number;
  x: number | null;
  y: number | null;
  degree: number;
  kind: string;
  block: string;
  blockHandle: string;
  layers: string;
};

/** Every INSERT, attributes or not, with its block's box in model space. */
export type DwgInsert = {
  block: string;
  layer: string;
  handle: string;
  x: number | null;
  y: number | null;
  rotation: number | null;
  scaleX: number | null;
  scaleY: number | null;
  minX: number | null;
  minY: number | null;
  maxX: number | null;
  maxY: number | null;
  attribs: number;
};

/** One circuit from `Circuit <name>` layers (deadlegs folded in). */
export type DwgCircuit = {
  circuit: string;
  parent: string;
  kind: string;
  layers: string;
  entities: number;
  segments: number;
  length: number | null;
  deadlegSegments: number;
  deadlegLength: number | null;
  runs: number;
  tees: number;
  ends: number;
  endPoints: string;
  lineNumbers: string;
  nearbyText: string;
};

/** How the network was built, for the table description and the digest. */
export type DwgGeometry = {
  snapTolerance: number | null;
  nearDistance: number | null;
  extentDiagonal: number | null;
  /** Sheets tiled in one model space; above 1 each sheet scales its own
   *  tolerances and snapTolerance is the largest sheet's. */
  sheets: number;
  segments: number;
  nodes: number;
  nodeKinds: Record<string, number>;
  inserts: number;
  runs: number;
  circuits: number;
  /** Curves not turned into segments (SPLINE, ELLIPSE, MLINE) and entities
   *  that could not be read, by type. */
  skipped: Record<string, number>;
};

export type DwgRender = {
  /** Which converter produced the DXF the registry and render came from:
   *  'none' when the upload already WAS a DXF and ezdxf read it natively. */
  converter: 'dwg2dxf' | 'ezdwg' | 'none';
  /** DXF version of the converted document ("AC1027"). */
  version: string | null;
  /** Model-space entity total. */
  entities: number;
  /** A registry cap bit (texts or layers hit their ceiling). */
  capped: boolean;
  /** The blocks list hit its ceiling; separate so it never reads as Texts
   *  being truncated. */
  blocksCapped: boolean;
  layers: Array<{ name: string; count: number }>;
  texts: DwgTextEntity[];
  /** Attribute-bearing INSERTs; empty from a CAD tier older than the
   *  blocks field (the reply simply lacks it). */
  blocks: DwgBlockEntity[];
  counts: Record<string, number>;
  /** The bones (since the dwg-bones tier): empty, and `geometry` null,
   *  from an older image. Each list has its own cap bit. */
  segments: DwgSegment[];
  nodes: DwgNode[];
  inserts: DwgInsert[];
  circuits: DwgCircuit[];
  geometry: DwgGeometry | null;
  segmentsCapped: boolean;
  nodesCapped: boolean;
  insertsCapped: boolean;
  circuitsCapped: boolean;
  /** Why the geometry is missing when the registry is not. */
  geometryError: string | null;
  /** Model-space raster; null when the render step failed (registry-only). */
  png: Buffer | null;
  /** Why the render step failed, when it did: the reply is still ok:true
   *  (the registry shipped), but the missing image is explainable. */
  renderError: string | null;
  /** Set when the PIXELS came from a different converter than the registry:
   *  dwg2dxf's DXF can parse yet miss block definitions the renderer needs,
   *  and the worker then retries the render once from ezdwg's DXF. */
  renderConverter: 'ezdwg' | null;
};

/** Wire ceiling: one PNG (≤48 MB raw → ~64 MB base64) plus a few MB of
 *  registry JSON. Enforced while streaming, like the DWF route. */
const DWG_WIRE_MAX_BYTES = 80 * 1024 * 1024;
const DWG_PNG_MAX_BYTES = 48 * 1024 * 1024;
const DWG_TEXTS_MAX = 20_000;
const DWG_BLOCKS_MAX = 20_000;
/** Ceilings on the bones lists; the CAD tier's character budgets bind first
 *  on any real drawing (a large P&ID is a few thousand segments). */
const DWG_SEGMENTS_MAX = 60_000;
const DWG_NODES_MAX = 60_000;
const DWG_INSERTS_MAX = 40_000;
const DWG_CIRCUITS_MAX = 5_000;

/** A finite number or null: the reply never carries NaN, but be sure. */
function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function tally(v: unknown): Record<string, number> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  if (v && typeof v === 'object') {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

/** Read one list of the reply into typed rows, capped at `max`. */
function readList<T>(
  raw: unknown,
  max: number,
  read: (r: Record<string, unknown>) => T | null,
): { rows: T[]; cut: boolean } {
  const list = Array.isArray(raw) ? raw : [];
  const rows: T[] = [];
  for (const item of list) {
    if (rows.length >= max) return { rows, cut: true };
    if (!item || typeof item !== 'object') continue;
    const row = read(item as Record<string, unknown>);
    if (row) rows.push(row);
  }
  return { rows, cut: false };
}

function readBones(body: Record<string, unknown>) {
  const segments = readList<DwgSegment>(body.segments, DWG_SEGMENTS_MAX, (r) => ({
    layer: text(r.layer),
    handle: text(r.handle),
    type: text(r.type),
    part: count(r.part),
    x1: finite(r.x1),
    y1: finite(r.y1),
    x2: finite(r.x2),
    y2: finite(r.y2),
    length: finite(r.length),
    n1: finite(r.n1),
    n2: finite(r.n2),
    run: finite(r.run),
  }));
  const nodes = readList<DwgNode>(body.nodes, DWG_NODES_MAX, (r) =>
    typeof r.id === 'number'
      ? {
          id: r.id,
          x: finite(r.x),
          y: finite(r.y),
          degree: count(r.degree),
          kind: text(r.kind),
          block: text(r.block),
          blockHandle: text(r.block_handle),
          layers: text(r.layers),
        }
      : null,
  );
  const inserts = readList<DwgInsert>(body.inserts, DWG_INSERTS_MAX, (r) => ({
    block: text(r.block),
    layer: text(r.layer),
    handle: text(r.handle),
    x: finite(r.x),
    y: finite(r.y),
    rotation: finite(r.rotation),
    scaleX: finite(r.sx),
    scaleY: finite(r.sy),
    minX: finite(r.minx),
    minY: finite(r.miny),
    maxX: finite(r.maxx),
    maxY: finite(r.maxy),
    attribs: count(r.attribs),
  }));
  const circuits = readList<DwgCircuit>(body.circuits, DWG_CIRCUITS_MAX, (r) =>
    typeof r.circuit === 'string' && r.circuit
      ? {
          circuit: r.circuit,
          parent: text(r.parent),
          kind: text(r.kind),
          layers: text(r.layers),
          entities: count(r.entities),
          segments: count(r.segments),
          length: finite(r.length),
          deadlegSegments: count(r.deadleg_segments),
          deadlegLength: finite(r.deadleg_length),
          runs: count(r.runs),
          tees: count(r.tees),
          ends: count(r.ends),
          endPoints: text(r.end_points),
          lineNumbers: text(r.line_numbers),
          nearbyText: text(r.nearby_text),
        }
      : null,
  );
  const g =
    body.geometry && typeof body.geometry === 'object'
      ? (body.geometry as Record<string, unknown>)
      : null;
  const geometry: DwgGeometry | null = g
    ? {
        snapTolerance: finite(g.snap_tolerance),
        nearDistance: finite(g.near_distance),
        extentDiagonal: finite(g.extent_diagonal),
        sheets: count(g.sheets),
        segments: count(g.segments),
        nodes: count(g.nodes),
        nodeKinds: tally(g.node_kinds),
        inserts: count(g.inserts),
        runs: count(g.runs),
        circuits: count(g.circuits),
        skipped: tally(g.skipped),
      }
    : null;
  return {
    segments: segments.rows,
    nodes: nodes.rows,
    inserts: inserts.rows,
    circuits: circuits.rows,
    geometry,
    segmentsCapped: body.segments_capped === true || segments.cut,
    nodesCapped: body.nodes_capped === true || nodes.cut,
    insertsCapped: body.inserts_capped === true || inserts.cut,
    circuitsCapped: body.circuits_capped === true || circuits.cut,
    geometryError:
      typeof body.geometry_error === 'string' && body.geometry_error ? body.geometry_error : null,
  };
}

/**
 * Parse AND raster an AutoCAD drawing's model space in the parser's CAD tier
 * (`POST /dwg/render`). The route takes DWG *or* DXF bytes: the worker
 * sniffs, DWG magic runs the converter chain, anything else is read as
 * native DXF (converter 'none'). One exchange serves the text digest, the
 * registry workbook and the image pass. Never throws: a {@link ParserResult}
 * with the parser's typed error.
 */
export async function parserDwgRender(
  dwg: Buffer,
  opts?: { dpi?: number },
): Promise<ParserResult<DwgRender>> {
  return asResult(async () => {
    const body = await parserJson(
      'dwgRender',
      dwg,
      opts?.dpi ? { dpi: opts.dpi } : {},
      DWG_WIRE_MAX_BYTES,
    );
    let png: Buffer | null = null;
    if (typeof body.png_base64 === 'string' && body.png_base64) {
      png = Buffer.from(body.png_base64, 'base64');
      // Past the cap the registry still ships; the picture does not.
      if (png.length > DWG_PNG_MAX_BYTES) png = null;
    }
    const texts: DwgTextEntity[] = [];
    for (const rawText of Array.isArray(body.texts) ? body.texts : []) {
      if (texts.length >= DWG_TEXTS_MAX) break;
      const t = rawText as Record<string, unknown>;
      if (typeof t.text !== 'string' || !t.text) continue;
      texts.push({
        text: t.text,
        layer: typeof t.layer === 'string' ? t.layer : '',
        x: typeof t.x === 'number' ? t.x : null,
        y: typeof t.y === 'number' ? t.y : null,
      });
    }
    const blocks: DwgBlockEntity[] = [];
    for (const rawBlock of Array.isArray(body.blocks) ? body.blocks : []) {
      if (blocks.length >= DWG_BLOCKS_MAX) break;
      const b = rawBlock as Record<string, unknown>;
      if (!b.attribs || typeof b.attribs !== 'object') continue;
      // No prototype: a tag named `constructor` or `__proto__` is just a tag.
      const attribs: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [tag, value] of Object.entries(b.attribs as Record<string, unknown>)) {
        if (tag && typeof value === 'string') attribs[tag] = value;
      }
      if (!Object.values(attribs).some(Boolean)) continue;
      blocks.push({
        block: typeof b.block === 'string' ? b.block : '',
        layer: typeof b.layer === 'string' ? b.layer : '',
        handle: typeof b.handle === 'string' ? b.handle : '',
        x: typeof b.x === 'number' ? b.x : null,
        y: typeof b.y === 'number' ? b.y : null,
        attribs,
      });
    }
    const layers: Array<{ name: string; count: number }> = [];
    for (const rawLayer of Array.isArray(body.layers) ? body.layers : []) {
      const l = rawLayer as Record<string, unknown>;
      if (typeof l.name !== 'string') continue;
      layers.push({ name: l.name, count: typeof l.count === 'number' ? l.count : 0 });
    }
    const counts: Record<string, number> = {};
    if (body.counts && typeof body.counts === 'object') {
      for (const [k, v] of Object.entries(body.counts as Record<string, unknown>)) {
        if (typeof v === 'number') counts[k] = v;
      }
    }
    return {
      converter:
        body.converter === 'ezdwg' ? 'ezdwg' : body.converter === 'none' ? 'none' : 'dwg2dxf',
      version: typeof body.version === 'string' ? body.version : null,
      entities: typeof body.entities === 'number' ? body.entities : 0,
      capped: body.capped === true,
      blocksCapped: body.blocks_capped === true,
      layers,
      texts,
      blocks,
      counts,
      ...readBones(body),
      png,
      renderError:
        typeof body.render_error === 'string' && body.render_error ? body.render_error : null,
      renderConverter: body.render_converter === 'ezdwg' ? 'ezdwg' : null,
    };
  });
}

// ── DWG crops (the image check) ─────────────────────────────────────────────

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

export type DwgCrop = {
  id: string;
  /** Which crop of the item (a path is several) and of how many. */
  part: number;
  of: number;
  /** The window in drawing units: [x0, y0, x1, y1]. */
  window: [number, number, number, number];
  width: number;
  height: number;
  /** The smallest text in the window, in pixels (null: no text there). */
  textPx: number | null;
  png: Buffer;
};

export type DwgCrops = {
  converter: string | null;
  crops: DwgCrop[];
  overview: { window: [number, number, number, number]; png: Buffer } | null;
  /** Item ids the CAD tier did not crop (its crop cap or time budget). */
  capped: string[];
};

function windowOf(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const n = v.map(finite);
  return n.every((x) => x !== null) ? (n as [number, number, number, number]) : null;
}

/**
 * Close-up crops of ONE drawing for the image check (`POST /dwg/crop`): the
 * spec rides ahead of the drawing's bytes as the job's options, one call per
 * sheet for all its items. Never throws: a {@link ParserResult}.
 */
export async function parserDwgCrop(
  dwg: Buffer,
  spec: DwgCropSpec,
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
        png: Buffer.from(o.png_base64, 'base64'),
      });
    }
    const ov = body.overview as Record<string, unknown> | null | undefined;
    const ovWindow = ov ? windowOf(ov.window) : null;
    return {
      converter: typeof body.converter === 'string' ? body.converter : null,
      crops,
      overview:
        ov && ovWindow && typeof ov.png_base64 === 'string'
          ? { window: ovWindow, png: Buffer.from(ov.png_base64, 'base64') }
          : null,
      capped: Array.isArray(body.capped) ? body.capped.map(text).filter(Boolean) : [],
    };
  });
}
