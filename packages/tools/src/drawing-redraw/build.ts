/**
 * The redraw of one CAD drawing from its own file database (the P&ID symbol
 * plan, phase 2): rows in, one Present canvas out. Pure: no I/O, no model.
 *
 * - Symbols: each row's SVG once, as a `<symbol>`, rebuilt from a short list
 *   of shape elements and attributes (sanitizeSymbolSvg), so nothing of the
 *   parser's SVG but its geometry reaches the canvas.
 * - Placements: a `<use>` of the symbol inside a y-up group, with one
 *   transform: translate(X Y) rotate(R) scale(Xs Ys) translate(X0, Y0+H)
 *   scale(1 -1). The symbol's SVG is y-down from its top edge, Y0+Height.
 * - Segments and Shapes: the line work, one path a layer (one more for what
 *   the drawing fills: a SOLID arrow head, a TRACE; one more for each dash
 *   pattern of its line types).
 * - Texts: outside the flipped group, so they read the right way up, sized
 *   by Height and turned by Rotation, each set from its own justification
 *   point (Anchor X, Anchor Y, Align: the browser's font is not the
 *   drawing's, so a text set from its left end would drift), a one-line
 *   text squeezed or stretched to its own Length, an MTEXT line by line;
 *   a row with no Height (a file read before the sizes) gets the
 *   gap guess (gapSizes), and one with no anchor is set from X, Y.
 * - Layers: a class each, by index, so a layer's name is never markup. The
 *   frame guess (frameLayers) is off by default; a Layers panel switches any.
 * - The sheet (sheetOf): the largest rectangle the drawing draws, a border
 *   block or four lines. Its own border and what lies outside it (a table
 *   under the border, a note parked beside the sheet) start off with the
 *   frame, under one Frame switch.
 *
 * Every text, layer name, title and file name is escaped (esc). Coordinates
 * are written from the shown area's corner, rounded to what the span needs.
 */

export type RedrawWindow = readonly [number, number, number, number];

export type RedrawSymbol = {
  key: string;
  svg: string | null;
  x0: number | null;
  y0: number | null;
  width: number | null;
  height: number | null;
};

export type RedrawPlacement = {
  key: string;
  x: number;
  y: number;
  rotation: number | null;
  xscale: number | null;
  yscale: number | null;
  layer: string;
  handle: string;
};

export type RedrawSegment = {
  layer: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The entity's handle: a segment whose entity has a Shapes row is drawn
   *  from there. */
  handle?: string;
};

/** A drawable entity the network does not hold exactly: its outline as an
 *  SVG path in drawing units, y up (M, L, Q and C only), and its box. */
export type RedrawShape = {
  layer: string;
  handle: string;
  path: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** The drawing fills it (a SOLID, a TRACE: an arrow head, a bar). */
  fill?: boolean;
  /** The dash pattern of its line type: dash and gap lengths in turn, in
   *  drawing units, joined by a space (0: a dot). Null: continuous. */
  dash?: string | null;
};

export type RedrawText = {
  text: string;
  layer: string;
  x: number;
  y: number;
  height: number | null;
  rotation: number | null;
  /** An MTEXT's box width; null for a one-line text. */
  width: number | null;
  /** Where the text is set from: the point on its first line's baseline, in
   *  drawing units, and the side it runs to from there. Null in a database
   *  from before them: the text is then set from X, Y, left (an MTEXT from
   *  its top-left corner). */
  anchorX?: number | null;
  anchorY?: number | null;
  align?: string | null;
  /** An MTEXT of more than one line: its lines, joined by a newline, and
   *  the gap from one baseline to the next, in drawing units. */
  lines?: string | null;
  lineGap?: number | null;
  underline?: boolean;
  /** An attribute's block: the handle of its INSERT. */
  block?: string | null;
  /** A one-line text's length along its baseline, in drawing units. */
  length?: number | null;
};

/** The CAD reader's own box of an insert, by handle: the Check boxes. */
export type RedrawInsert = {
  handle: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type RedrawRows = {
  symbols: RedrawSymbol[];
  placements: RedrawPlacement[];
  segments: RedrawSegment[];
  texts: RedrawText[];
  inserts: RedrawInsert[];
  /** The Shapes tab; null for a database from before it, which draws every
   *  segment (polylines and arcs as chords, no circles). */
  shapes: RedrawShape[] | null;
};

export type RedrawOptions = {
  window?: RedrawWindow;
  /** The frame: 'off' (default) starts the frame layers off, and with them
   *  the sheet's own border and what lies outside the sheet. */
  frame?: 'off' | 'on';
  /** Layers that start off, by name. */
  hideLayers?: readonly string[];
  title: string;
  /** The source file's name, for the footer. */
  source: string;
};

export type RedrawCounts = {
  /** Symbol drawings used. */
  symbols: number;
  /** Placements drawn. */
  placements: number;
  /** Segments drawn: only those whose entity has no Shapes row, so with a
   *  Shapes tab every LINE is counted in `shapes`. */
  lines: number;
  /** Shapes drawn: circles, arcs, ellipses, splines, polylines. */
  shapes: number;
  texts: number;
  /** Placements in the shown area with no symbol drawing (no row, no SVG). */
  placements_without_symbol: number;
  /** Texts drawn at their own Height (the rest: the gap guess). */
  texts_with_height: number;
  /** Texts set from their own anchor (the rest: from X, Y, a database from
   *  before the anchors). */
  texts_with_anchor: number;
  /** Lines, placements and texts that are the sheet's own border or lie
   *  outside the sheet: they start off with the frame. */
  frame_items: number;
};

export type RedrawLayer = { name: string; off: boolean; frame: boolean };

export type RedrawResult = {
  html: string;
  /** UTF-8 bytes of `html`. */
  bytes: number;
  /** The whole area drawn, in drawing units: canvas x is drawing x minus
   *  its x0. With the frame off the view opens on the sheet, inside it. */
  window: [number, number, number, number];
  /** The sheet's rectangle, in drawing units; null when the drawing draws
   *  none (sheetOf). */
  sheet: [number, number, number, number] | null;
  counts: RedrawCounts;
  layers: RedrawLayer[];
  /** `hideLayers` names the drawing does not have. */
  unknownLayers: string[];
};

type Box = { x0: number; y0: number; w: number; h: number };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// eslint-disable-next-line no-control-regex -- control characters are the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Text for HTML and SVG: the five characters that can end a text or an
 *  attribute, as entities, and control characters as spaces. */
export function esc(s: string): string {
  return s
    .replace(CONTROL, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------ symbol SVG */

const SVG_SHAPES = new Set(['path', 'line', 'polyline', 'polygon', 'circle', 'ellipse', 'rect']);
const SVG_ATTRS = new Set([
  'd',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'transform',
]);
/** A geometry value: numbers, path commands and transform names. No quote,
 *  angle bracket, ampersand, colon, hash or slash, so no value can end its
 *  attribute or name a URL. */
const SAFE_VALUE = /^[A-Za-z0-9.,+\-\s()]*$/;
/** A shape with no fill showing: ezdxf's clear ground under a symbol. */
const CLEAR_GROUND = /\sfill-opacity\s*=\s*["']0(?:\.0*)?["']/;
/** A shape's path as the parser writes it: numbers and M, L, Q, C only. */
const SHAPE_PATH = /^M[-0-9. MLQC]*$/;
/** One x y pair of such a path (every command takes pairs). */
const PATH_PAIR = /(-?[\d.]+) (-?[\d.]+)/g;
/** A tag; its attributes hold no `<`, so a `<` with no `>` costs one pass. */
const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:[\s/][^<>]*)?)>/g;
/** A name only after whitespace, so a long run with no `=` costs one pass. */
const ATTR = /(?:^|\s)([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** A style rule of the parser's SVG: ezdxf writes one a class (`.C2 {…}`). */
const STYLE_RULE = /\.([A-Za-z][\w-]*)\s*\{([^{}]*)\}/g;
const CLASS = /(?:^|\s)class\s*=\s*["']([^"'\s]*)["']/;
/** What a filled shape of a symbol carries: the class the canvas styles, and
 *  the same as attributes for a renderer without the style sheet. */
const FILLED = ' class="f" fill="#1f5fd6" stroke="none"';

/**
 * The classes of a symbol's SVG that have no stroke: what the drawing fills
 * (the letters of a text, a SOLID, a solid hatch, a wide polyline) is
 * 'fill'; a fill that shows nothing (a wipeout, drawn in the clear ground's
 * colour) is 'clear'. Every other class is an outline.
 */
function fillClasses(svg: string): Map<string, 'fill' | 'clear'> {
  const out = new Map<string, 'fill' | 'clear'>();
  for (const m of svg.matchAll(STYLE_RULE)) {
    const rule = m[2]!;
    if (!/(?:^|;)\s*stroke\s*:\s*none\b/.test(rule)) continue;
    const shows =
      !/(?:^|;)\s*fill\s*:\s*none\b/.test(rule) &&
      Number(/(?:^|;)\s*fill-opacity\s*:\s*([\d.]+)/.exec(rule)?.[1] ?? 1) > 0;
    out.set(m[1]!, shows ? 'fill' : 'clear');
  }
  return out;
}

/**
 * A symbol's SVG as the shapes the canvas draws: its viewBox, and its inner
 * markup rebuilt from `g` and the shape elements with geometry attributes
 * only. Style, classes, text nodes, scripts, links and every other element
 * or attribute are dropped (the canvas colours every symbol itself). One
 * thing is read from the style: which shapes the drawing fills (fillClasses).
 * Those are filled in the symbol's colour, so a text in a symbol reads as
 * text and not as hollow letters; a clear one is left out. Null when it has
 * no usable viewBox.
 */
export function sanitizeSymbolSvg(svg: string): { viewBox: string; inner: string } | null {
  // The root tag by position, then its viewBox: no pattern scans the rest.
  const start = svg.search(/<svg\b/i);
  const end = start < 0 ? -1 : svg.indexOf('>', start);
  const root = end < 0 ? null : /\bviewBox\s*=\s*["']([^"']*)["']/i.exec(svg.slice(start, end));
  const nums =
    root?.[1]
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  if (nums.length !== 4 || !nums.every(finite) || nums[2]! <= 0 || nums[3]! <= 0) return null;
  const fills = fillClasses(svg);
  let inner = '';
  let depth = 0;
  for (const m of svg.matchAll(TAG)) {
    const closing = m[1] === '/';
    const name = m[2]!.toLowerCase();
    if (name === 'g') {
      if (closing) {
        if (depth > 0) {
          inner += '</g>';
          depth -= 1;
        }
      } else if (!/\/\s*$/.test(m[3]!)) {
        inner += `<g${attrsOf(m[3]!)}>`;
        depth += 1;
      }
      continue;
    }
    // The clear ground ezdxf lays under each symbol is not a part of it.
    if (name === 'rect' && CLEAR_GROUND.test(m[3]!)) continue;
    if (closing || !SVG_SHAPES.has(name)) continue;
    const fill = fills.size ? fills.get(CLASS.exec(m[3]!)?.[1] ?? '') : undefined;
    if (fill !== 'clear') inner += `<${name}${attrsOf(m[3]!)}${fill ? FILLED : ''}/>`;
  }
  inner += '</g>'.repeat(depth);
  return { viewBox: nums.join(' '), inner };
}

function attrsOf(raw: string): string {
  let out = '';
  for (const a of raw.matchAll(ATTR)) {
    const name = a[1]!.toLowerCase();
    const value = a[2] ?? a[3] ?? '';
    if (SVG_ATTRS.has(name) && SAFE_VALUE.test(value)) out += ` ${name}="${value}"`;
  }
  return out;
}

/* ----------------------------------------------------------- the frame */

type Extent = { x0: number; y0: number; x1: number; y1: number };

/** One piece of line work with its box: a Shapes row, or a Segments row
 *  whose entity has none. */
type Stroke = Extent & { layer: string; path: string | null };

/** The line work as the canvas draws it: every Shapes row, and each segment
 *  whose entity has no Shapes row. */
function strokesOf(rows: Pick<RedrawRows, 'segments' | 'shapes'>): Stroke[] {
  const shaped = new Set((rows.shapes ?? []).map((h) => h.handle).filter(Boolean));
  const out: Stroke[] = [];
  for (const h of rows.shapes ?? []) {
    if (!SHAPE_PATH.test(h.path)) continue;
    out.push({ layer: h.layer, x0: h.minX, y0: h.minY, x1: h.maxX, y1: h.maxY, path: h.path });
  }
  for (const s of rows.segments) {
    if (s.handle && shaped.has(s.handle)) continue;
    out.push({
      layer: s.layer,
      x0: Math.min(s.x1, s.x2),
      y0: Math.min(s.y1, s.y2),
      x1: Math.max(s.x1, s.x2),
      y1: Math.max(s.y1, s.y2),
      path: null,
    });
  }
  return out;
}

function extentOf(boxes: readonly Extent[]): Extent | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x0);
    x1 = Math.max(x1, b.x1);
    y0 = Math.min(y0, b.y0);
    y1 = Math.max(y1, b.y1);
  }
  return x0 <= x1 ? { x0, y0, x1, y1 } : null;
}

const meetsBox = (a: Extent, b: Extent): boolean =>
  b.x1 >= a.x0 && b.x0 <= a.x1 && b.y1 >= a.y0 && b.y0 <= a.y1;
const holdsBox = (a: Extent, b: Extent): boolean =>
  b.x0 >= a.x0 && b.y0 >= a.y0 && b.x1 <= a.x1 && b.y1 <= a.y1;
const grown = (e: Extent, by: number): Extent => ({
  x0: e.x0 - by,
  y0: e.y0 - by,
  x1: e.x1 + by,
  y1: e.y1 + by,
});

/** A straight piece that lies along an axis: where it is across that axis
 *  (`at`), and from where to where along it. */
type AxisPiece = { layer: string; flat: boolean; at: number; lo: number; hi: number };
type Run = { at: number; lo: number; hi: number };

/** One command letter, or one x y pair, of a shape's path. */
const PATH_TOKEN = /([MLQC])|(-?[\d.]+) (-?[\d.]+)/g;
/** A piece lies along an axis when it leaves it by at most this share of
 *  its own length. */
const AXIS_SLOPE = 1e-3;

/** The straight pieces of the line work that lie along an axis: a line as
 *  its box says, a polyline piece by piece (curves are no pieces). */
function axisPieces(work: readonly Stroke[]): AxisPiece[] {
  const out: AxisPiece[] = [];
  const add = (layer: string, ax: number, ay: number, bx: number, by: number) => {
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    if (dy <= AXIS_SLOPE * dx && dx > 0) {
      out.push({
        layer,
        flat: true,
        at: (ay + by) / 2,
        lo: Math.min(ax, bx),
        hi: Math.max(ax, bx),
      });
    } else if (dx <= AXIS_SLOPE * dy && dy > 0) {
      out.push({
        layer,
        flat: false,
        at: (ax + bx) / 2,
        lo: Math.min(ay, by),
        hi: Math.max(ay, by),
      });
    }
  };
  for (const w of work) {
    const thin =
      Math.min(w.x1 - w.x0, w.y1 - w.y0) <= AXIS_SLOPE * Math.max(w.x1 - w.x0, w.y1 - w.y0);
    if (thin || w.path === null) {
      // A line (or a polyline along one line) is the line across its box; a
      // segment that is not along an axis has a box that is not thin.
      if (thin) add(w.layer, w.x0, w.y0, w.x1, w.y1);
      continue;
    }
    let cmd = 'M';
    let seen = 0;
    let px = 0;
    let py = 0;
    let pen = false;
    for (const m of w.path.matchAll(PATH_TOKEN)) {
      if (m[1]) {
        cmd = m[1];
        seen = 0;
        continue;
      }
      const x = Number(m[2]);
      const y = Number(m[3]);
      if (cmd === 'L' && pen) add(w.layer, px, py, x, y);
      seen += 1;
      // The pen moves to the last pair of a command: one for M and L, the
      // second of a Q, the third of a C.
      if (cmd === 'M' || cmd === 'L' || seen === (cmd === 'Q' ? 2 : 3)) {
        px = x;
        py = y;
        pen = true;
        seen = 0;
      }
    }
  }
  return out;
}

/** Pieces on one line (within `snap` across it) that meet end to end (within
 *  four `snap`) as one run each: a border drawn in pieces, or split where a
 *  title block meets it, is one line. Longest first. */
function runsOf(pieces: readonly AxisPiece[], snap: number): Run[] {
  const sorted = [...pieces].sort((a, b) => a.at - b.at);
  const out: Run[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j]!.at - sorted[i]!.at <= snap) j += 1;
    const line = sorted.slice(i, j).sort((a, b) => a.lo - b.lo);
    let run: Run = { at: line[0]!.at, lo: line[0]!.lo, hi: line[0]!.hi };
    for (const p of line) {
      if (p.lo <= run.hi + 4 * snap) {
        run.hi = Math.max(run.hi, p.hi);
      } else {
        out.push(run);
        run = { at: p.at, lo: p.lo, hi: p.hi };
      }
    }
    out.push(run);
    i = j;
  }
  return out.sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
}

/** The line work of a drawing, read once a build: each piece with its box,
 *  and the straight pieces along an axis. */
type LineWork = { work: Stroke[]; pieces: AxisPiece[] };

function lineWorkOf(rows: Pick<RedrawRows, 'segments' | 'shapes'>): LineWork {
  const work = strokesOf(rows);
  return { work, pieces: axisPieces(work) };
}

/* ----------------------------------------------------------- the sheet */

/** The sheet's rectangle in drawing units, and the placement that draws it
 *  when its border is one block (by handle). */
export type RedrawSheet = Extent & { handle: string | null };

/** Lines this share of the longest line apart are one line. */
const SHEET_SNAP = 2e-4;
/** The longest runs looked at each way, and the largest rectangles tried. */
const SHEET_RUNS = 128;
const SHEET_TRIES = 8;
/** A corner of the sheet may be open by this share of its height. */
const SHEET_CORNER = 0.01;
/** The sheet's edge: this share of its long side, each way from the line. */
const SHEET_EDGE = 0.002;
/** A sheet holds at least this share of the rest of the drawing. */
const SHEET_HOLDS = 0.5;

/** The inside of a sheet, and the sheet with its edge: what does not reach
 *  the inside, or wraps it, is the sheet's border or lies outside it. */
function sheetRim(sheet: Extent): { inside: Extent; outside: Extent } {
  const edge = SHEET_EDGE * Math.max(sheet.x1 - sheet.x0, sheet.y1 - sheet.y0);
  return { inside: grown(sheet, -edge), outside: grown(sheet, edge) };
}

/** Whether a box is the sheet's border or outside the sheet. */
const offSheet = (rim: { inside: Extent }, e: Extent): boolean =>
  !meetsBox(rim.inside, e) || holdsBox(e, rim.inside);

/**
 * The sheet: the largest rectangle the drawing draws, as one block (the
 * border and title block placed as a symbol) or as four lines whose corners
 * meet (loose lines, lines in pieces, or a closed polyline). Two tests, the
 * same for both: nothing crosses its edge (a pipe crosses the box around a
 * package; nothing crosses a sheet's border), and it holds at least half of
 * the rest of the drawing, its own border aside (a legend's box in a
 * drawing with no border does not). Null when no rectangle passes: nothing
 * is then outside.
 */
export function sheetOf(
  rows: Pick<RedrawRows, 'segments' | 'shapes' | 'placements' | 'symbols'>,
  lines: LineWork = lineWorkOf(rows),
): RedrawSheet | null {
  const { work, pieces } = lines;
  const boxes = new Map<string, Box>();
  for (const s of rows.symbols) {
    const b = boxOf(s);
    if (b && !boxes.has(s.key)) boxes.set(s.key, b);
  }
  // Every placement as a box (a point when its symbol has no drawing).
  const placed = rows.placements.map((p) => {
    const b = boxes.get(p.key);
    return b ? placedBox(p, b) : { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  });
  const tries: RedrawSheet[] = [];

  // As one block: the largest placed symbol.
  let big = -1;
  let area = 0;
  placed.forEach((e, i) => {
    const a = (e.x1 - e.x0) * (e.y1 - e.y0);
    if (a > area) {
      area = a;
      big = i;
    }
  });
  if (big >= 0) tries.push({ ...placed[big]!, handle: rows.placements[big]!.handle || null });

  // As four lines: for each two runs across, the outermost two runs down
  // that reach both, inside both.
  const longest = pieces.reduce((m, p) => Math.max(m, p.hi - p.lo), 0);
  const snap = SHEET_SNAP * longest;
  const across = runsOf(
    pieces.filter((p) => p.flat),
    snap,
  ).slice(0, SHEET_RUNS);
  const down = runsOf(
    pieces.filter((p) => !p.flat),
    snap,
  ).slice(0, SHEET_RUNS);
  const rects: RedrawSheet[] = [];
  for (const a of across) {
    for (const b of across) {
      if (!(b.at > a.at)) continue;
      const open = SHEET_CORNER * (b.at - a.at);
      const lo = Math.max(a.lo, b.lo) - open;
      const hi = Math.min(a.hi, b.hi) + open;
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const v of down) {
        if (v.at < lo || v.at > hi || v.lo > a.at + open || v.hi < b.at - open) continue;
        x0 = Math.min(x0, v.at);
        x1 = Math.max(x1, v.at);
      }
      if (x1 > x0) rects.push({ x0, y0: a.at, x1, y1: b.at, handle: null });
    }
  }
  const areaOf = (e: Extent) => (e.x1 - e.x0) * (e.y1 - e.y0);
  rects.sort((p, q) => areaOf(q) - areaOf(p));
  tries.push(...rects.slice(0, SHEET_TRIES));
  tries.sort((p, q) => areaOf(q) - areaOf(p));

  const all = [...work, ...placed];
  for (const sheet of tries) {
    const rim = sheetRim(sheet);
    let crossed = false;
    let rest = 0;
    let held = 0;
    for (const e of all) {
      if (holdsBox(e, rim.inside)) continue; // the sheet itself
      const within = holdsBox(rim.outside, e);
      if (!meetsBox(rim.inside, e)) {
        // On the edge it is the border; past it, the rest outside.
        if (!within) rest += 1;
        continue;
      }
      if (!within) {
        crossed = true;
        break;
      }
      rest += 1;
      held += 1;
    }
    if (!crossed && held > 0 && held >= SHEET_HOLDS * rest) return sheet;
  }
  return null;
}

/**
 * The frame guess: a layer whose lines span at least 90% of the sheet both
 * ways (of all the line work, when the drawing draws no sheet), with a line
 * along an axis longer than half its width, and no placement. The rule as
 * it always was, but measured on the sheet (a table under the border makes
 * the line work taller than the border) and on whole lines (a Segments row
 * is a piece of a line, cut where another line ends on it).
 */
export function frameLayers(
  rows: Pick<RedrawRows, 'segments' | 'placements' | 'shapes' | 'symbols'>,
  sheet?: RedrawSheet | null,
  lines: LineWork = lineWorkOf(rows),
): Set<string> {
  const out = new Set<string>();
  const all = (sheet === undefined ? sheetOf(rows, lines) : sheet) ?? extentOf(lines.work);
  if (!all) return out;
  const sw = all.x1 - all.x0;
  const sh = all.y1 - all.y0;
  const withPlacements = new Set(rows.placements.map((p) => p.layer));
  const long = new Set<string>();
  for (const p of lines.pieces) if (p.hi - p.lo > 0.5 * sw) long.add(p.layer);
  const spans = new Map<string, Extent>();
  for (const w of lines.work) {
    const e = spans.get(w.layer);
    if (!e) {
      spans.set(w.layer, { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
      continue;
    }
    e.x0 = Math.min(e.x0, w.x0);
    e.y0 = Math.min(e.y0, w.y0);
    e.x1 = Math.max(e.x1, w.x1);
    e.y1 = Math.max(e.y1, w.y1);
  }
  for (const [layer, e] of spans) {
    if (withPlacements.has(layer) || !long.has(layer)) continue;
    if (e.x1 - e.x0 >= 0.9 * sw && e.y1 - e.y0 >= 0.9 * sh) out.add(layer);
  }
  return out;
}

/* ------------------------------------------------------------ dashes */

/** A dash pattern as the parser writes it: numbers and spaces only. */
const DASH = /^\d[\d. ]*$/;
/** The longest dash or gap of a pattern, on the screen, and the least a
 *  dash and a gap are (a line's round ends take from each gap). */
const DASH_LONGEST_PX = 8;
const DASH_LEAST_PX = 2;
const GAP_LEAST_PX = 3;

/**
 * A dash pattern as the canvas draws it: the pattern's own shape (a long
 * dash and a short one stay so, a dot stays a dot), in screen pixels with
 * its longest part 8 px. Not in drawing units: a line keeps its width on
 * the screen at any zoom, and its dashes with it, so a dashed line reads as
 * dashed from the whole sheet down to one valve. '' for no pattern.
 */
export function dashPixels(dash: string | null | undefined): string {
  if (!dash || !DASH.test(dash)) return '';
  const parts = dash.trim().split(/\s+/).map(Number);
  const longest = Math.max(...parts);
  // Dash and gap in turn: an odd count is no pattern (SVG would read it
  // twice over, with dash and gap swapped the second time).
  if (parts.length % 2 || parts.length > 12 || !parts.every(finite) || !(longest > 0)) return '';
  return parts
    .map((v, i) => {
      const px = Number(((v / longest) * DASH_LONGEST_PX).toFixed(1));
      if (i % 2) return Math.max(GAP_LEAST_PX, px);
      return v === 0 ? 0 : Math.max(DASH_LEAST_PX, px);
    })
    .join(' ');
}

/* ----------------------------------------------------- placement math */

function boxOf(s: RedrawSymbol): Box | null {
  if (!s.svg || !finite(s.x0) || !finite(s.y0) || !finite(s.width) || !finite(s.height)) {
    return null;
  }
  return s.width > 0 && s.height > 0 ? { x0: s.x0, y0: s.y0, w: s.width, h: s.height } : null;
}

/** The world box of a symbol box set by a placement (as its transform does). */
export function placedBox(p: RedrawPlacement, b: Box): Extent {
  const a = ((p.rotation ?? 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const sx = p.xscale ?? 1;
  const sy = p.yscale ?? 1;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of [
    [b.x0, b.y0],
    [b.x0 + b.w, b.y0],
    [b.x0, b.y0 + b.h],
    [b.x0 + b.w, b.y0 + b.h],
  ] as const) {
    const u = x * sx;
    const v = y * sy;
    const wx = p.x + u * c - v * s;
    const wy = p.y + u * s + v * c;
    x0 = Math.min(x0, wx);
    x1 = Math.max(x1, wx);
    y0 = Math.min(y0, wy);
    y1 = Math.max(y1, wy);
  }
  return { x0, y0, x1, y1 };
}

export type PlacementCheck = {
  /** Placements with a symbol box and a reader box to compare. */
  compared: number;
  /** Placed symbol box inside the reader's box (2% slack). */
  inside: number;
  /** Of the rest, the reader's box has no size (a point): not comparable. */
  pointBoxes: number;
  /** Median overlap (intersection over union) of the compared boxes. */
  iouMedian: number | null;
};

/**
 * The hand test's check: each placed symbol box against the CAD reader's own
 * box of the same insert (by handle). A pass is a box inside the reader's.
 */
export function placementCheck(rows: RedrawRows): PlacementCheck {
  const boxes = new Map<string, Box>();
  for (const s of rows.symbols) {
    const b = boxOf(s);
    if (b) boxes.set(s.key, b);
  }
  const reader = new Map(rows.inserts.map((i) => [i.handle, i]));
  const ious: number[] = [];
  let inside = 0;
  let pointBoxes = 0;
  for (const p of rows.placements) {
    const b = boxes.get(p.key);
    const r = reader.get(p.handle);
    if (!b || !r) continue;
    const a = placedBox(p, b);
    const bw = r.maxX - r.minX;
    const bh = r.maxY - r.minY;
    const iw = Math.max(0, Math.min(a.x1, r.maxX) - Math.max(a.x0, r.minX));
    const ih = Math.max(0, Math.min(a.y1, r.maxY) - Math.max(a.y0, r.minY));
    const inter = iw * ih;
    const union = (a.x1 - a.x0) * (a.y1 - a.y0) + bw * bh - inter;
    ious.push(union > 0 ? inter / union : 0);
    const tol = Math.max(bw, bh) * 0.02 + 1e-6;
    if (
      a.x0 >= r.minX - tol &&
      a.y0 >= r.minY - tol &&
      a.x1 <= r.maxX + tol &&
      a.y1 <= r.maxY + tol
    ) {
      inside += 1;
    } else if (bw <= 1e-9 && bh <= 1e-9) {
      pointBoxes += 1;
    }
  }
  ious.sort((x, y) => x - y);
  return {
    compared: ious.length,
    inside,
    pointBoxes,
    iouMedian: ious.length ? ious[Math.floor(ious.length / 2)]! : null,
  };
}

/* ------------------------------------------------------------ text size */

/** What an SVG font size is for a CAD text height (the height of a capital:
 *  0.716 of the em in Arial and the fonts cut to its sizes). */
const EM_PER_HEIGHT = 1.4;

/** An MTEXT's line pitch, in text heights (the parser's LINE_GAP). */
const LINE_GAP = 5 / 3;

/** Where a text is set from: its anchor when the row has one, else X, Y. */
const setFrom = (t: RedrawText): { x: number; y: number; anchored: boolean } =>
  finite(t.anchorX) && finite(t.anchorY)
    ? { x: t.anchorX, y: t.anchorY, anchored: true }
    : { x: t.x, y: t.y, anchored: false };

/** The most texts the gap guess looks at each way from a text. */
const SCAN_STEPS = 64;

/** The first index of a list sorted by y whose y is at least `y`. */
function firstAtOrAbove(list: readonly { y: number }[], y: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.y < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The gap guess, for texts with no Height (a file read before the sizes):
 * each text gets 0.65 of the gap to its nearest text above or below (within
 * 1% of the width sideways), between 0.4 and 1 times the sheet's usual size
 * (0.6 of the median gap). Returns a font size per text, by index.
 */
export function gapSizes(texts: readonly RedrawText[], width: number, height: number): number[] {
  const near = Math.max(width * 0.01, 1e-9);
  const columns = new Map<number, { y: number; x: number }[]>();
  for (const t of texts) {
    const k = Math.floor(t.x / near);
    const list = columns.get(k);
    if (list) list.push({ y: t.y, x: t.x });
    else columns.set(k, [{ y: t.y, x: t.x }]);
  }
  for (const list of columns.values()) list.sort((a, b) => a.y - b.y);
  const gaps = texts.map((t) => {
    let best = Infinity;
    const k = Math.floor(t.x / near);
    for (const list of [columns.get(k - 1), columns.get(k), columns.get(k + 1)]) {
      if (!list) continue;
      // Texts at the same height are no gap: skip past them both ways, then
      // look at most SCAN_STEPS texts each way (a column of thousands of
      // texts stays linear).
      const below = firstAtOrAbove(list, t.y - 1e-6) - 1;
      const above = firstAtOrAbove(list, t.y + 1e-6 + Number.EPSILON);
      for (const [start, dir] of [
        [below, -1],
        [above, 1],
      ] as const) {
        for (let i = start, n = 0; i >= 0 && i < list.length && n < SCAN_STEPS; i += dir, n += 1) {
          const q = list[i]!;
          const dy = Math.abs(q.y - t.y);
          if (dy >= best) break;
          if (Math.abs(q.x - t.x) < near) best = dy;
        }
      }
    }
    return best;
  });
  const known = gaps.filter(Number.isFinite).sort((a, b) => a - b);
  const base = known.length
    ? 0.6 * known[Math.floor(known.length / 2)]!
    : Math.max(width, height, 1e-9) / 300;
  return gaps.map((g) =>
    Number.isFinite(g) ? Math.min(base, Math.max(0.4 * base, 0.65 * g)) : base,
  );
}

/* -------------------------------------------------------------- build */

function inWindow(w: RedrawWindow, x: number, y: number): boolean {
  return x >= w[0] && x <= w[2] && y >= w[1] && y <= w[3];
}

function meets(w: RedrawWindow, e: Extent): boolean {
  return e.x1 >= w[0] && e.x0 <= w[2] && e.y1 >= w[1] && e.y0 <= w[3];
}

/** Digits after the point that a span needs (about 1/200,000 of it). */
function digitsFor(span: number): number {
  if (!(span > 0)) return 3;
  return Math.max(0, Math.min(6, Math.ceil(-Math.log10(span / 200_000))));
}

/** Build the canvas. Rows must hold finite numbers (the reader skips others). */
export function buildRedraw(rows: RedrawRows, opts: RedrawOptions): RedrawResult {
  const win = opts.window;
  const boxes = new Map<string, Box>();
  for (const s of rows.symbols) {
    const b = boxOf(s);
    if (b && !boxes.has(s.key)) boxes.set(s.key, b);
  }

  // What is shown. A segment whose entity has a Shapes row is drawn from
  // there, exact; every other segment (a LINE, or a curve the Shapes caps
  // left out) is drawn as it is.
  const shaped = new Set((rows.shapes ?? []).map((h) => h.handle).filter(Boolean));
  const drawable = shaped.size
    ? rows.segments.filter((s) => !s.handle || !shaped.has(s.handle))
    : rows.segments;
  const segments = win
    ? drawable.filter((s) =>
        meets(win, {
          x0: Math.min(s.x1, s.x2),
          y0: Math.min(s.y1, s.y2),
          x1: Math.max(s.x1, s.x2),
          y1: Math.max(s.y1, s.y2),
        }),
      )
    : drawable;
  const shapes = (rows.shapes ?? []).filter(
    (h) =>
      SHAPE_PATH.test(h.path) &&
      (!win || meets(win, { x0: h.minX, y0: h.minY, x1: h.maxX, y1: h.maxY })),
  );
  const placements = win
    ? rows.placements.filter((p) => {
        const b = boxes.get(p.key);
        return b ? meets(win, placedBox(p, b)) : inWindow(win, p.x, p.y);
      })
    : rows.placements;
  const texts = win
    ? rows.texts.filter((t) => inWindow(win, setFrom(t).x, setFrom(t).y))
    : rows.texts;

  // The area: the window, else the segments and placements (texts too when
  // there is nothing else).
  let ext: Extent;
  if (win) {
    ext = { x0: win[0], y0: win[1], x1: win[2], y1: win[3] };
  } else {
    ext = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const s of segments) {
      ext.x0 = Math.min(ext.x0, s.x1, s.x2);
      ext.x1 = Math.max(ext.x1, s.x1, s.x2);
      ext.y0 = Math.min(ext.y0, s.y1, s.y2);
      ext.y1 = Math.max(ext.y1, s.y1, s.y2);
    }
    for (const h of shapes) {
      ext.x0 = Math.min(ext.x0, h.minX);
      ext.x1 = Math.max(ext.x1, h.maxX);
      ext.y0 = Math.min(ext.y0, h.minY);
      ext.y1 = Math.max(ext.y1, h.maxY);
    }
    for (const p of placements) {
      ext.x0 = Math.min(ext.x0, p.x);
      ext.x1 = Math.max(ext.x1, p.x);
      ext.y0 = Math.min(ext.y0, p.y);
      ext.y1 = Math.max(ext.y1, p.y);
    }
    if (!(ext.x0 <= ext.x1)) {
      for (const t of texts) {
        const at = setFrom(t);
        ext.x0 = Math.min(ext.x0, at.x);
        ext.x1 = Math.max(ext.x1, at.x);
        ext.y0 = Math.min(ext.y0, at.y);
        ext.y1 = Math.max(ext.y1, at.y);
      }
    }
    if (!(ext.x0 <= ext.x1)) ext = { x0: 0, y0: 0, x1: 1, y1: 1 };
  }
  const W = ext.x1 - ext.x0;
  const H = ext.y1 - ext.y0;
  const span = Math.max(W, H);
  const digits = digitsFor(span);
  const f = (v: number) => {
    const s = Number(v.toFixed(digits)).toString();
    return s === '-0' ? '0' : s;
  };
  // A symbol box's corner in block units, as stored: a block drawn in place
  // at site coordinates has its box millions of units from its base point.
  // Its turn and scales are written as stored too: they act on that corner,
  // so at 6 digits a turn of 12.3457 moved such a symbol by several units.
  const exact = (v: number) => (Object.is(v, -0) ? '0' : String(v));
  // Sizes in their own units (a symbol's size, scales, turns, font sizes):
  // six significant digits, whatever the drawing's span.
  const g = (v: number) => {
    const s = Number(v.toPrecision(6)).toString();
    return s === '-0' ? '0' : s;
  };
  // Local coordinates: from the area's corner, y up.
  const lx = (x: number) => f(x - ext.x0);
  const ly = (y: number) => f(y - ext.y0);

  // The sheet, and what is its border or outside it: frame items, one class.
  const lineWork = lineWorkOf(rows);
  const sheet = sheetOf(rows, lineWork);
  const rim = sheet ? sheetRim(sheet) : null;
  const framed = (e: Extent): boolean => rim !== null && offSheet(rim, e);
  let frameItems = 0;

  // Layers: every layer of the drawing, by name.
  const frames = frameLayers(rows, sheet, lineWork);
  const hide = new Set(opts.hideLayers ?? []);
  const names = [
    ...new Set([
      ...rows.segments.map((s) => s.layer),
      ...(rows.shapes ?? []).map((h) => h.layer),
      ...rows.placements.map((p) => p.layer),
      ...rows.texts.map((t) => t.layer),
    ]),
  ].sort();
  const index = new Map(names.map((n, i) => [n, i]));
  const layers: RedrawLayer[] = names.map((name) => ({
    name,
    frame: frames.has(name),
    off: hide.has(name) || (opts.frame !== 'on' && frames.has(name)),
  }));
  const unknownLayers = [...hide].filter((n) => !index.has(n));
  const cls = (layer: string) => `L${index.get(layer)}`;

  // Symbols: one definition each, for the placements shown.
  const ids = new Map<string, string>();
  const shownKeys = new Set(placements.map((p) => p.key));
  let defs = '';
  for (const s of rows.symbols) {
    if (ids.has(s.key) || !boxes.has(s.key) || !shownKeys.has(s.key)) continue;
    const clean = sanitizeSymbolSvg(s.svg!);
    if (!clean) continue;
    const id = `s${ids.size}`;
    ids.set(s.key, id);
    // fill and stroke also as attributes: a picture renderer that does not
    // carry the style sheet into a <use> copy would fill every closed shape
    // black (found on the first real use, 2026-11-13). fill-rule as ezdxf
    // draws: the hole of a letter stays a hole.
    defs += `<symbol id="${id}" viewBox="${clean.viewBox}" preserveAspectRatio="none" overflow="visible" fill="none" fill-rule="evenodd" stroke="#1f5fd6" stroke-linecap="round" stroke-linejoin="round">${clean.inner}</symbol>`;
  }

  let uses = '';
  let checks = '';
  let drawn = 0;
  let missing = 0;
  const reader = new Map(rows.inserts.map((i) => [i.handle, i]));
  for (const p of placements) {
    const id = ids.get(p.key);
    const b = boxes.get(p.key);
    if (!id || !b) {
      missing += 1;
      continue;
    }
    drawn += 1;
    const t =
      `translate(${lx(p.x)} ${ly(p.y)}) rotate(${exact(p.rotation ?? 0)}) ` +
      `scale(${exact(p.xscale ?? 1)} ${exact(p.yscale ?? 1)}) translate(${exact(b.x0)} ${exact(b.y0 + b.h)}) scale(1 -1)`;
    const fr = framed(placedBox(p, b));
    if (fr) frameItems += 1;
    uses += `<use class="${cls(p.layer)}${fr ? ' fr' : ''}" href="#${id}" width="${g(b.w)}" height="${g(b.h)}" transform="${t}"/>`;
    const r = reader.get(p.handle);
    if (r) {
      checks += `<rect x="${lx(r.minX)}" y="${ly(r.minY)}" width="${f(r.maxX - r.minX)}" height="${f(r.maxY - r.minY)}"/>`;
    }
  }
  // A placement with its handle in the reader's list but no symbol box
  // stays uncounted above; it is in `missing`.

  // Lines: one path a layer (a second one for its frame items), a move only
  // where a segment does not go on from the last one.
  type LinePath = {
    layer: string;
    fr: boolean;
    fill: boolean;
    dash: string;
    d: string[];
    ex: string;
    ey: string;
  };
  const paths = new Map<string, LinePath>();
  const pathOf = (layer: string, fr: boolean, fill = false, dash = ''): LinePath => {
    // The two flags and the dashes (numbers and spaces), a bar, then the
    // layer's name: no name can read as a flag or a dash.
    const key = `${fr ? 1 : 0}${fill ? 1 : 0}${dash}|${layer}`;
    let p = paths.get(key);
    if (!p) {
      p = { layer, fr, fill, dash, d: [], ex: '', ey: '' };
      paths.set(key, p);
    }
    if (fr) frameItems += 1;
    return p;
  };
  for (const s of segments) {
    const a = [lx(s.x1), ly(s.y1)];
    const b = [lx(s.x2), ly(s.y2)];
    const p = pathOf(
      s.layer,
      framed({
        x0: Math.min(s.x1, s.x2),
        y0: Math.min(s.y1, s.y2),
        x1: Math.max(s.x1, s.x2),
        y1: Math.max(s.y1, s.y2),
      }),
    );
    if (p.ex !== a[0] || p.ey !== a[1] || !p.d.length) p.d.push(`M${a[0]} ${a[1]}`);
    p.d.push(`L${b[0]} ${b[1]}`);
    p.ex = b[0]!;
    p.ey = b[1]!;
  }
  // Shapes, into the same path of their layer (a path holds many moves):
  // each x y pair written from the corner, as every other number (a browser
  // reads path data as 32-bit floats: far from the origin, absolute numbers
  // would be drawn off by a visible step).
  for (const h of shapes) {
    // A filled shape (an arrow head) has no dashes, whatever its layer's
    // line type.
    const fill = h.fill === true;
    const p = pathOf(
      h.layer,
      framed({ x0: h.minX, y0: h.minY, x1: h.maxX, y1: h.maxY }),
      fill,
      fill ? '' : dashPixels(h.dash),
    );
    p.d.push(h.path.replace(PATH_PAIR, (_m, x: string, y: string) => `${lx(+x)} ${ly(+y)}`));
    p.ex = '';
    p.ey = '';
  }
  let lines = '';
  for (const p of paths.values()) {
    lines += `<path class="${cls(p.layer)}${p.fill ? ' sf' : ''}${p.fr ? ' fr' : ''}"${p.dash ? ` stroke-dasharray="${p.dash}"` : ''} d="${p.d.join('')}"/>`;
  }

  // Texts: right way up, by Height when the row has one.
  const guess = texts.some((t) => !finite(t.height)) ? gapSizes(texts, W, H) : [];
  let words = '';
  let sized = 0;
  let anchored = 0;
  texts.forEach((t, k) => {
    const own = finite(t.height) && t.height > 0;
    if (own) sized += 1;
    const size = own ? t.height! * EM_PER_HEIGHT : guess[k]!;
    const at = setFrom(t);
    if (at.anchored) anchored += 1;
    const x = lx(at.x);
    const y = f(-(at.y - ext.y0));
    const turn =
      finite(t.rotation) && t.rotation % 360 !== 0
        ? ` transform="rotate(${g(-t.rotation)} ${x} ${y})"`
        : '';
    // An anchored text sits on its baseline at its own side; one from before
    // the anchors hangs from X, Y (an MTEXT from its top-left corner).
    const side = !at.anchored
      ? t.width !== null && finite(t.width)
        ? ' m'
        : ''
      : t.align === 'center'
        ? ' c'
        : t.align === 'right'
          ? ' r'
          : '';
    // Lines: a tspan each, one line pitch down from the last (an empty line
    // is a gap: a tspan with no glyph would lose its step).
    const parts = at.anchored && t.lines ? t.lines.split('\n') : [];
    let body = '';
    if (parts.length > 1) {
      const gap =
        finite(t.lineGap) && t.lineGap > 0 ? t.lineGap : (size * LINE_GAP) / EM_PER_HEIGHT;
      let step = 0;
      parts.forEach((line) => {
        if (line) {
          body += `<tspan x="${x}"${step ? ` dy="${g(step * gap)}"` : ''}>${esc(line)}</tspan>`;
          step = 0;
        }
        step += 1;
      });
    } else {
      body = esc(t.text);
    }
    // A text outside the sheet, or an attribute of the sheet's border block
    // (its title texts), goes with the frame.
    const fr =
      sheet !== null &&
      (framed({ x0: at.x, y0: at.y, x1: at.x, y1: at.y }) ||
        (sheet.handle !== null && t.block === sheet.handle));
    if (fr) frameItems += 1;
    // A one-line text is as long as the drawing has it: its letters are
    // squeezed or stretched to its Length, so its far end lands right (a
    // narrow style, a wider font) and it is the same on every desk.
    const long =
      at.anchored && parts.length <= 1 && finite(t.length) && t.length > 0
        ? ` textLength="${g(t.length)}" lengthAdjust="spacingAndGlyphs"`
        : '';
    words += `<text class="${cls(t.layer)}${side}${t.underline ? ' u' : ''}${fr ? ' fr' : ''}" x="${x}" y="${y}" font-size="${g(size)}"${long}${turn}>${body}</text>`;
  });

  const pad = span * 0.02 || 1;
  // The view: the area shown; with the frame off and no window asked, the
  // sheet (what is outside it is off, so the view opens on the drawing).
  const frameOff = opts.frame !== 'on' && frameItems > 0;
  let vb = `${f(-pad)} ${f(-H - pad)} ${f(W + 2 * pad)} ${f(H + 2 * pad)}`;
  if (frameOff && sheet && !win) {
    const sw = sheet.x1 - sheet.x0;
    const sh = sheet.y1 - sheet.y0;
    const sp = Math.max(sw, sh) * 0.02;
    vb = `${f(sheet.x0 - ext.x0 - sp)} ${f(-(sheet.y1 - ext.y0) - sp)} ${f(sw + 2 * sp)} ${f(sh + 2 * sp)}`;
  }
  const counts: RedrawCounts = {
    symbols: ids.size,
    placements: drawn,
    lines: segments.length,
    shapes: shapes.length,
    texts: texts.length,
    placements_without_symbol: missing,
    texts_with_height: sized,
    texts_with_anchor: anchored,
    frame_items: frameItems,
  };
  const offStyle = layers.map((l, i) => (l.off ? `.L${i}{display:none}` : '')).join('');
  const panel = layers
    .map(
      (l, i) =>
        `<label><input type="checkbox" data-l="${i}"${l.off ? '' : ' checked'}> ${esc(l.name) || '(no layer)'}${l.frame ? ' (frame?)' : ''}</label>`,
    )
    .join('');
  const foot =
    `${esc(opts.source)}: ${drawn} symbols placed (${ids.size} drawings), ${segments.length + shapes.length} lines and shapes, ` +
    `${texts.length} texts` +
    (missing ? `, ${missing} placements with no symbol drawing` : '') +
    (win ? `. Window ${win.map(f).join(', ')}` : '') +
    '. Drawn from the file database; no model.';

  const html = `<!doctype html>
<html>
<head>
<title>${esc(opts.title)}</title>
<meta name="description" content="A drawing rebuilt from its own file database: lines from Segments, symbols from Symbols placed by Placements, texts from Texts. Check boxes: the CAD reader's own insert boxes." />
<meta name="canvas:size" content="fill" />
<style>
:root { color-scheme: light; }
html, body { margin: 0; height: 100%; background: #fff; color: #111; font-family: system-ui, sans-serif; overflow: hidden; }
#bar, #layers, #foot, #bar *, #layers *, #foot * { color: #111 !important; }
#bar input, #layers input { accent-color: #1f5fd6; width: 14px; height: 14px; appearance: auto; -webkit-appearance: checkbox; opacity: 1; background: #fff; border: 1px solid #555; }
#bar { position: absolute; top: 8px; left: 8px; z-index: 2; display: flex; flex-wrap: wrap; gap: 12px; padding: 6px 10px; background: #f4f4f5; border: 1px solid #999; border-radius: 6px; font-size: 13px; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
#bar label { display: flex; gap: 4px; align-items: center; cursor: pointer; }
#layers { position: absolute; top: 48px; left: 8px; z-index: 2; max-height: 70%; overflow: auto; scrollbar-width: thin; display: flex; flex-direction: column; gap: 2px; padding: 6px 10px; background: #f4f4f5; border: 1px solid #999; border-radius: 6px; font-size: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
#foot { position: absolute; bottom: 6px; left: 8px; z-index: 2; padding: 3px 8px; background: #f4f4f5; border: 1px solid #999; border-radius: 4px; font-size: 11px; }
svg#d { width: 100%; height: 100%; cursor: grab; touch-action: none; user-select: none; }
#lines path { fill: none; stroke: #555; stroke-width: 1.2px; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
/* What the drawing fills: an arrow head (SOLID), a bar (TRACE). */
#lines path.sf { fill: #555; }
/* A <use> copy takes the style of its <symbol> in <defs>, never of #syms. */
defs symbol * { fill: none !important; stroke: #1f5fd6 !important; stroke-width: 1.5px !important; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
/* What the drawing fills in a symbol: a text's letters, a solid, a wide line. */
defs symbol .f { fill: #1f5fd6 !important; stroke: none !important; }
#checks rect { fill: none; stroke: #d62728; stroke-width: 1; stroke-dasharray: 3 2; vector-effect: non-scaling-stroke; }
#words text { fill: #333; white-space: pre; font-family: Arial, Helvetica, "Liberation Sans", sans-serif; }
#words text.m { dominant-baseline: text-before-edge; }
#words text.c { text-anchor: middle; }
#words text.r { text-anchor: end; }
#words text.u { text-decoration: underline; }
.off { display: none !important; }
</style>
<style id="ls">${offStyle}</style>
<style id="fs">${frameOff ? '.fr{display:none}' : ''}</style>
</head>
<body>
<div id="bar">
<label><input type="checkbox" data-g="lines" checked> Lines</label>
<label><input type="checkbox" data-g="syms" checked> Symbols (${drawn})</label>
<label><input type="checkbox" data-g="words" checked> Texts</label>
<label><input type="checkbox" data-g="checks"> Check boxes</label>
<label><input type="checkbox" id="showLayers"> Layers</label>
${frameItems ? `<label><input type="checkbox" id="showFrame"${frameOff ? '' : ' checked'}> Frame</label>\n` : ''}<span>Wheel: zoom. Drag: move.</span>
</div>
<div id="layers" class="off">${panel}</div>
<div id="foot">${foot}</div>
<svg id="d" viewBox="${vb}" xmlns="http://www.w3.org/2000/svg">
<defs>${defs}</defs>
<g transform="scale(1 -1)">
<g id="lines">${lines}</g>
<g id="syms">${uses}</g>
<g id="checks" class="off">${checks}</g>
</g>
<g id="words">${words}</g>
</svg>
<script>
const svg = document.getElementById('d');
let vb = svg.getAttribute('viewBox').split(' ').map(Number);
const set = () => svg.setAttribute('viewBox', vb.join(' '));
for (const box of document.querySelectorAll('#bar input[data-g]')) {
  box.addEventListener('change', () => document.getElementById(box.dataset.g).classList.toggle('off', !box.checked));
}
document.getElementById('showLayers').addEventListener('change', (e) => document.getElementById('layers').classList.toggle('off', !e.target.checked));
const layerBoxes = [...document.querySelectorAll('#layers input')];
const applyLayers = () => {
  document.getElementById('ls').textContent = layerBoxes.filter((b) => !b.checked).map((b) => '.L' + Number(b.dataset.l) + '{display:none}').join('');
};
for (const b of layerBoxes) b.addEventListener('change', applyLayers);
// The sheet's border and what is outside the sheet: one class, one switch.
const frameBox = document.getElementById('showFrame');
if (frameBox) frameBox.addEventListener('change', () => { document.getElementById('fs').textContent = frameBox.checked ? '' : '.fr{display:none}'; });
// The viewBox sets the picture's size in the box: the units per screen
// pixel follow the longer side (preserveAspectRatio meet), from the centre.
const unitsPerPx = () => {
  const r = svg.getBoundingClientRect();
  return Math.max(vb[2] / r.width, vb[3] / r.height);
};
const toUnits = (e) => {
  const r = svg.getBoundingClientRect();
  const u = unitsPerPx();
  const cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2;
  return [cx + (e.clientX - r.left - r.width / 2) * u, cy + (e.clientY - r.top - r.height / 2) * u];
};
// Zoom: wheel steps are summed and drawn once a frame.
let zoomK = 1, zoomAt = null, zoomQueued = false;
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomK *= Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.0015)));
  zoomAt = toUnits(e);
  if (zoomQueued) return;
  zoomQueued = true;
  requestAnimationFrame(() => {
    const [mx, my] = zoomAt, k = zoomK;
    vb = [mx - (mx - vb[0]) * k, my - (my - vb[1]) * k, vb[2] * k, vb[3] * k];
    zoomK = 1; zoomQueued = false;
    set();
  });
}, { passive: false });
// Drag: move the drawn picture (no redraw), set the viewBox once on release.
let drag = null;
svg.style.willChange = 'transform';
svg.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
  svg.setPointerCapture(e.pointerId);
  svg.style.cursor = 'grabbing';
});
svg.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.dx = e.clientX - drag.x; drag.dy = e.clientY - drag.y;
  svg.style.transform = 'translate(' + drag.dx + 'px,' + drag.dy + 'px)';
});
const end = () => {
  if (!drag) return;
  const u = unitsPerPx();
  vb = [vb[0] - drag.dx * u, vb[1] - drag.dy * u, vb[2], vb[3]];
  drag = null;
  svg.style.transform = '';
  svg.style.cursor = '';
  set();
};
svg.addEventListener('pointerup', end);
svg.addEventListener('pointercancel', end);
</script>
</body>
</html>
`;
  return {
    html,
    bytes: new TextEncoder().encode(html).length,
    window: [ext.x0, ext.y0, ext.x1, ext.y1],
    sheet: sheet ? [sheet.x0, sheet.y0, sheet.x1, sheet.y1] : null,
    counts,
    layers,
    unknownLayers,
  };
}

/**
 * A window that fits `maxBytes`, when the whole does not: centred on the
 * shown area, shrunk by the share of bytes over, built to check. Null when
 * even a small window does not fit (a dense knot of rows).
 */
export function windowThatFits(
  rows: RedrawRows,
  opts: RedrawOptions,
  first: RedrawResult,
  maxBytes: number,
): [number, number, number, number] | null {
  let [x0, y0, x1, y1] = first.window;
  let bytes = first.bytes;
  for (let i = 0; i < 8; i += 1) {
    const k = Math.sqrt((0.85 * maxBytes) / bytes);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const hw = ((x1 - x0) * Math.min(k, 0.9)) / 2;
    const hh = ((y1 - y0) * Math.min(k, 0.9)) / 2;
    if (!(hw > 0) || !(hh > 0)) return null;
    const w: [number, number, number, number] = [cx - hw, cy - hh, cx + hw, cy + hh];
    const round = Math.pow(10, Math.max(0, digitsFor(Math.max(hw, hh) * 2) - 2));
    const snapped: [number, number, number, number] = [
      Math.floor(w[0] * round) / round,
      Math.floor(w[1] * round) / round,
      Math.ceil(w[2] * round) / round,
      Math.ceil(w[3] * round) / round,
    ];
    const got = buildRedraw(rows, { ...opts, window: snapped });
    if (got.bytes <= maxBytes) return snapped;
    [x0, y0, x1, y1] = snapped;
    bytes = got.bytes;
  }
  return null;
}
