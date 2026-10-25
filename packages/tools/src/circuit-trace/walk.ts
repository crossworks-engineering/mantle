/**
 * circuit_trace, the pure part: one circuit's geometry from the DWG bones
 * tabs (Segments, Nodes, Inserts, Blocks, Texts, Circuits; phase 1, see
 * infra/media-sidecar/dwg_bones.py) walked into ordered runs, sheet links,
 * a `pid` template input and, when an outside register is given, the
 * differences both ways.
 *
 * No I/O: ./read.ts fills `SheetInput` from the tables the caller may read,
 * and this module only sees what that read returned. Everything it cannot
 * know for sure (a link between sheets with no label naming the other
 * sheet, an equipment type read from a tag letter, a valve type read from a
 * block name) is said in `guesses`, and everything it could not see (a
 * capped tab, a sheet that is not uploaded) in `limits`.
 */

import { buildPid } from './pid';

/* ------------------------------------------------------------------ input */

export type SegRow = {
  layer: string;
  handle: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
  n1: number;
  n2: number;
  /** The polyline vertex pair (0 for a LINE): with the handle, one straight
   *  piece of the drawn entity. */
  part?: number;
};
export type NodeRow = {
  id: number;
  x: number;
  y: number;
  degree: number;
  kind: string;
  block: string;
  blockHandle: string;
  layers: string[];
};
export type InsertRow = {
  block: string;
  layer: string;
  handle: string;
  x: number;
  y: number;
  minX: number | null;
  minY: number | null;
  maxX: number | null;
  maxY: number | null;
};
export type TextRow = { text: string; layer: string; x: number; y: number };
export type BlockRow = {
  block: string;
  layer: string;
  handle: string;
  x: number;
  y: number;
  attribs: Record<string, string>;
};
export type SheetInput = {
  tableId: string;
  title: string;
  sourceFileId: string | null;
  /** The table's permalink, when the reader has one. */
  url?: string;
  /** Layers of the drawing that are `Circuit <name>` layers (every circuit:
   *  an end that meets one of them names that circuit). */
  circuitLayers: string[];
  /** The Circuits tab rows of this circuit (main and injection points). */
  circuitRows: Record<string, unknown>[];
  segments: SegRow[];
  nodes: NodeRow[];
  inserts: InsertRow[];
  texts: TextRow[];
  blocks: BlockRow[];
  /** Labels nearer than this to a run belong to it (drawing units). */
  near: number;
  /** Segments on every other layer around the circuit (process lines,
   *  symbols, borders, other circuits): what its pieces are joined through. */
  network?: SegRow[];
  /** What the read could not see on this sheet (capped tabs, cut reads). */
  limits: string[];
};

export type RegisterLine = { number: string; sheet?: string; deadleg?: boolean };
export type RegisterInput = {
  source?: string;
  /** The circuit's from and to as the register writes them (equipment tags). */
  from?: string;
  to?: string;
  lines?: RegisterLine[];
  sheets?: string[];
  deadlegs?: number;
};

/* ----------------------------------------------------------------- output */

export type EndMeets =
  | { kind: 'open' }
  /** The end's node is not in the Nodes rows read (a capped tab): what it
   *  meets is not known. */
  | { kind: 'unknown' }
  | { kind: 'circuit'; circuit: string; layer: string }
  | { kind: 'layer'; layer: string }
  | { kind: 'block'; block: string; handle: string };

export type TraceEnd = {
  node: number;
  x: number;
  y: number;
  meets: EndMeets;
  deadleg: boolean;
  equipment: string[];
  /** How the equipment was found: the end sits on an outline that holds the
   *  tag (`outline`, with the layer), or the tag is the nearest label. */
  equipmentBasis?: string;
  /** Instrument tags near the end (PI-2001, FV-101): never equipment. */
  instruments: string[];
  labels: string[];
  /** What the trace knows of what lies past this end, when it stops at a
   *  block (a valve): the circuit's layers end there. */
  beyond?: string;
};
export type TraceValve = { block: string; handle: string; type: string; guessed: boolean };
/** Two pieces of the circuit joined where its layer breaks: through the
 *  process line it is drawn over (`process`, with the path's handles), or
 *  across a short gap in one straight line (`gap`: a dash, a break where
 *  another line crosses, a valve drawn in the gap). A geometric fact, not a
 *  guess. */
export type TraceJoin = {
  kind: 'process' | 'gap';
  from: number;
  to: number;
  length: number;
  handles: string[];
  layers: string[];
  /** The path crosses a symbol drawn as plain lines (diagonal strokes). */
  symbol?: boolean;
};
export type TraceChain = {
  id: string;
  from: number;
  to: number;
  role: 'main' | 'deadleg';
  length: number;
  handles: string[];
  valves: TraceValve[];
  lineNumbers: { number: string; handle: string }[];
  /** Where the chain is joined through a process line or a dash gap. */
  joins?: TraceJoin[];
};
export type TraceRun = {
  run: number;
  length: number;
  chains: TraceChain[];
  tees: number[];
  ends: TraceEnd[];
  deadleg: boolean;
};
export type TraceSheet = {
  tableId: string;
  title: string;
  sourceFileId: string | null;
  url?: string;
  layers: string[];
  injectionPoints: string[];
  circuitRows: Record<string, unknown>[];
  runs: TraceRun[];
  deadlegRuns: number;
  lineNumbers: { number: string; handle: string }[];
  blocksOnPath: TraceValve[];
  /** The pieces joined through the network (process lines, dash gaps). */
  joins: TraceJoin[];
};
export type SheetLink = {
  from: { sheet: string; node: number };
  to: { sheet: string; node: number } | null;
  basis: 'label' | 'line-number' | 'only-open-ends';
  guessed: boolean;
  /** The sheet a label names when no end there could be matched. */
  target?: string;
  note: string;
};
export type Discrepancy = {
  kind:
    | 'line_not_in_register'
    | 'register_line_no_geometry'
    | 'register_line_other_sheet'
    | 'register_sheet_not_uploaded'
    | 'deadleg_count'
    | 'deadleg_flag';
  detail: string;
};
export type TraceResult = {
  circuit: string;
  sheets: TraceSheet[];
  links: SheetLink[];
  pid: Record<string, unknown>;
  register?: { source: string; discrepancies: Discrepancy[] };
  guesses: string[];
  limits: string[];
  summary: string;
};

/* ----------------------------------------------------------------- rules */

/** The rules the sidecar's circuit pass (dwg_bones.py) uses too; both sides
 *  are held to packages/files/src/dwg-circuit-rules.golden.json. */
const CIRCUIT_LAYER = /^\s*circuit\s+(.+?)\s*$/i;
/** A circuit name (dwg_bones._CIRCUIT_NAME): letters, digits and . _ / -
 *  with no spaces, at most 64 characters, starting with a letter or digit,
 *  and holding at least one digit ("25000-015-01", "C-101"). */
const CIRCUIT_NAME = /^(?=\D*\d)[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
/** A line-number attribute tag, and a circuit attribute tag. */
export const LINE_TAG = /^LINE[\s_.-]*(NO|NUM|NUMBER)?\.?$/i;
export const CIRCUIT_TAG = /^CIRCUIT([\s_.-]*(NO|NAME|ID))?$/i;
/** Labels within this share of the trimmed extent diagonal are near. */
export const NEAR_REL = 1e-2;
/** A join between two pieces of one circuit through the network is at most
 *  this share of the trimmed extent diagonal long; so is any one straight
 *  piece it may run along (a sheet border is longer). */
export const BRIDGE_REL = 0.15;
/** A straight piece longer than this share of the extent is a border or a
 *  match line (never an equipment outline), and an outline whose box is
 *  wider than it is not one piece of equipment. */
export const EDGE_REL = 0.4;
/** The extent ignores this share of end points at each side. */
export const EXTENT_TRIM = 0.005;

/** The [lo, hi] indexes of the sorted end-point coordinates the extent is
 *  taken between, for `n` coordinates (dwg_bones.extent_diagonal). */
export function trimBounds(n: number): [number, number] {
  if (n <= 0) return [0, 0];
  return [Math.floor(EXTENT_TRIM * (n - 1)), Math.ceil((1 - EXTENT_TRIM) * (n - 1))];
}

/** The diagonal of the box holding the middle 99% of segment end points. */
export function trimmedDiagonal(segs: readonly Pick<SegRow, 'x1' | 'y1' | 'x2' | 'y2'>[]): number {
  const xs = segs.flatMap((g) => [g.x1, g.x2]).sort((a, b) => a - b);
  const ys = segs.flatMap((g) => [g.y1, g.y2]).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const [lo, hi] = trimBounds(xs.length);
  return Math.hypot(xs[hi]! - xs[lo]!, ys[hi]! - ys[lo]!);
}

/* ---------------------------------------------------------------- layers */

/**
 * The layer rule, the same table as dwg_bones.parse_circuit_layer (both
 * are held to packages/files/src/dwg-circuit-rules.golden.json): `Circuit
 * <c>` is the circuit; a deadleg suffix (`-DL`, `-DLn`, `-Bnn-DL`,
 * `-Bnn-DLn`, and `-Dnn`, which is a GUESS: `guessed` is set) makes the
 * layer that circuit's deadleg; `-Bnn` is a branch of it (main); and a name
 * ending `-IPn` once those are off is an injection point, a circuit of its
 * own with `parent` set (so `X-IP1-DL` is the deadleg of injection point
 * X-IP1 of X). A name that is not circuit-number shaped (no digit, a
 * space in it: "Circuit Breakers", or more than 64 characters) is not a
 * circuit, and neither is an injection point whose parent is not one.
 */
export function parseCircuitLayer(layer: string): {
  circuit: string;
  role: 'main' | 'deadleg';
  sub: string;
  parent: string;
  guessed: boolean;
} | null {
  const m = CIRCUIT_LAYER.exec(layer ?? '');
  if (!m) return null;
  let name = m[1]!;
  let role: 'main' | 'deadleg' = 'main';
  let sub = '';
  for (const re of [/^(.+?)-(B\d+-DL\d*)$/i, /^(.+?)-(DL\d*)$/i, /^(.+?)-(D\d+)$/i]) {
    const mm = re.exec(name);
    if (mm) {
      name = mm[1]!;
      role = 'deadleg';
      sub = mm[2]!.toUpperCase();
      break;
    }
  }
  if (role === 'main') {
    const br = /^(.+?)-(B\d+)$/i.exec(name);
    if (br) {
      name = br[1]!;
      sub = br[2]!.toUpperCase();
    }
  }
  const ip = /^(.+?)-(IP\d*)$/i.exec(name);
  const parent = ip ? ip[1]! : '';
  // The root (the circuit, or an injection point's parent) and the name
  // itself must both be circuit-name shaped: `ABC-IP1` is not a circuit.
  if (!CIRCUIT_NAME.test(parent || name) || !CIRCUIT_NAME.test(name)) return null;
  return {
    circuit: name,
    role,
    sub: sub || (ip ? ip[2]!.toUpperCase() : ''),
    parent,
    guessed: /^D\d+$/i.test(sub),
  };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The layers of circuit `c` among `layers`, by role; injection points of
 *  `c` apart (they are circuits of their own). */
export function layersOf(
  circuit: string,
  layers: readonly string[],
): { main: string[]; deadleg: string[]; injection: string[] } {
  const out = { main: [] as string[], deadleg: [] as string[], injection: [] as string[] };
  for (const layer of layers) {
    const p = parseCircuitLayer(layer);
    if (!p) continue;
    if (same(p.circuit, circuit)) out[p.role].push(layer);
    else if (p.parent && same(p.parent, circuit)) out.injection.push(layer);
  }
  return out;
}

/* --------------------------------------------------------------- reading */

/** The pid symbol an equipment tag letter reads as. F is a fired heater
 *  (furnace): the template has no furnace, so it takes the generic heater
 *  symbol (`exchanger`), said where it is used. */
const EQUIPMENT_LETTERS: Readonly<Record<string, string>> = {
  E: 'shell-tube-exchanger',
  P: 'centrifugal-pump',
  V: 'vertical-vessel',
  D: 'horizontal-drum',
  T: 'tank',
  C: 'column',
  K: 'compressor',
  F: 'exchanger',
  A: 'air-cooler',
};
/** What a tag letter names, for the words the trace writes. */
export const EQUIPMENT_KIND: Readonly<Record<string, string>> = {
  E: 'exchanger',
  P: 'pump',
  V: 'vessel',
  D: 'drum',
  T: 'tank',
  C: 'column or vessel',
  K: 'compressor',
  F: 'furnace (fired heater)',
  A: 'air cooler',
};
/** Two-letter equipment prefixes (any other two to four letters before
 *  the number read as an instrument: PI, FV, TT, LT, PSV, FIC). */
const EQUIPMENT_PAIRS: Readonly<Record<string, string>> = { TK: 'tank', EA: 'air-cooler' };
const EQUIPMENT_PAIR_KIND: Readonly<Record<string, string>> = { TK: 'tank', EA: 'air cooler' };
/** A tag: one to four letters, then the number (E-101, P-2001A, PI-2001),
 *  and a revision or train suffix after a slash as drawings write it
 *  (E-101/R1, C-205/ 02). */
const TAG = /^([A-Z]{1,4})-?(\d{2,6}[A-Z]?)(\s*\/\s*[A-Z0-9]{1,4})?$/;
/** A continuation label: CONT, CONTINUED, COD (continued on drawing), SEE
 *  DWG, TO/FROM SHEET, MATCH LINE. */
const CONTINUATION_TEXT =
  /\b(CONT(INUED|INUATION|'?D)?\.?|COD|SEE\s+(DWG|DRG|SHT|SHEET)|(TO|FROM)\s+(DWG|DRG|SHT|SHEET)|MATCH\s*LINE)\b/i;
/** A continuation block name. CONT is not CONTROL (a control valve), nor
 *  CONTAINER / CONTACT / CONTENT; a name that reads as a valve is never one. */
const CONTINUATION_BLOCK =
  /(CONT(?!ROL|AIN|ACT|ENT|OUR)|OPC|OFF.?PAGE|OFF.?SHEET|CONNECTOR|MATCH)/i;

/** Whether a block name reads as a continuation (off-page) symbol. */
export function isContinuationBlock(block: string): boolean {
  return CONTINUATION_BLOCK.test(block) && !valveOf(block);
}

/** Block names, in order: the first that matches says what the block is.
 *  Reducers first (REDU, RED, REDUCER, CONC, ECC): a reducer is never a
 *  valve, though the template draws it inline like one. */
const VALVE_NAMES: readonly [RegExp, string][] = [
  [/REDU|REDUCER|^RED(?![A-Z])|\bRED\b|CONC|ECC/i, 'reducer'],
  [/3.?WAY|THREE.?WAY/i, 'three-way'],
  [/BUTTERFLY|BFV/i, 'butterfly'],
  [/GLOBE/i, 'globe'],
  [/BALL/i, 'ball'],
  [/GATE/i, 'gate'],
  [/CHECK|CHK|NRV/i, 'check'],
  [/RELIEF|PSV|PRV|SRV/i, 'relief'],
  [/CONTROL|\bCV\b|CTRL/i, 'control'],
  [/PLUG/i, 'gate'],
  [/NEEDLE/i, 'globe'],
  [/BLIND|SPADE|SPECT|SPEC.?BL/i, 'blind'],
  [/ORIFICE|\bRO\b/i, 'orifice'],
  [/VALVE|VLV|\bVA?\b/i, 'gate'],
];

/** The pid valve type a block name reads as, `guessed` when the name only
 *  says it is a valve; null when the name does not read as a valve. */
export function valveOf(block: string): { type: string; guessed: boolean } | null {
  for (const [re, type] of VALVE_NAMES) {
    if (re.test(block))
      return { type, guessed: re.source.startsWith('VALVE') || /PLUG|NEEDLE/.test(re.source) };
  }
  return null;
}

/** What a label reads as: an equipment tag with its pid type (one letter,
 *  or a known pair: E-101, P-2001A, TK-5), an instrument tag (any other two
 *  to four letters: PI-2001, FV-101, TT-1, LT-20), or neither. */
export function readTag(
  text: string,
): { tag: string; kind: 'equipment'; type: string } | { tag: string; kind: 'instrument' } | null {
  const t = text
    .trim()
    .toUpperCase()
    .replace(/\s*\/\s*/, '/');
  const m = TAG.exec(t);
  if (!m) return null;
  const letters = m[1]!;
  if (letters.length === 1) {
    const type = EQUIPMENT_LETTERS[letters];
    return type ? { tag: t, kind: 'equipment', type } : null;
  }
  const pair = EQUIPMENT_PAIRS[letters];
  if (pair) return { tag: t, kind: 'equipment', type: pair };
  return { tag: t, kind: 'instrument' };
}

function dist(ax: number, ay: number, bx: number, by: number) {
  return Math.hypot(ax - bx, ay - by);
}

function pointSegment(px: number, py: number, s: SegRow): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / len2)) : 0;
  return dist(px, py, s.x1 + dx * t, s.y1 + dy * t);
}

/** Line numbers named in a Circuits row: `NUM [handle]; ...; +N more`. */
export function parseLineNumbers(cell: unknown): { number: string; handle: string }[] {
  if (typeof cell !== 'string' || !cell.trim()) return [];
  const out: { number: string; handle: string }[] = [];
  for (const part of cell.split(';')) {
    const m = /^\s*(.+?)\s*\[([^\]]*)\]\s*$/.exec(part);
    if (m) out.push({ number: m[1]!, handle: m[2]! });
  }
  return out;
}

/* ------------------------------------------------------------------ walk */

class Union {
  private p = new Map<number, number>();
  find(a: number): number {
    let r = a;
    while (this.p.has(r) && this.p.get(r) !== r) r = this.p.get(r)!;
    this.p.set(a, r);
    return r;
  }
  join(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(rb, ra);
  }
}

type Edge = {
  a: number;
  b: number;
  seg?: SegRow;
  role: 'main' | 'deadleg';
  bridge?: InsertRow;
  join?: TraceJoin;
};

type Pt = { x: number; y: number };
type SheetWalk = {
  sheet: TraceSheet;
  byNode: Map<number, NodeRow>;
  /** Per chain id: the unit direction leaving its `from` node into the
   *  chain, and leaving its `to` node into it (the trunk choice reads the
   *  turn at each tee from these). */
  dirs: Map<string, { from: Pt; to: Pt }>;
};

const MAX_CHAIN_HANDLES = 60;
/** A gap in one straight line: it runs on along both pieces within this
 *  many degrees. */
const DASH_DEG = 3;
/** Handles kept per join (the path's own segments). */
const MAX_JOIN_HANDLES = 40;

/** A line-number block's number: the longest value among its line-number
 *  attributes (LINE `N100` and LINENO `N100-39-6"`: the full tag). */
export function lineNumberOf(attribs: Record<string, string>): string | undefined {
  let best: string | undefined;
  for (const [k, v] of Object.entries(attribs)) {
    const t = v?.trim();
    if (!t || !LINE_TAG.test(k)) continue;
    if (!best || t.length > best.length) best = t;
  }
  return best;
}

/** A stroke at least 15 degrees off both axes (a bowtie's side, an arrow's). */
function diagonal(g: SegRow): boolean {
  const ax = Math.abs(g.x2 - g.x1);
  const ay = Math.abs(g.y2 - g.y1);
  return Math.min(ax, ay) > Math.tan((15 * Math.PI) / 180) * Math.max(ax, ay);
}

const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

/** The pipe layers of a sheet: the layers its circuit overlays lie on (a
 *  circuit segment and a segment of that layer between the same two nodes),
 *  each carrying at least a tenth of what the busiest one does. */
function pipeLayersOf(s: SheetInput): Set<string> {
  const net = s.network ?? [];
  const circuitPairs = new Set<string>(
    [...s.segments, ...net]
      .filter((g) => parseCircuitLayer(g.layer))
      .map((g) => pairKey(g.n1, g.n2)),
  );
  const overlays = new Map<string, number>();
  for (const g of net) {
    if (!parseCircuitLayer(g.layer) && circuitPairs.has(pairKey(g.n1, g.n2)))
      overlays.set(g.layer, (overlays.get(g.layer) ?? 0) + 1);
  }
  const most = Math.max(0, ...overlays.values());
  return new Set([...overlays].filter(([, n]) => n >= most / 10).map(([l]) => l));
}

/** The trimmed extent diagonal a sheet's `near` was taken from. */
const extentOf = (s: SheetInput) => s.near / NEAR_REL;

/** Small binary heap on [cost, node]. */
class Heap {
  private h: [number, number][] = [];
  get size() {
    return this.h.length;
  }
  push(v: [number, number]) {
    const h = this.h;
    h.push(v);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p]![0] <= h[i]![0]) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const h = this.h;
    const top = h[0];
    const last = h.pop();
    if (h.length && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l]![0] < h[m]![0]) m = l;
        if (r < h.length && h[r]![0] < h[m]![0]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Join the pieces of one circuit on one sheet where its layer breaks. The
 * `Circuit <name>` layer is an overlay drawn in pieces over the process
 * lines: between two pieces the pipe goes on, on the process layers, past a
 * valve drawn as lines, a flow arrow or a stretch nobody overlaid.
 *
 * 1. Gaps: two ends of one layer that face each other along the same
 *    straight line, closer than `near` and than twice the longer piece, are
 *    one line (a dashed line, a break where another line crosses, a valve
 *    drawn in the gap: a diagonal stroke of the network in the gap says a
 *    symbol sits there).
 * 2. Process lines: from every end, the shortest path over the PIPE layers
 *    (the layers circuits on this sheet are drawn over: one that carries at
 *    least a tenth of those overlays) to a piece not yet joined to it, at
 *    most BRIDGE_REL of the sheet long. Never through an equipment outline
 *    or a symbol layer, so two runs that meet only at a vessel stay apart.
 *    The path never runs on another circuit's layer, a segment another circuit
 *    is drawn over, a node another circuit touches, the segment a
 *    line-number block naming another circuit sits on, or a straight piece
 *    longer than the cap (a sheet border, a match line); and never through
 *    another piece of this circuit. Shortest first, each pair of pieces
 *    joined once.
 *
 * The joins are pushed onto `edges` and returned. A piece no path reaches
 * stays apart.
 */
function joinPieces(circuit: string, s: SheetInput, edges: Edge[], guesses: string[]): TraceJoin[] {
  const out: TraceJoin[] = [];
  const near = s.near;
  if (!(near > 0)) return out;
  const cap = extentOf(s) * BRIDGE_REL;
  const at = new Map<number, Edge[]>();
  for (const e of edges) {
    at.set(e.a, [...(at.get(e.a) ?? []), e]);
    at.set(e.b, [...(at.get(e.b) ?? []), e]);
  }
  const own = new Set(at.keys());
  const uf = new Union();
  for (const e of edges) uf.join(e.a, e.b);
  const roleAt = (n: number): 'main' | 'deadleg' =>
    (at.get(n) ?? []).some((e) => e.role === 'main') ? 'main' : 'deadleg';
  const add = (j: TraceJoin, role: 'main' | 'deadleg') => {
    edges.push({ a: j.from, b: j.to, role, join: j });
    at.set(j.from, [...(at.get(j.from) ?? []), edges[edges.length - 1]!]);
    at.set(j.to, [...(at.get(j.to) ?? []), edges[edges.length - 1]!]);
    uf.join(j.from, j.to);
    out.push(j);
  };
  const endsNow = () =>
    [...own].filter((n) => (at.get(n) ?? []).length === 1 && at.get(n)![0]!.seg);

  // 1. Dash gaps.
  {
    type End = { n: number; x: number; y: number; dx: number; dy: number; len: number; g: SegRow };
    const ends: End[] = endsNow().map((n) => {
      const g = at.get(n)![0]!.seg!;
      const fwd = g.n1 === n;
      const x = fwd ? g.x1 : g.x2;
      const y = fwd ? g.y1 : g.y2;
      // Pointing out of the dash, past this end.
      const d = unit(fwd ? g.x1 - g.x2 : g.x2 - g.x1, fwd ? g.y1 - g.y2 : g.y2 - g.y1);
      return { n, x, y, dx: d.x, dy: d.y, len: g.length, g };
    });
    const pairs: { a: End; b: End; gap: number }[] = [];
    const cos = Math.cos((DASH_DEG * Math.PI) / 180);
    for (let i = 0; i < ends.length; i++) {
      for (let k = i + 1; k < ends.length; k++) {
        const a = ends[i]!;
        const b = ends[k]!;
        if (a.g.layer !== b.g.layer) continue;
        const gap = dist(a.x, a.y, b.x, b.y);
        if (!(gap > 0) || gap > near || gap > 2 * Math.max(a.len, b.len)) continue;
        const u = unit(b.x - a.x, b.y - a.y);
        if (a.dx * u.x + a.dy * u.y < cos || -(b.dx * u.x + b.dy * u.y) < cos) continue;
        pairs.push({ a, b, gap });
      }
    }
    pairs.sort((p, q) => p.gap - q.gap);
    const usedEnd = new Set<number>();
    for (const { a, b, gap } of pairs) {
      if (usedEnd.has(a.n) || usedEnd.has(b.n) || uf.find(a.n) === uf.find(b.n)) continue;
      usedEnd.add(a.n);
      usedEnd.add(b.n);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const strokes = (s.network ?? []).filter(
        (g) =>
          !parseCircuitLayer(g.layer) &&
          diagonal(g) &&
          dist((g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2, mx, my) <= gap / 2,
      );
      add(
        {
          kind: 'gap',
          from: a.n,
          to: b.n,
          length: round(gap),
          handles: strokes.map((g) => g.handle).slice(0, MAX_JOIN_HANDLES),
          layers: [a.g.layer],
          ...(strokes.length >= 2 ? { symbol: true } : {}),
        },
        roleAt(a.n) === 'deadleg' && roleAt(b.n) === 'deadleg' ? 'deadleg' : 'main',
      );
    }
  }

  // 2. Through the process lines.
  const net = s.network ?? [];
  if (!net.length) return out;
  const otherNodes = new Set<number>();
  const otherPairs = new Set<string>();
  const straight = new Map<string, number>();
  const pipeLayers = pipeLayersOf(s);
  for (const g of net) {
    const p = parseCircuitLayer(g.layer);
    if (p && !same(p.circuit, circuit)) {
      otherNodes.add(g.n1);
      otherNodes.add(g.n2);
      otherPairs.add(pairKey(g.n1, g.n2));
    }
    const k = `${g.handle}#${g.part ?? 0}`;
    straight.set(k, (straight.get(k) ?? 0) + g.length);
  }
  // The segment a line-number block of another circuit sits on.
  const foreign = new Set<number>();
  const isThis = (v: string) => same(v, circuit) || same(v.replace(/^circuit\s+/i, ''), circuit);
  const insertAt = new Map(s.inserts.map((i) => [i.handle, i]));
  for (const b of s.blocks) {
    if (!lineNumberOf(b.attribs)) continue;
    const named = Object.entries(b.attribs)
      .filter(([k, v]) => CIRCUIT_TAG.test(k) && v.trim())
      .map(([, v]) => v);
    if (!named.length || named.some(isThis)) continue;
    const ins = insertAt.get(b.handle);
    const x = ins && Number.isFinite(ins.x) ? ins.x : b.x;
    const y = ins && Number.isFinite(ins.y) ? ins.y : b.y;
    let best = -1;
    let bestD = Infinity;
    net.forEach((g, i) => {
      if (parseCircuitLayer(g.layer)) return;
      const d = pointSegment(x, y, g);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0 && bestD <= near) foreign.add(best);
  }
  const adj = new Map<number, number[]>();
  net.forEach((g, i) => {
    if (!Number.isFinite(g.n1) || !Number.isFinite(g.n2) || g.n1 === g.n2) return;
    if (parseCircuitLayer(g.layer) || !pipeLayers.has(g.layer)) return;
    if (otherPairs.has(pairKey(g.n1, g.n2)) || foreign.has(i)) return;
    if ((straight.get(`${g.handle}#${g.part ?? 0}`) ?? 0) > cap) return;
    adj.set(g.n1, [...(adj.get(g.n1) ?? []), i]);
    adj.set(g.n2, [...(adj.get(g.n2) ?? []), i]);
  });
  type Cand = { from: number; to: number; cost: number; path: number[] };
  const cands: Cand[] = [];
  for (const start of endsNow()) {
    if (otherNodes.has(start)) continue;
    const root = uf.find(start);
    const cost = new Map<number, number>([[start, 0]]);
    const via = new Map<number, number>();
    const heap = new Heap();
    heap.push([0, start]);
    while (heap.size) {
      const [c, n] = heap.pop()!;
      if (c > (cost.get(n) ?? Infinity)) continue;
      if (n !== start && own.has(n)) {
        if (uf.find(n) !== root) {
          const path: number[] = [];
          for (let m = n; m !== start;) {
            const i = via.get(m)!;
            path.unshift(i);
            m = net[i]!.n1 === m ? net[i]!.n2 : net[i]!.n1;
          }
          cands.push({ from: start, to: n, cost: c, path });
        }
        if (uf.find(n) !== root) break;
        continue;
      }
      for (const i of adj.get(n) ?? []) {
        const g = net[i]!;
        const m = g.n1 === n ? g.n2 : g.n1;
        if (otherNodes.has(m)) continue;
        // Never back along this piece (its own overlay's process line).
        if (own.has(m) && uf.find(m) === root) continue;
        const nc = c + g.length;
        if (nc > cap || nc >= (cost.get(m) ?? Infinity)) continue;
        cost.set(m, nc);
        via.set(m, i);
        heap.push([nc, m]);
      }
    }
  }
  cands.sort((a, b) => a.cost - b.cost);
  for (const c of cands) {
    if (uf.find(c.from) === uf.find(c.to)) continue;
    const segs = c.path.map((i) => net[i]!);
    // A diagonal stroke on the way: the path crosses a symbol drawn as
    // plain lines (a valve's bowtie, most often).
    const symbol = segs.some(diagonal);
    add(
      {
        kind: 'process',
        from: c.from,
        to: c.to,
        length: round(c.cost),
        handles: [...new Set(segs.map((g) => g.handle))].slice(0, MAX_JOIN_HANDLES),
        layers: [...new Set(segs.map((g) => g.layer))],
        ...(symbol ? { symbol: true } : {}),
      },
      roleAt(c.from) === 'deadleg' || roleAt(c.to) === 'deadleg' ? 'deadleg' : 'main',
    );
  }
  if (out.some((j) => j.symbol)) {
    guesses.push(
      `${s.title}: ${out.filter((j) => j.symbol).length} join${out.filter((j) => j.symbol).length === 1 ? '' : 's'} between pieces of the circuit cross a symbol drawn as plain lines (diagonal strokes, most often a valve's bowtie); each is drawn as a gate valve, and which valve it is is a guess.`,
    );
  }
  return out;
}

function unit(dx: number, dy: number): Pt {
  const l = Math.hypot(dx, dy);
  return l > 0 && Number.isFinite(l) ? { x: dx / l, y: dy / l } : { x: 0, y: 0 };
}

function walkSheet(circuit: string, s: SheetInput, guesses: string[], limits: string[]): SheetWalk {
  const allLayers = [...new Set([...s.circuitLayers, ...s.segments.map((g) => g.layer)])];
  const own = layersOf(circuit, allLayers);
  const roleOf = new Map<string, 'main' | 'deadleg'>();
  for (const l of own.main) roleOf.set(l, 'main');
  for (const l of own.deadleg) roleOf.set(l, 'deadleg');
  for (const l of [...own.main, ...own.deadleg]) {
    if (parseCircuitLayer(l)?.guessed) {
      guesses.push(
        `${s.title}: layer ${l} is read as a deadleg of ${circuit} from its -Dnn suffix; that suffix is a guess, check it.`,
      );
    }
  }
  const byNode = new Map(s.nodes.map((n) => [n.id, n]));
  const insertByHandle = new Map(s.inserts.map((i) => [i.handle, i]));

  // Edges: the circuit's pieces, a duplicate once (the same two nodes and
  // the same length: a copied LINE has its own handle), then the bridges
  // through a small block (two own ends inside one valve's box).
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const g of s.segments) {
    const role = roleOf.get(g.layer);
    if (!role) continue;
    const key = `${Math.min(g.n1, g.n2)}:${Math.max(g.n1, g.n2)}:${round(g.length)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ a: g.n1, b: g.n2, seg: g, role });
  }
  const ownNodes = new Set(edges.flatMap((e) => [e.a, e.b]));
  // Where a node is when its Nodes row was not read: a segment's own end.
  const segPoint = new Map<number, Pt>();
  for (const e of edges) {
    if (!e.seg) continue;
    if (!segPoint.has(e.seg.n1)) segPoint.set(e.seg.n1, { x: e.seg.x1, y: e.seg.y1 });
    if (!segPoint.has(e.seg.n2)) segPoint.set(e.seg.n2, { x: e.seg.x2, y: e.seg.y2 });
  }
  const pointOf = (n: number): Pt | null => {
    const node = byNode.get(n);
    if (node && Number.isFinite(node.x) && Number.isFinite(node.y)) return { x: node.x, y: node.y };
    return segPoint.get(n) ?? null;
  };
  const bridgeGroups = new Map<string, number[]>();
  for (const id of ownNodes) {
    const n = byNode.get(id);
    if (n?.kind === 'block' && n.blockHandle) {
      bridgeGroups.set(n.blockHandle, [...(bridgeGroups.get(n.blockHandle) ?? []), id]);
    }
  }
  for (const [handle, group] of bridgeGroups) {
    if (group.length < 2) continue;
    const ins = insertByHandle.get(handle) ?? {
      block: byNode.get(group[0]!)?.block ?? '',
      layer: '',
      handle,
      x: byNode.get(group[0]!)?.x ?? NaN,
      y: byNode.get(group[0]!)?.y ?? NaN,
      minX: null,
      minY: null,
      maxX: null,
      maxY: null,
    };
    for (const other of group.slice(1)) {
      const role = edges.some(
        (e) => !e.bridge && (e.a === other || e.b === other) && e.role === 'main',
      )
        ? 'main'
        : 'deadleg';
      edges.push({ a: group[0]!, b: other, role, bridge: ins });
    }
  }

  const joins = joinPieces(circuit, s, edges, guesses);

  const adj = new Map<number, number[]>();
  edges.forEach((e, i) => {
    adj.set(e.a, [...(adj.get(e.a) ?? []), i]);
    adj.set(e.b, [...(adj.get(e.b) ?? []), i]);
  });
  const degree = (n: number) => adj.get(n)?.length ?? 0;
  /** The unit direction leaving node `n` along edge `e`. */
  const leave = (e: Edge, n: number): Pt => {
    if (e.seg) {
      const fwd = e.seg.n1 === n;
      return fwd
        ? unit(e.seg.x2 - e.seg.x1, e.seg.y2 - e.seg.y1)
        : unit(e.seg.x1 - e.seg.x2, e.seg.y1 - e.seg.y2);
    }
    const a = pointOf(n);
    const b = pointOf(e.a === n ? e.b : e.a);
    return a && b ? unit(b.x - a.x, b.y - a.y) : { x: 0, y: 0 };
  };

  // Valves drawn over a continuous pipe (no break, no bridge): a valve-like
  // insert whose insertion point sits on a piece.
  const onPipe = new Map<number, TraceValve[]>();
  const tight = Math.max(s.near * 0.2, 1e-9);
  for (const ins of s.inserts) {
    if (bridgeGroups.has(ins.handle)) continue;
    const v = valveOf(ins.block);
    if (!v) continue;
    let best = -1;
    let bestD = Infinity;
    edges.forEach((e, i) => {
      if (!e.seg) return;
      const d = pointSegment(ins.x, ins.y, e.seg);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0 && bestD <= tight) {
      onPipe.set(best, [
        ...(onPipe.get(best) ?? []),
        { block: ins.block, handle: ins.handle, ...v },
      ]);
    }
  }

  // Attribute blocks at their WCS point: the Blocks tab's X/Y is the
  // insert's OCS point, the Inserts row of the same handle its WCS point.
  const blocks = s.blocks.map((b) => {
    const ins = insertByHandle.get(b.handle);
    return ins && Number.isFinite(ins.x) && Number.isFinite(ins.y)
      ? { ...b, x: ins.x, y: ins.y }
      : b;
  });

  // Line numbers: this circuit's own Circuits row (an injection point's row
  // is its own circuit's), and the line-number blocks that name this
  // circuit or, naming none, sit near its pieces. A block whose CIRCUIT
  // attribute names another circuit is that circuit's, wherever it sits.
  const isThis = (v: string) => same(v, circuit) || same(v.replace(/^circuit\s+/i, ''), circuit);
  const numbers = new Map<string, { number: string; handle: string; x?: number; y?: number }>();
  for (const row of s.circuitRows) {
    if (row['Circuit'] !== undefined && !isThis(String(row['Circuit'] ?? ''))) continue;
    for (const ln of parseLineNumbers(row['Line numbers'])) numbers.set(ln.handle, ln);
  }
  const blockByHandle = new Map(blocks.map((b) => [b.handle, b]));
  for (const b of blocks) {
    const number = lineNumberOf(b.attribs);
    if (!number) continue;
    const named = Object.entries(b.attribs)
      .filter(([k, v]) => CIRCUIT_TAG.test(k) && v.trim())
      .map(([, v]) => v);
    const namesThis = named.some(isThis);
    if (named.length && !namesThis) {
      numbers.delete(b.handle);
      continue;
    }
    const close = edges.some((e) => e.seg && pointSegment(b.x, b.y, e.seg) <= s.near);
    if (namesThis || close) numbers.set(b.handle, { number, handle: b.handle });
  }
  for (const ln of numbers.values()) {
    const b = blockByHandle.get(ln.handle);
    if (b) Object.assign(ln, { x: b.x, y: b.y });
  }
  // On a chain only when it sits near a piece: a block named for the
  // circuit but drawn elsewhere stays on the sheet's list alone.
  const numbersAt = new Map<number, { number: string; handle: string }[]>();
  for (const ln of numbers.values()) {
    if (ln.x === undefined || ln.y === undefined) continue;
    let best = -1;
    let bestD = Infinity;
    edges.forEach((e, i) => {
      if (!e.seg) return;
      const d = pointSegment(ln.x!, ln.y!, e.seg);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0 && bestD <= s.near) {
      numbersAt.set(best, [
        ...(numbersAt.get(best) ?? []),
        { number: ln.number, handle: ln.handle },
      ]);
    }
  }

  // Runs.
  const uf = new Union();
  for (const e of edges) uf.join(e.a, e.b);
  const runRoots = [...new Set([...ownNodes].map((n) => uf.find(n)))].sort((a, b) => a - b);

  const isKey = (n: number) => degree(n) !== 2;
  const otherEnd = (e: Edge, n: number) => (e.a === n ? e.b : e.a);
  const circuitOfLayer = (layer: string) => parseCircuitLayer(layer)?.circuit ?? null;

  const ownSet = new Set([...own.main, ...own.deadleg]);
  const meetsOf = (n: number): EndMeets => {
    const node = byNode.get(n);
    if (!node) return { kind: 'unknown' };
    const others = node.layers.filter((l) => l && !ownSet.has(l));
    const otherCircuit = others.find((l) => circuitOfLayer(l));
    if (otherCircuit) {
      return { kind: 'circuit', circuit: circuitOfLayer(otherCircuit)!, layer: otherCircuit };
    }
    if (others.length && node.degree > 1) return { kind: 'layer', layer: others[0]! };
    if (node.blockHandle) return { kind: 'block', block: node.block, handle: node.blockHandle };
    return { kind: 'open' };
  };
  const labelsNear = (x: number, y: number) => {
    const labels: string[] = [];
    const equipment: string[] = [];
    const instruments: string[] = [];
    const take = (text: string) => {
      const tag = readTag(text);
      if (!tag) return;
      const list = tag.kind === 'equipment' ? equipment : instruments;
      if (!list.includes(tag.tag)) list.push(tag.tag);
    };
    for (const t of s.texts) {
      if (dist(t.x, t.y, x, y) > s.near) continue;
      if (CONTINUATION_TEXT.test(t.text) && !labels.includes(t.text)) labels.push(t.text);
      take(t.text);
    }
    for (const i of s.inserts) {
      if (dist(i.x, i.y, x, y) > s.near) continue;
      if (isContinuationBlock(i.block)) {
        const label = `block ${i.block} [${i.handle}]`;
        if (!labels.includes(label)) labels.push(label);
      }
    }
    for (const b of blocks) {
      if (dist(b.x, b.y, x, y) > s.near) continue;
      for (const v of Object.values(b.attribs)) {
        if (v && CONTINUATION_TEXT.test(v) && !labels.includes(v)) labels.push(v);
        if (v) take(v);
      }
    }
    return { labels, equipment, instruments };
  };

  // What an end sits on, from the network: an equipment outline (the
  // connected strokes of one non-pipe layer at the end, small enough to be
  // a symbol, whose box holds an equipment tag), or a long straight line
  // (a sheet border, a match line) with a continuation label along it.
  const net = s.network ?? [];
  const pipe = pipeLayersOf(s);
  const netAt = new Map<number, number[]>();
  const straightLen = new Map<string, number>();
  net.forEach((g, i) => {
    netAt.set(g.n1, [...(netAt.get(g.n1) ?? []), i]);
    netAt.set(g.n2, [...(netAt.get(g.n2) ?? []), i]);
    const k = `${g.handle}#${g.part ?? 0}`;
    straightLen.set(k, (straightLen.get(k) ?? 0) + g.length);
  });
  const edge = extentOf(s) * EDGE_REL;
  const tagPoints: { tag: string; x: number; y: number }[] = [];
  for (const t of s.texts) {
    const r = readTag(t.text);
    if (r?.kind === 'equipment') tagPoints.push({ tag: r.tag, x: t.x, y: t.y });
  }
  for (const b of blocks) {
    for (const v of Object.values(b.attribs)) {
      const r = v ? readTag(v) : null;
      if (r?.kind === 'equipment') tagPoints.push({ tag: r.tag, x: b.x, y: b.y });
    }
  }
  const contTexts = [
    ...s.texts.filter((t) => CONTINUATION_TEXT.test(t.text)),
    ...blocks.flatMap((b) =>
      Object.values(b.attribs)
        .filter((v) => v && CONTINUATION_TEXT.test(v))
        .map((v) => ({ text: v, layer: b.layer, x: b.x, y: b.y })),
    ),
  ];
  const endContext = (
    n: number,
    p: Pt,
  ): { outline?: { tag: string; layer: string }; edgeLabel?: string } => {
    const out: { outline?: { tag: string; layer: string }; edgeLabel?: string } = {};
    for (const i of netAt.get(n) ?? []) {
      const g = net[i]!;
      if (parseCircuitLayer(g.layer) || pipe.has(g.layer)) continue;
      const key = `${g.handle}#${g.part ?? 0}`;
      if ((straightLen.get(key) ?? 0) > edge) {
        // A border: the continuation label along it nearest the end.
        if (out.edgeLabel) continue;
        const line = net.filter((h) => `${h.handle}#${h.part ?? 0}` === key);
        let best: string | undefined;
        let bestD = Infinity;
        for (const t of contTexts) {
          if (!line.some((h) => pointSegment(t.x, t.y, h) <= s.near)) continue;
          const d = dist(t.x, t.y, p.x, p.y);
          if (d <= edge && d < bestD) {
            bestD = d;
            best = t.text;
          }
        }
        if (best) out.edgeLabel = best;
        continue;
      }
      if (out.outline) continue;
      // The outline: strokes of this layer connected to the end; a nozzle
      // drawn apart from its shell (a gap under `near`) is taken in once.
      const seen = new Set<number>([i]);
      const queue = [i];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let ok = true;
      const pad = s.near;
      const grow = () => {
        while (queue.length && ok) {
          const h = net[queue.pop()!]!;
          minX = Math.min(minX, h.x1, h.x2);
          maxX = Math.max(maxX, h.x1, h.x2);
          minY = Math.min(minY, h.y1, h.y2);
          maxY = Math.max(maxY, h.y1, h.y2);
          if (Math.hypot(maxX - minX, maxY - minY) > edge || seen.size > 400) ok = false;
          for (const m of [h.n1, h.n2]) {
            for (const j of netAt.get(m) ?? []) {
              if (seen.has(j) || net[j]!.layer !== g.layer) continue;
              seen.add(j);
              queue.push(j);
            }
          }
        }
      };
      const tagsIn = () =>
        tagPoints
          .filter(
            (t) => t.x >= minX - pad && t.x <= maxX + pad && t.y >= minY - pad && t.y <= maxY + pad,
          )
          .sort((a, b) => dist(a.x, a.y, p.x, p.y) - dist(b.x, b.y, p.x, p.y));
      grow();
      if (!ok) continue;
      let inside = tagsIn();
      if (!inside.length) {
        net.forEach((h, j) => {
          if (seen.has(j) || h.layer !== g.layer) return;
          const cx = Math.max(minX, Math.min(maxX, (h.x1 + h.x2) / 2));
          const cy = Math.max(minY, Math.min(maxY, (h.y1 + h.y2) / 2));
          if (pointSegment(cx, cy, h) <= 2 * pad) {
            seen.add(j);
            queue.push(j);
          }
        });
        grow();
        if (!ok) continue;
        inside = tagsIn();
      }
      if (inside.length) out.outline = { tag: inside[0]!.tag, layer: g.layer };
    }
    return out;
  };

  const runs: TraceRun[] = [];
  const blocksOnPath: TraceValve[] = [];
  const dirs = new Map<string, { from: Pt; to: Pt }>();
  let chainNo = 0;
  runRoots.forEach((root, ri) => {
    const runNodes = [...ownNodes].filter((n) => uf.find(n) === root).sort((a, b) => a - b);
    const runEdges = edges.map((_, i) => i).filter((i) => uf.find(edges[i]!.a) === root);
    const used = new Set<number>();
    const chains: TraceChain[] = [];
    const walkFrom = (start: number, first: number) => {
      const handles: string[] = [];
      const valves: TraceValve[] = [];
      const lns: { number: string; handle: string }[] = [];
      const joinsOn: TraceJoin[] = [];
      let length = 0;
      let deadleg = 0;
      let main = 0;
      let at = start;
      let ei: number | undefined = first;
      const out = leave(edges[first]!, start);
      let last: { e: Edge; at: number } = { e: edges[first]!, at: start };
      while (ei !== undefined && !used.has(ei)) {
        used.add(ei);
        const e = edges[ei]!;
        if (e.seg) {
          if (handles.length < MAX_CHAIN_HANDLES && !handles.includes(e.seg.handle))
            handles.push(e.seg.handle);
          length += e.seg.length;
          if (e.role === 'deadleg') deadleg += e.seg.length;
          else main += e.seg.length;
        }
        if (e.join) {
          length += e.join.length;
          joinsOn.push(e.join);
          for (const h of e.join.handles) {
            if (handles.length < MAX_CHAIN_HANDLES && !handles.includes(h)) handles.push(h);
          }
          if (e.join.symbol) {
            valves.push({
              block: '(drawn as lines)',
              handle: e.join.handles[0] ?? '',
              type: 'gate',
              guessed: true,
            });
          }
        }
        if (e.bridge) {
          const v = valveOf(e.bridge.block);
          valves.push({
            block: e.bridge.block,
            handle: e.bridge.handle,
            type: v?.type ?? 'gate',
            guessed: !v || v.guessed,
          });
        }
        valves.push(...(onPipe.get(ei) ?? []));
        lns.push(...(numbersAt.get(ei) ?? []));
        at = otherEnd(e, at);
        last = { e, at };
        if (isKey(at)) break;
        ei = adj.get(at)!.find((x) => !used.has(x));
      }
      chainNo += 1;
      const id = `C${chainNo}`;
      dirs.set(id, { from: out, to: leave(last.e, last.at) });
      chains.push({
        id,
        from: start,
        to: at,
        role: deadleg > main ? 'deadleg' : 'main',
        length: round(length),
        handles,
        valves,
        lineNumbers: lns,
        ...(joinsOn.length ? { joins: joinsOn } : {}),
      });
    };
    for (const n of runNodes.filter(isKey)) {
      for (const ei of adj.get(n) ?? []) if (!used.has(ei)) walkFrom(n, ei);
    }
    // A closed loop has no key node: walk it from its lowest node.
    for (const ei of runEdges) if (!used.has(ei)) walkFrom(edges[ei]!.a, ei);

    const ends: TraceEnd[] = runNodes
      .filter((n) => degree(n) === 1)
      .map((n) => {
        const at = pointOf(n);
        const meets = meetsOf(n);
        const chain = chains.find((c) => c.from === n || c.to === n);
        if (!byNode.has(n)) {
          limits.push(
            `${s.title}: end #${n} is not in the Nodes rows read (a capped tab); what it meets is unknown${at ? ', its place is its segment’s end' : ''}.`,
          );
        }
        const near = at ? labelsNear(at.x, at.y) : { labels: [], equipment: [], instruments: [] };
        let equipmentBasis: string | undefined;
        if (at && meets.kind !== 'circuit') {
          const ctx = endContext(n, at);
          if (ctx.outline) {
            near.equipment = [ctx.outline.tag];
            equipmentBasis = `the end sits on an outline on layer ${ctx.outline.layer} that holds the tag ${ctx.outline.tag}`;
          } else if (near.equipment.length) {
            equipmentBasis = `the nearest equipment tag to the end, within ${round(s.near)} drawing units; no outline joins them`;
          } else if (meets.kind === 'open') {
            // An end that meets nothing drawn, short of a nozzle: the nearest
            // equipment tag a little further out, said as a reading.
            const far = tagPoints
              .map((t) => ({ t, d: dist(t.x, t.y, at.x, at.y) }))
              .filter((x) => x.d <= 3 * s.near)
              .sort((a, b) => a.d - b.d)[0];
            if (far) {
              near.equipment = [far.t.tag];
              equipmentBasis = `the nearest equipment tag, ${round(far.d)} drawing units from an end that meets nothing drawn; a reading, check it`;
            }
          }
          if (ctx.edgeLabel && !near.labels.includes(ctx.edgeLabel))
            near.labels.push(ctx.edgeLabel);
        }
        let beyond: string | undefined;
        if (meets.kind === 'block') {
          // The circuit's layers stop at a block (a valve): keep the valve on
          // the path and say the line beyond it is not traced.
          const v = valveOf(meets.block);
          if (v && chain) {
            const valve = { block: meets.block, handle: meets.handle, ...v };
            if (chain.from === n) chain.valves.unshift(valve);
            else chain.valves.push(valve);
          }
          beyond = `the circuit's layers stop at block ${meets.block || '(unnamed)'} [${meets.handle}]${v ? ` (read as a ${v.type} valve)` : ''}; what lies beyond it is not on them and is not traced`;
          limits.push(`${s.title}: end #${n}: ${beyond}.`);
        }
        return {
          node: n,
          x: at?.x ?? NaN,
          y: at?.y ?? NaN,
          meets,
          deadleg: chain?.role === 'deadleg',
          equipment: near.equipment,
          ...(equipmentBasis && near.equipment.length ? { equipmentBasis } : {}),
          instruments: near.instruments,
          labels: near.labels,
          ...(beyond ? { beyond } : {}),
        };
      });
    for (const c of chains) blocksOnPath.push(...c.valves);
    const tees = runNodes.filter((n) => degree(n) >= 3);
    runs.push({
      run: ri + 1,
      length: round(chains.reduce((a, c) => a + c.length, 0)),
      chains,
      tees,
      ends,
      deadleg: chains.every((c) => c.role === 'deadleg'),
    });
  });

  // Deadleg runs: connected sets of deadleg pieces.
  const dl = new Union();
  const dlNodes = new Set<number>();
  for (const e of edges) {
    if (e.role !== 'deadleg' || !(e.seg || e.join)) continue;
    dl.join(e.a, e.b);
    dlNodes.add(e.a);
    dlNodes.add(e.b);
  }
  const deadlegRuns = new Set([...dlNodes].map((n) => dl.find(n))).size;
  for (const v of blocksOnPath) {
    // A symbol drawn as lines is said once per sheet by joinPieces.
    if (v.guessed && v.block !== '(drawn as lines)') {
      guesses.push(
        `${s.title}: block ${v.block || '(unnamed)'} [${v.handle}] on the path is drawn as a ${v.type} valve; its name does not say which valve it is.`,
      );
    }
  }
  return {
    byNode,
    dirs,
    sheet: {
      tableId: s.tableId,
      title: s.title,
      sourceFileId: s.sourceFileId,
      ...(s.url ? { url: s.url } : {}),
      layers: [...own.main, ...own.deadleg],
      injectionPoints: [...new Set(own.injection.map((l) => parseCircuitLayer(l)?.circuit ?? l))],
      circuitRows: s.circuitRows,
      runs,
      deadlegRuns,
      lineNumbers: [...numbers.values()].map(({ number, handle }) => ({ number, handle })),
      blocksOnPath,
      joins,
    },
  };
}

function round(v: number) {
  return Math.round(v * 10) / 10;
}

/* ------------------------------------------------------------ sheet links */

const norm = (t: string) => t.toUpperCase().replace(/[\s"'`]+/g, '');

/** The words of a sheet's title another drawing would name it by: the whole
 *  title, the title without its revision (`10-20-30-rev-4` is named
 *  `10-20-30`), and every token with a digit in it, four characters or more. */
function sheetKeys(title: string): string[] {
  const keys = new Set<string>([norm(title)]);
  const bare = title.replace(/[\s_-]*rev(ision)?[\s_.-]*[A-Z0-9]{1,4}\s*$/i, '');
  if (bare !== title) keys.add(norm(bare));
  for (const tok of title.split(/[\s_]+/))
    if (/\d/.test(tok) && tok.length >= 4) keys.add(norm(tok));
  return [...keys].filter((k) => k.length >= 4);
}

type EndRef = { sheet: TraceSheet; end: TraceEnd; numbers: string[] };

/** The line numbers of the pipe at an end: its own chain's, else the
 *  nearest numbered main chain back along the run (fewest chains away; a
 *  line is labelled once, not at every tee). */
function numbersFrom(run: TraceRun, node: number): string[] {
  const seen = new Set<TraceChain>();
  let frontier = [node];
  const visited = new Set(frontier);
  while (frontier.length) {
    const found: string[] = [];
    const next: number[] = [];
    for (const n of frontier) {
      for (const c of run.chains) {
        if (seen.has(c) || (c.from !== n && c.to !== n)) continue;
        seen.add(c);
        if (c.role === 'deadleg') continue;
        found.push(...c.lineNumbers.map((l) => norm(l.number)));
        const o = c.from === n ? c.to : c.from;
        if (!visited.has(o)) {
          visited.add(o);
          next.push(o);
        }
      }
    }
    if (found.length) return [...new Set(found)];
    frontier = next;
  }
  return [];
}

function linkCandidates(sheet: TraceSheet): EndRef[] {
  const out: EndRef[] = [];
  for (const run of sheet.runs) {
    for (const end of run.ends) {
      if (end.deadleg) continue;
      // Another circuit's layer is a known end; a non-circuit line touching
      // the end (a leader, an arrow) does not stop it being a link, nor does
      // an instrument tag near it.
      if (end.meets.kind === 'circuit' || end.meets.kind === 'unknown') continue;
      if (end.equipment.length) continue;
      out.push({ sheet, end, numbers: numbersFrom(run, end.node) });
    }
  }
  return out;
}

export function linkSheets(sheets: TraceSheet[], limits: string[]): SheetLink[] {
  const links: SheetLink[] = [];
  const cands = new Map(sheets.map((s) => [s.tableId, linkCandidates(s)]));
  const linked = new Set<string>();
  const key = (r: EndRef) => `${r.sheet.tableId}#${r.end.node}`;
  const add = (
    a: EndRef,
    b: EndRef | null,
    basis: SheetLink['basis'],
    note: string,
    certain = false,
    target?: string,
  ) => {
    linked.add(key(a));
    if (b) linked.add(key(b));
    links.push({
      from: { sheet: a.sheet.title, node: a.end.node },
      to: b ? { sheet: b.sheet.title, node: b.end.node } : null,
      basis,
      // Certain ONLY when labels on both sheets name each other and exactly
      // one end there names this sheet back: every other link is a guess.
      guessed: !(certain && b !== null),
      ...(target && !b ? { target } : {}),
      note,
    });
  };
  // 1. A continuation label near an end that names another uploaded sheet:
  // the certain pairs first (so a guess never takes an end a certain link
  // needs), then the rest.
  for (const pass of ['certain', 'rest'] as const)
    for (const s of sheets) {
      for (const a of cands.get(s.tableId) ?? []) {
        if (linked.has(key(a)) || a.end.labels.length === 0) continue;
        const said = norm(a.end.labels.join(' '));
        const target = sheets.find(
          (o) => o.tableId !== s.tableId && sheetKeys(o.title).some((k) => said.includes(k)),
        );
        if (!target) {
          if (pass === 'certain') continue;
          limits.push(
            `${s.title}: end #${a.end.node} has a continuation label (${a.end.labels.join(' | ')}) that names no uploaded sheet this caller can read; the sheet it continues on may not be uploaded.`,
          );
          continue;
        }
        const there = (cands.get(target.tableId) ?? []).filter((b) => !linked.has(key(b)));
        const namesBack = (b: EndRef) =>
          sheetKeys(s.title).some((k) => norm(b.end.labels.join(' ')).includes(k));
        const sharesNumber = (b: EndRef) => b.numbers.some((n) => a.numbers.includes(n));
        // A label at the far end that names some third sheet.
        const namesOther = (b: EndRef) => b.end.labels.length > 0 && !namesBack(b);
        const byNumber = there.filter((b) => sharesNumber(b) && !namesOther(b));
        const both = byNumber.filter(namesBack);
        const backs = there.filter(namesBack);
        const only = there.length === 1 ? there[0]! : null;
        const b = both[0] ?? byNumber[0] ?? (backs.length === 1 ? backs[0] : undefined) ?? only;
        // Certain: the label names the other sheet AND the same line number
        // sits at exactly one end there, whose own label names no third sheet.
        const certain = !!b && byNumber.length === 1 && sharesNumber(b) && !namesOther(b);
        if (pass === 'certain' && !certain) continue;
        add(
          a,
          b ?? null,
          'label',
          !b
            ? `the label names ${target.title}, but no open end there could be matched`
            : certain
              ? `the label names ${target.title} and the same line number sits at the end there${namesBack(b) ? ', whose label names this sheet back' : ''}`
              : byNumber.length > 1
                ? `the label names ${target.title}; ${byNumber.length} ends there carry the same line number, the one matched is a guess`
                : sharesNumber(b)
                  ? `the label names ${target.title} and the line number matches, but the end there is labelled for another sheet; a guess`
                  : `the label names ${target.title}; the end there is a guess (${namesBack(b) ? 'its label names this sheet back, no line number confirms it' : 'its only open end'})`,
          certain,
          target.title,
        );
      }
    }
  // 2. The same line number at an open end on two sheets.
  for (const s of sheets) {
    for (const a of cands.get(s.tableId) ?? []) {
      if (linked.has(key(a)) || a.numbers.length === 0) continue;
      const b = sheets
        .filter((o) => o.tableId !== s.tableId)
        .flatMap((o) => cands.get(o.tableId) ?? [])
        .find((r) => !linked.has(key(r)) && r.numbers.some((n) => a.numbers.includes(n)));
      if (b)
        add(a, b, 'line-number', 'the same line number sits by both ends; no label confirms it');
    }
  }
  // 3. Two sheets, one open end each.
  const left = sheets
    .map((s) => (cands.get(s.tableId) ?? []).filter((r) => !linked.has(key(r))))
    .filter((l) => l.length > 0);
  if (sheets.length === 2 && left.length === 2 && left.every((l) => l.length === 1)) {
    add(
      left[0]![0]!,
      left[1]![0]!,
      'only-open-ends',
      'the only open end on each sheet; nothing else ties them',
    );
  }
  return links;
}

/* ------------------------------------------------------------------- pid */

/* -------------------------------------------------------------- register */

export function compareRegister(
  reg: RegisterInput,
  walks: SheetWalk[],
  limits: string[],
): Discrepancy[] {
  const out: Discrepancy[] = [];
  const onSheets = new Map<string, Set<string>>(); // number -> sheet titles
  const onDeadleg = new Set<string>();
  for (const { sheet } of walks) {
    for (const ln of sheet.lineNumbers) {
      const k = norm(ln.number);
      onSheets.set(k, new Set([...(onSheets.get(k) ?? []), sheet.title]));
    }
    for (const run of sheet.runs) {
      for (const c of run.chains) {
        if (c.role === 'deadleg') for (const ln of c.lineNumbers) onDeadleg.add(norm(ln.number));
      }
    }
  }
  const matchSheet = (name: string) =>
    walks.find(({ sheet }) => {
      const a = norm(name);
      if (a && norm(sheet.title) === a) return true;
      return sheetKeys(sheet.title).some((k) => (a.length >= 4 && k.includes(a)) || a.includes(k));
    });
  const regLines = reg.lines ?? [];
  const regNumbers = new Set(regLines.map((l) => norm(l.number)));
  const found = (n: string) =>
    [...onSheets.keys()].find((k) => k === n) ??
    [...onSheets.keys()].find(
      (k) => n.length >= 4 && k.length >= 4 && (k.includes(n) || n.includes(k)),
    );
  for (const [k, sheets] of onSheets) {
    if (regNumbers.has(k)) continue;
    if ([...regNumbers].some((n) => n.length >= 4 && (k.includes(n) || n.includes(k)))) continue;
    out.push({
      kind: 'line_not_in_register',
      detail: `line ${k} is on the circuit's layers (${[...sheets].join(', ')}) but not in the register`,
    });
  }
  for (const l of regLines) {
    const n = norm(l.number);
    const hit = found(n);
    if (!hit) {
      const sheetNote = l.sheet
        ? matchSheet(l.sheet)
          ? ` (its sheet ${l.sheet} is uploaded)`
          : ` (its sheet ${l.sheet} is not uploaded)`
        : '';
      out.push({
        kind: 'register_line_no_geometry',
        detail: `register line ${l.number} has no line-number label on the circuit's geometry${sheetNote}`,
      });
      continue;
    }
    if (l.sheet) {
      const want = matchSheet(l.sheet);
      if (want && !onSheets.get(hit)!.has(want.sheet.title)) {
        out.push({
          kind: 'register_line_other_sheet',
          detail: `register puts line ${l.number} on ${l.sheet}; the geometry has it on ${[...onSheets.get(hit)!].join(', ')}`,
        });
      }
    }
    if (l.deadleg !== undefined && l.deadleg !== onDeadleg.has(hit)) {
      out.push({
        kind: 'deadleg_flag',
        detail: `register says line ${l.number} is ${l.deadleg ? '' : 'not '}a deadleg; on the drawing it sits on ${onDeadleg.has(hit) ? 'a deadleg' : 'the main'} layer`,
      });
    }
  }
  const regSheets = new Set([...(reg.sheets ?? []), ...regLines.map((l) => l.sheet ?? '')]);
  for (const name of regSheets) {
    if (!name.trim()) continue;
    if (!matchSheet(name)) {
      out.push({
        kind: 'register_sheet_not_uploaded',
        detail: `register sheet ${name} has no uploaded drawing with this circuit that this caller can read`,
      });
      limits.push(`sheet ${name} is on the register but not among the traced drawings.`);
    }
  }
  const geometryDeadlegs = walks.reduce((a, w) => a + w.sheet.deadlegRuns, 0);
  const regDeadlegs =
    reg.deadlegs ??
    (regLines.some((l) => l.deadleg !== undefined)
      ? regLines.filter((l) => l.deadleg).length
      : undefined);
  if (regDeadlegs !== undefined && regDeadlegs !== geometryDeadlegs) {
    out.push({
      kind: 'deadleg_count',
      detail: `register has ${regDeadlegs} deadleg${regDeadlegs === 1 ? '' : 's'}; the drawings show ${geometryDeadlegs} deadleg run${geometryDeadlegs === 1 ? '' : 's'}`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ trace */

export function traceCircuit(
  circuit: string,
  inputs: SheetInput[],
  register?: RegisterInput,
): TraceResult {
  const guesses: string[] = [];
  const limits: string[] = inputs.flatMap((s) => s.limits.map((l) => `${s.title}: ${l}`));
  const walks = inputs
    .map((s) => walkSheet(circuit, s, guesses, limits))
    .filter((w) => w.sheet.runs.length);
  for (const s of inputs) {
    if (!walks.some((w) => w.sheet.tableId === s.tableId)) {
      limits.push(`${s.title}: the circuit is named here but no segment on its layers was read.`);
    }
  }
  const sheets = walks.map((w) => w.sheet);
  const links = linkSheets(sheets, limits);
  for (const l of links) {
    if (l.guessed) {
      guesses.push(
        `link ${l.from.sheet} #${l.from.node} to ${l.to ? `${l.to.sheet} #${l.to.node}` : '(no end)'} is a guess: ${l.note}.`,
      );
    }
  }
  const pid = buildPid(
    {
      circuit,
      sheets,
      links,
      register,
      dirs: new Map(
        walks.flatMap((w) =>
          [...w.dirs].map(([id, d]) => [`${w.sheet.tableId}:${id}`, d] as const),
        ),
      ),
      equipmentType: (tag) => {
        const read = readTag(tag);
        const type = read?.kind === 'equipment' ? read.type : 'vertical-vessel';
        const letter = /^([A-Z]+)/.exec(tag.toUpperCase())?.[1] ?? '';
        guesses.push(
          `${tag} is drawn as a ${type}: its tag letter ${letter} reads as ${EQUIPMENT_KIND[letter] ?? EQUIPMENT_PAIR_KIND[letter] ?? 'equipment'}; check its type.`,
        );
        return type;
      },
    },
    guesses,
    limits,
  );
  const discrepancies = register ? compareRegister(register, walks, limits) : undefined;
  const runs = sheets.reduce((a, s) => a + s.runs.length, 0);
  const tees = sheets.reduce((a, s) => a + s.runs.reduce((b, r) => b + r.tees.length, 0), 0);
  const deadlegs = sheets.reduce((a, s) => a + s.deadlegRuns, 0);
  const summary =
    sheets.length === 0
      ? `Circuit ${circuit}: no uploaded drawing this caller can read has geometry on its layers.`
      : `Circuit ${circuit} on ${sheets.length} sheet${sheets.length === 1 ? '' : 's'} (${sheets
          .map((s) => s.title)
          .join(
            ', ',
          )}): ${runs} run${runs === 1 ? '' : 's'}, ${tees} tee${tees === 1 ? '' : 's'}, ${deadlegs} deadleg run${deadlegs === 1 ? '' : 's'}, ${links.length} sheet link${links.length === 1 ? '' : 's'} (${links.filter((l) => l.guessed).length} guessed).` +
        (discrepancies
          ? ` Register: ${discrepancies.length} difference${discrepancies.length === 1 ? '' : 's'}.`
          : '') +
        (limits.length ? ` ${limits.length} limit${limits.length === 1 ? '' : 's'} noted.` : '');
  return {
    circuit,
    sheets,
    links,
    pid,
    ...(discrepancies
      ? { register: { source: register?.source?.trim() || 'register', discrepancies } }
      : {}),
    guesses,
    limits,
    summary,
  };
}
