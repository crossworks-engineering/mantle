/**
 * The CAD tier of the parser service (server/parser, its Python child:
 * ezdwg and ezdgn to read, ezdxf to parse and render, the bones and the
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
  /** The text's height in drawing units, its turn in degrees counter-
   *  clockwise, and an MTEXT's box width (0: no wrap). Null from a CAD tier
   *  before them, and width null for a one-line TEXT or ATTRIB. */
  height?: number | null;
  rotation?: number | null;
  width?: number | null;
  /** Where a redraw sets the text from: the point on its first line's
   *  baseline in drawing units, the side it runs to from there ('left',
   *  'center', 'right'), an MTEXT's lines when it has more than one (joined
   *  by a newline) with the gap from one baseline to the next, and whether
   *  it is underlined. Null from a CAD tier before them. */
  anchorX?: number | null;
  anchorY?: number | null;
  align?: string | null;
  lines?: string | null;
  lineGap?: number | null;
  underline?: boolean;
  /** An attribute's block: the handle of its INSERT (Inserts, Placements).
   *  Null for any other text, and from a CAD tier before it. */
  block?: string | null;
  /** A TEXT's or an ATTRIB's length along its baseline, in drawing units:
   *  from the file's own points, else an estimate. Null for an MTEXT, and
   *  from a CAD tier before it. */
  length?: number | null;
};

const TEXT_SIDES: readonly string[] = ['left', 'center', 'right'];

/** A finite number from the reply, else null. */
const finiteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

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

/** One block an INSERT in model space uses, drawn once (cad/dwg_symbols.py).
 *  `key` is the exact shape (a hash of the block's geometry), `shape` the
 *  turn-free one (for grouping only), `name` a label, never an identity. */
export type DwgSymbol = {
  key: string;
  shape: string | null;
  name: string;
  /** 'label': only ATTDEF, TEXT and MTEXT, never drawn. */
  kind: 'symbol' | 'label';
  /** The block drawn once; null for a label, a draw error or a cap. */
  svg: string | null;
  /** The box the SVG's viewBox (0 0 W H) maps to, in block units, base point
   *  at 0,0: the viewBox's top left is (x0, y0 + height). */
  x0: number | null;
  y0: number | null;
  width: number | null;
  height: number | null;
  /** The drawing shows none of it (its layers are off or frozen): the SVG
   *  is drawn with its layers on. */
  hidden: boolean;
  /** Its ATTDEF tags. */
  tags: string[];
  /** INSERTs that use it in this drawing. */
  placements: number;
};

/** One INSERT in model space (an array INSERT: one per copy), by its key. */
export type DwgPlacement = {
  key: string;
  x: number | null;
  y: number | null;
  rotation: number | null;
  xscale: number | null;
  yscale: number | null;
  layer: string;
  handle: string;
  /** Its ATTRIB values by tag. */
  tags: Record<string, string>;
};

/** One drawable model-space entity (a LINE, CIRCLE, ARC, ELLIPSE, SPLINE or
 *  polyline): its exact outline as an SVG
 *  path in drawing units, y up (M, L, Q and C only), and its box. */
export type DwgShape = {
  kind: string;
  layer: string;
  handle: string;
  path: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** What the symbols pass counted. `notDrawn` is by cap: SVG too large,
 *  the file's SVG bytes, or the time budget. */
export type DwgSymbolFacts = {
  inserts: number;
  /** INSERTs of a missing, empty or too deep block: no key, no placement. */
  unkeyed: number;
  symbols: number;
  drawn: number;
  labels: number;
  hidden: number;
  drawErrors: number;
  notDrawn: { tooLarge: number; totalCap: number; time: number };
  svgBytes: number;
};

/** A window in drawing units: x0, y0, x1, y1. */
export type DwgWindow = [number, number, number, number];

/** What a drawing's picture frames (the CAD tier's dwg_frame.py). */
export type DwgFrame = {
  /** The whole model space. */
  full: DwgWindow;
  /** The window the picture shows: `full` when nothing is stray. */
  sheet: DwgWindow;
  /** The groups left out of `sheet`, each with its window, so a caller can
   *  go and look. */
  offSheet: { window: DwgWindow; entities: number }[];
  framed: boolean;
};

/** What the CAD tier says about a DGN it read (cad/dgn_read.py, the `dgn`
 *  key of its index): the counts behind "what a DGN gives". Only the parts
 *  the digest states are read; a key the reply lacks reads as 0 or empty. */
export type DgnFacts = {
  /** "V8" or "V7 2D". */
  format: string | null;
  dimension: number | null;
  elements: number;
  converted: number;
  notConvertedTotal: number;
  notConverted: Array<{ kind: string; type: number | null; name: string | null; count: number }>;
  models: Array<{ name: string; space: string; elements: number | null }>;
  /** The reader's own sentences on what it could not do. */
  note: string | null;
  /** True when the CAD tier read it with the data reader (an ezdgn that
   *  reads shared cell definitions, item data and tags): only then does its
   *  `dgn` record hold `shared_cells`. Never with ezdgn 0.3.2. */
  dataReader: boolean;
  /** The type name of the error the data reader hit on this file, when it
   *  read the file the 0.3.2 way instead (no `shared_cells` then). */
  dataError: string | null;
};

function readDgn(raw: unknown): DgnFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  return {
    format: text(d.format) || null,
    dimension: finite(d.dimension),
    elements: count(d.elements),
    converted: count(d.converted),
    notConvertedTotal: count(d.not_converted_total),
    notConverted: readList(d.not_converted, 50, (m) => ({
      kind: text(m.kind),
      type: finite(m.type),
      name: text(m.name) || null,
      count: count(m.count),
    })).rows,
    models: readList(d.models, 50, (m) => ({
      name: text(m.name),
      space: text(m.space),
      elements: finite(m.elements),
    })).rows,
    note: text(d.note) || null,
    dataReader: !!d.shared_cells && typeof d.shared_cells === 'object',
    dataError: text(d.data_error) || null,
  };
}

/** What the CAD tier says about a DWG it read (cad/dwg_read.py, the `dwg`
 *  key of its index): every entity object the file lists is converted or
 *  counted here by type and reason, and what was lost below the entity is in
 *  `partial`. A key the reply lacks reads as 0 or empty. */
export type DwgFacts = {
  /** Entity objects the file lists. */
  objects: number;
  converted: number;
  notConvertedTotal: number;
  /** At most 50 rows; `notConvertedTotal` stays the whole count. */
  notConverted: Array<{ type: string; reason: string; count: number }>;
  /** What the file has that the document lacks or draws another way (a
   *  table not read, a value not carried), by short reason. */
  partial: Array<{ reason: string; count: number }>;
  /** Objects neither converted nor counted: 0 on a whole read. */
  gap: number;
};

function readDwg(raw: unknown): DwgFacts | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  return {
    objects: count(d.objects),
    converted: count(d.converted),
    notConvertedTotal: count(d.not_converted_total),
    notConverted: readList(d.not_converted, 50, (m) => ({
      type: text(m.type),
      reason: text(m.reason),
      count: count(m.count),
    })).rows,
    partial: readList(d.partial, 50, (m) => ({ reason: text(m.reason), count: count(m.count) }))
      .rows,
    gap: count(d.gap),
  };
}

/** The converter names the CAD tier sends (cad/cad.py `open_cad`). */
const CONVERTERS = ['ezdwg', 'ezdgn', 'none'] as const;

export type DwgRender = {
  /** Which reader made the document the registry and render came from:
   *  'ezdwg' for a DWG and 'ezdgn' for a DGN, each read into the document
   *  in memory; 'none' when the upload already WAS a DXF and ezdxf read it
   *  natively; 'unknown' for a name this side does not know (never taken
   *  for another). */
  converter: 'ezdwg' | 'ezdgn' | 'none' | 'unknown';
  /** A DGN's own facts; absent or null for a DWG or DXF. */
  dgn?: DgnFacts | null;
  /** A DWG's own facts; absent or null for a DGN or DXF. */
  dwg?: DwgFacts | null;
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
  /** What `png` frames; null from an older image or an unreadable layout. */
  frame: DwgFrame | null;
  /** The symbols and placements; null when the reply has no `symbols`
   *  (an image before the symbols pass). */
  symbols: DwgSymbol[] | null;
  placements: DwgPlacement[];
  placementsCapped: boolean;
  symbolFacts: DwgSymbolFacts | null;
  /** Why the symbols pass failed, when the rest did not. */
  symbolsError: string | null;
  /** The drawable geometry the network leaves out; empty from a CAD tier
   *  before it. */
  shapes: DwgShape[];
  shapesCapped: boolean;
};

/** Wire ceiling: one PNG (≤48 MB raw → ~64 MB base64), a few MB of
 *  registry JSON, at most 16 MB of symbol SVGs (the CAD tier's
 *  MAX_SVG_TOTAL) with their JSON escapes, up to 40,000 placements, and at
 *  most 8 MB of shape paths (cad.py MAX_SHAPE_CHARS).
 *  Enforced while streaming, like the DWF route. */
const DWG_WIRE_MAX_BYTES = 128 * 1024 * 1024;
const DWG_PNG_MAX_BYTES = 48 * 1024 * 1024;
const DWG_TEXTS_MAX = 20_000;
const DWG_BLOCKS_MAX = 20_000;
/** Ceilings on the bones lists; the CAD tier's character budgets bind first
 *  on any real drawing (a large P&ID is a few thousand segments). */
const DWG_SEGMENTS_MAX = 60_000;
const DWG_NODES_MAX = 60_000;
const DWG_INSERTS_MAX = 40_000;
const DWG_CIRCUITS_MAX = 5_000;
/** The CAD tier's own caps (dwg_symbols.py) bind first: a symbol has at
 *  least one placement. */
const DWG_PLACEMENTS_MAX = 40_000;
const DWG_SYMBOLS_MAX = DWG_PLACEMENTS_MAX;
const DWG_SVG_MAX_BYTES = 256 * 1024;
/** The CAD tier's own caps (cad.py MAX_SHAPES, MAX_SHAPE_PATH) bind first. */
const DWG_SHAPES_MAX = 100_000;
const DWG_SHAPE_PATH_MAX = 50_000;
/** An SVG path of numbers and the four commands the CAD tier writes. */
const SHAPE_PATH = /^M[-0-9. MLQC]*$/;

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

/** A string list, or [] */
function texts(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string' && !!t) : [];
}

function readSymbols(body: Record<string, unknown>) {
  if (!Array.isArray(body.symbols)) {
    return {
      symbols: null,
      placements: [],
      placementsCapped: false,
      symbolFacts: null,
      symbolsError: null,
    };
  }
  const symbols = readList<DwgSymbol>(body.symbols, DWG_SYMBOLS_MAX, (r) =>
    typeof r.key === 'string' && r.key
      ? {
          key: r.key,
          shape: text(r.shape) || null,
          name: text(r.name),
          kind: r.kind === 'label' ? 'label' : 'symbol',
          svg:
            typeof r.svg === 'string' && r.svg && r.svg.length <= DWG_SVG_MAX_BYTES ? r.svg : null,
          x0: finite(r.x0),
          y0: finite(r.y0),
          width: finite(r.width),
          height: finite(r.height),
          hidden: r.hidden === true,
          tags: texts(r.tags),
          placements: count(r.placements),
        }
      : null,
  );
  const placements = readList<DwgPlacement>(body.placements, DWG_PLACEMENTS_MAX, (r) => {
    if (typeof r.key !== 'string' || !r.key) return null;
    // No prototype: a tag named `constructor` or `__proto__` is just a tag.
    const tags: Record<string, string> = Object.create(null) as Record<string, string>;
    if (r.tags && typeof r.tags === 'object') {
      for (const [tag, value] of Object.entries(r.tags as Record<string, unknown>)) {
        if (tag && typeof value === 'string') tags[tag] = value;
      }
    }
    return {
      key: r.key,
      x: finite(r.x),
      y: finite(r.y),
      rotation: finite(r.rotation),
      xscale: finite(r.xscale),
      yscale: finite(r.yscale),
      layer: text(r.layer),
      handle: text(r.handle),
      tags,
    };
  });
  const f =
    body.symbol_facts && typeof body.symbol_facts === 'object'
      ? (body.symbol_facts as Record<string, unknown>)
      : null;
  const nd = (f?.not_drawn ?? {}) as Record<string, unknown>;
  return {
    symbols: symbols.rows,
    placements: placements.rows,
    placementsCapped: body.placements_capped === true || placements.cut,
    symbolFacts: f
      ? {
          inserts: count(f.inserts),
          unkeyed: count(f.unkeyed),
          symbols: count(f.symbols),
          drawn: count(f.drawn),
          labels: count(f.labels),
          hidden: count(f.hidden),
          drawErrors: count(f.draw_errors),
          notDrawn: {
            tooLarge: count(nd.too_large),
            totalCap: count(nd.total_cap),
            time: count(nd.time),
          },
          svgBytes: count(f.svg_bytes),
        }
      : null,
    symbolsError:
      typeof body.symbols_error === 'string' && body.symbols_error ? body.symbols_error : null,
  };
}

function readShapes(body: Record<string, unknown>) {
  const shapes = readList<DwgShape>(body.shapes, DWG_SHAPES_MAX, (r) => {
    const box = [finite(r.minx), finite(r.miny), finite(r.maxx), finite(r.maxy)];
    if (
      typeof r.path !== 'string' ||
      r.path.length > DWG_SHAPE_PATH_MAX ||
      !SHAPE_PATH.test(r.path) ||
      box.some((v) => v === null)
    ) {
      return null;
    }
    return {
      kind: text(r.kind),
      layer: text(r.layer),
      handle: text(r.handle),
      path: r.path,
      minX: box[0]!,
      minY: box[1]!,
      maxX: box[2]!,
      maxY: box[3]!,
    };
  });
  return { shapes: shapes.rows, shapesCapped: body.shapes_capped === true || shapes.cut };
}

/**
 * Parse AND raster an AutoCAD drawing's model space in the parser's CAD tier
 * (`POST /dwg/render`). The route takes DWG *or* DXF bytes: the worker
 * sniffs: DWG magic is read by ezdwg's reader, a DGN by ezdgn, anything else
 * as native DXF (converter 'none'). One exchange serves the text digest, the
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
        height: finiteOrNull(t.height),
        rotation: finiteOrNull(t.rotation),
        width: finiteOrNull(t.width),
        anchorX: finiteOrNull(t.ax),
        anchorY: finiteOrNull(t.ay),
        align: typeof t.align === 'string' && TEXT_SIDES.includes(t.align) ? t.align : null,
        lines: typeof t.lines === 'string' && t.lines ? t.lines : null,
        lineGap: finiteOrNull(t.gap),
        underline: t.underline === true,
        block: typeof t.block === 'string' && t.block ? t.block : null,
        length: finiteOrNull(t.length),
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
      converter: CONVERTERS.find((c) => c === body.converter) ?? 'unknown',
      dgn: readDgn(body.dgn),
      dwg: readDwg(body.dwg),
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
      frame: readFrame(body.frame),
      ...readSymbols(body),
      ...readShapes(body),
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

function windowOf(v: unknown): DwgWindow | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const n = v.map(finite);
  return n.every((x) => x !== null) ? (n as DwgWindow) : null;
}

function readFrame(v: unknown): DwgFrame | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Record<string, unknown>;
  const full = windowOf(f.full);
  const sheet = windowOf(f.sheet);
  if (!full || !sheet) return null;
  const offSheet: DwgFrame['offSheet'] = [];
  for (const raw of Array.isArray(f.off_sheet) ? f.off_sheet : []) {
    const g = raw as Record<string, unknown>;
    const window = windowOf(g?.window);
    if (window) offSheet.push({ window, entities: count(g.entities) });
  }
  return { full, sheet, offSheet, framed: f.framed === true };
}

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
