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
  /** What the read could not see on this sheet (capped tabs, cut reads). */
  limits: string[];
};

export type RegisterLine = { number: string; sheet?: string; deadleg?: boolean };
export type RegisterInput = {
  source?: string;
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
  /** Instrument tags near the end (PI-2001, FV-101): never equipment. */
  instruments: string[];
  labels: string[];
  /** What the trace knows of what lies past this end, when it stops at a
   *  block (a valve): the circuit's layers end there. */
  beyond?: string;
};
export type TraceValve = { block: string; handle: string; type: string; guessed: boolean };
export type TraceChain = {
  id: string;
  from: number;
  to: number;
  role: 'main' | 'deadleg';
  length: number;
  handles: string[];
  valves: TraceValve[];
  lineNumbers: { number: string; handle: string }[];
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

const EQUIPMENT_LETTERS: Readonly<Record<string, string>> = {
  E: 'shell-tube-exchanger',
  P: 'centrifugal-pump',
  V: 'vertical-vessel',
  D: 'horizontal-drum',
  T: 'tank',
  C: 'column',
  K: 'compressor',
  F: 'filter',
  A: 'air-cooler',
};
/** Two-letter equipment prefixes (any other two to four letters before
 *  the number read as an instrument: PI, FV, TT, LT, PSV, FIC). */
const EQUIPMENT_PAIRS: Readonly<Record<string, string>> = { TK: 'tank', EA: 'air-cooler' };
/** A tag: one to four letters, then the number (E-101, P-2001A, PI-2001). */
const TAG = /^([A-Z]{1,4})-?(\d{2,6}[A-Z]?)$/;
const CONTINUATION_TEXT =
  /\b(CONT(INUED|INUATION|'?D)?\.?|SEE\s+(DWG|DRG|SHT|SHEET)|(TO|FROM)\s+(DWG|DRG|SHT|SHEET)|MATCH\s*LINE)\b/i;
/** A continuation block name. CONT is not CONTROL (a control valve), nor
 *  CONTAINER / CONTACT / CONTENT; a name that reads as a valve is never one. */
const CONTINUATION_BLOCK =
  /(CONT(?!ROL|AIN|ACT|ENT|OUR)|OPC|OFF.?PAGE|OFF.?SHEET|CONNECTOR|MATCH)/i;

/** Whether a block name reads as a continuation (off-page) symbol. */
export function isContinuationBlock(block: string): boolean {
  return CONTINUATION_BLOCK.test(block) && !valveOf(block);
}

const VALVE_NAMES: readonly [RegExp, string][] = [
  [/3.?WAY|THREE.?WAY/i, 'three-way'],
  [/BUTTERFLY|BFV/i, 'butterfly'],
  [/GLOBE/i, 'globe'],
  [/BALL/i, 'ball'],
  [/GATE/i, 'gate'],
  [/CHECK|CHK|NRV/i, 'check'],
  [/RELIEF|PSV|PRV|SRV/i, 'relief'],
  [/CONTROL|\bCV\b|CTRL/i, 'control'],
  [/REDUCER|\bRED\b|CONC|ECC/i, 'reducer'],
  [/BLIND|SPADE|SPECT|SPEC.?BL/i, 'blind'],
  [/ORIFICE|\bRO\b/i, 'orifice'],
  [/VALVE|VLV|\bVA?\b/i, 'gate'],
];

/** The pid valve type a block name reads as, `guessed` when the name only
 *  says it is a valve; null when the name does not read as a valve. */
export function valveOf(block: string): { type: string; guessed: boolean } | null {
  for (const [re, type] of VALVE_NAMES) {
    if (re.test(block)) return { type, guessed: re.source.startsWith('VALVE') };
  }
  return null;
}

/** What a label reads as: an equipment tag with its pid type (one letter,
 *  or a known pair: E-101, P-2001A, TK-5), an instrument tag (any other two
 *  to four letters: PI-2001, FV-101, TT-1, LT-20), or neither. */
export function readTag(
  text: string,
): { tag: string; kind: 'equipment'; type: string } | { tag: string; kind: 'instrument' } | null {
  const t = text.trim().toUpperCase();
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

type Edge = { a: number; b: number; seg?: SegRow; role: 'main' | 'deadleg'; bridge?: InsertRow };

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
    const number = Object.entries(b.attribs).find(([k, v]) => LINE_TAG.test(k) && v)?.[1];
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
    if (e.role !== 'deadleg' || !e.seg) continue;
    dl.join(e.a, e.b);
    dlNodes.add(e.a);
    dlNodes.add(e.b);
  }
  const deadlegRuns = new Set([...dlNodes].map((n) => dl.find(n))).size;
  for (const v of blocksOnPath) {
    if (v.guessed) {
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
    },
  };
}

function round(v: number) {
  return Math.round(v * 10) / 10;
}

/* ------------------------------------------------------------ sheet links */

const norm = (t: string) => t.toUpperCase().replace(/[\s"'`]+/g, '');

/** The words of a sheet's title another drawing would name it by: the whole
 *  title and every token with a digit in it, four characters or more. */
function sheetKeys(title: string): string[] {
  const keys = new Set<string>([norm(title)]);
  for (const tok of title.split(/[\s_]+/))
    if (/\d/.test(tok) && tok.length >= 4) keys.add(norm(tok));
  return [...keys].filter((k) => k.length >= 4);
}

type EndRef = { sheet: TraceSheet; end: TraceEnd; numbers: string[] };

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
      const chain = run.chains.find((c) => c.from === end.node || c.to === end.node);
      out.push({ sheet, end, numbers: (chain?.lineNumbers ?? []).map((l) => norm(l.number)) });
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
  // 1. A continuation label near an end that names another uploaded sheet.
  for (const s of sheets) {
    for (const a of cands.get(s.tableId) ?? []) {
      if (linked.has(key(a)) || a.end.labels.length === 0) continue;
      const said = norm(a.end.labels.join(' '));
      const target = sheets.find(
        (o) => o.tableId !== s.tableId && sheetKeys(o.title).some((k) => said.includes(k)),
      );
      if (!target) {
        limits.push(
          `${s.title}: end #${a.end.node} has a continuation label (${a.end.labels.join(' | ')}) that names no uploaded sheet this caller can read; the sheet it continues on may not be uploaded.`,
        );
        continue;
      }
      const there = (cands.get(target.tableId) ?? []).filter((b) => !linked.has(key(b)));
      const backs = there.filter((b) =>
        sheetKeys(s.title).some((k) => norm(b.end.labels.join(' ')).includes(k)),
      );
      const sharesNumber = (b: EndRef) => b.numbers.some((n) => a.numbers.includes(n));
      const back = backs.length === 1 ? backs[0]! : (backs.find(sharesNumber) ?? backs[0]);
      const byNumber = there.find(sharesNumber);
      const only = there.length === 1 ? there[0]! : null;
      const b = back ?? byNumber ?? only;
      add(
        a,
        b ?? null,
        'label',
        back
          ? backs.length === 1
            ? `labels on both sheets name each other`
            : `labels on both sheets name each other, but ${backs.length} ends there name this sheet; the one matched is a guess`
          : b
            ? `the label names ${target.title}; the end there is a guess (${byNumber ? 'same line number' : 'its only open end'})`
            : `the label names ${target.title}, but no open end there could be matched`,
        !!back && backs.length === 1,
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

const PID_MAX = { lines: 60, tees: 30, equipment: 30, offpage: 20, inline: 6, circuitId: 24 };
/** A turn under this many degrees at a tee is straight on. */
const STRAIGHT_DEG = 20;

function tagId(raw: string, fallback: string, max = 32): string {
  const t = raw
    .replace(/[^A-Za-z0-9_./-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, max);
  return t || fallback;
}

/** Degrees between arriving along `arrive` and leaving along `out`. */
function turnDeg(arrive: Pt, out: Pt): number {
  if ((!arrive.x && !arrive.y) || (!out.x && !out.y)) return 0;
  const dot = arrive.x * out.x + arrive.y * out.y;
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/**
 * The `pid` template input: every run of every sheet as lines, a run's
 * trunk as one line, every other chain as a branch on a tee that carries
 * its place along the parent (`at`, from the parent's `from`). The trunk
 * is the end-to-end path that goes straightest through its tees (a header
 * runs straight on; a branch turns off it), the longest of those; that is
 * a reading of the geometry and said in `guesses`. Ends become equipment
 * (an equipment tag near the end; an instrument tag never is), off-page
 * connectors (a sheet link, another circuit) or stops (open, deadleg).
 * The output always fits the template's own limits: whatever does not fit
 * is cut, and every cut is said in `limits`.
 */
export function buildPid(
  circuit: string,
  walks: SheetWalk[],
  links: SheetLink[],
  guesses: string[],
  limits: string[],
): Record<string, unknown> {
  const equipment = new Map<string, { id: string; type: string; service?: string }>();
  const eqByTag = new Map<string, string>();
  const offpage: { id: string; direction: 'in' | 'out'; sheet: string; text?: string }[] = [];
  const lines: Record<string, unknown>[] = [];
  const tees: { id: string; on: string; at?: number }[] = [];
  const taken = new Set<string>();
  const unique = (base: string) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 28)}-${n}`;
    taken.add(id);
    return id;
  };
  const usedNumbers = new Set<string>();
  const short = (title: string) => title.replace(/\s+/g, '').slice(0, 12) || '?';
  const cuts = new Set<string>();
  const room = () => offpage.length < PID_MAX.offpage;
  /** A connector's text, its (GUESS) mark kept inside the 40 characters. */
  const connectorText = (head: string, guessed: boolean) => {
    const mark = guessed ? ' (GUESS)' : '';
    return head.slice(0, 40 - mark.length) + mark;
  };

  walks.forEach(({ sheet, dirs }, si) => {
    const linkOf = (node: number) =>
      links.find(
        (l) =>
          (l.from.sheet === sheet.title && l.from.node === node) ||
          (l.to?.sheet === sheet.title && l.to.node === node),
      );
    /** What an end becomes: an equipment or connector id, or a stop. */
    const endpoint = (
      end: TraceEnd,
      side: 'from' | 'to',
    ): { id: string } | { stop: 'open' | 'deadleg' } => {
      if (end.equipment.length) {
        const tag = end.equipment[0]!;
        const known = eqByTag.get(tag);
        if (known) return { id: known };
        if (equipment.size < PID_MAX.equipment) {
          const id = tagId(tag, `EQ-${equipment.size + 1}`);
          const eid = taken.has(id) ? unique(id) : (taken.add(id), id);
          eqByTag.set(tag, eid);
          const read = readTag(tag);
          const type = read?.kind === 'equipment' ? read.type : 'vertical-vessel';
          equipment.set(eid, { id: eid, type });
          guesses.push(
            `${sheet.title}: ${tag} near end #${end.node} is drawn as a ${type} from its tag letter; check its type.`,
          );
          return { id: eid };
        }
        cuts.add(`equipment past ${PID_MAX.equipment}: an end drawn without its equipment`);
      }
      const link = linkOf(end.node);
      if (link) {
        const otherSheet =
          link.from.sheet === sheet.title && link.from.node === end.node
            ? (link.to?.sheet ?? link.target)
            : link.from.sheet;
        if (otherSheet) {
          if (room()) {
            const id = unique(`OPC-${offpage.length + 1}`);
            offpage.push({
              id,
              direction: side === 'from' ? 'in' : 'out',
              sheet: short(otherSheet),
              text: connectorText(`${side === 'from' ? 'FROM' : 'TO'} ${otherSheet}`, link.guessed),
            });
            return { id };
          }
          cuts.add(`connectors past ${PID_MAX.offpage}: a sheet link drawn as an open end`);
        }
      }
      if (end.meets.kind === 'circuit') {
        if (room()) {
          const id = unique(`OPC-${offpage.length + 1}`);
          offpage.push({
            id,
            direction: side === 'from' ? 'in' : 'out',
            sheet: short(sheet.title),
            text: `CIRCUIT ${end.meets.circuit}`.slice(0, 40),
          });
          return { id };
        }
        cuts.add(`connectors past ${PID_MAX.offpage}: another circuit's end drawn open`);
      }
      if (end.deadleg) return { stop: 'deadleg' };
      // Never a cap the drawing does not show: an end at a block keeps the
      // valve inline and is open past it (said in limits by the walk).
      return { stop: 'open' };
    };

    for (const run of sheet.runs) {
      const chainsAt = new Map<number, TraceChain[]>();
      for (const c of run.chains) {
        chainsAt.set(c.from, [...(chainsAt.get(c.from) ?? []), c]);
        if (c.to !== c.from) chainsAt.set(c.to, [...(chainsAt.get(c.to) ?? []), c]);
      }
      const endBy = new Map(run.ends.map((e) => [e.node, e]));
      const far = (c: TraceChain, n: number) => (c.from === n ? c.to : c.from);
      const dirAt = (c: TraceChain, n: number): Pt => {
        const d = dirs.get(c.id);
        if (!d) return { x: 0, y: 0 };
        return c.from === n ? d.from : d.to;
      };
      // The trunk: from each end, straight on at every key node; the path
      // that turns least, then the longest.
      const straightFrom = (e: number, allowDeadleg: boolean) => {
        const path: TraceChain[] = [];
        const seenNodes = new Set([e]);
        let at = e;
        let turns = 0;
        let length = 0;
        let arrive: Pt | null = null;
        for (;;) {
          const opts = (chainsAt.get(at) ?? []).filter(
            (c) =>
              !path.includes(c) &&
              (allowDeadleg || c.role !== 'deadleg') &&
              !seenNodes.has(far(c, at)),
          );
          if (!opts.length) break;
          let best = opts[0]!;
          let bestT = Infinity;
          for (const c of opts) {
            const t = arrive ? turnDeg(arrive, dirAt(c, at)) : 0;
            if (t < bestT - 1e-9 || (Math.abs(t - bestT) <= 1e-9 && c.length > best.length)) {
              best = c;
              bestT = t;
            }
          }
          if (arrive && bestT >= STRAIGHT_DEG) turns += bestT;
          path.push(best);
          length += best.length;
          const next = far(best, at);
          const back = dirAt(best, next);
          arrive = { x: -back.x, y: -back.y };
          at = next;
          seenNodes.add(at);
          if (endBy.has(at)) break;
        }
        return path.length && at !== e && endBy.has(at)
          ? { chains: path, start: e, end: at, turns, length }
          : null;
      };
      const pickTrunk = (allowDeadleg: boolean) => {
        let best: ReturnType<typeof straightFrom> = null;
        for (const e of run.ends) {
          const p = straightFrom(e.node, allowDeadleg);
          if (!p) continue;
          if (
            !best ||
            p.turns < best.turns - 1e-9 ||
            (Math.abs(p.turns - best.turns) <= 1e-9 && p.length > best.length)
          )
            best = p;
        }
        return best;
      };
      const trunk = pickTrunk(false) ?? pickTrunk(true);
      if (trunk && run.tees.length) {
        guesses.push(
          `${sheet.title} run ${run.run}: the main line is drawn along the end-to-end path that goes straightest through its tees; which pipe is the header is read from the geometry, check it.`,
        );
      }
      const used = new Set<TraceChain>();
      const nodeLine = new Map<number, string>();
      const along = new Map<string, { pos: Map<number, number>; total: number }>();
      const teeAt = new Map<number, string>();
      const teeOn = (node: number) => {
        const known = teeAt.get(node);
        if (known) return known;
        const line = nodeLine.get(node);
        if (!line) return null;
        if (tees.length >= PID_MAX.tees) {
          cuts.add(`tees past ${PID_MAX.tees}: branches left off`);
          return null;
        }
        const id = unique(`T-${tees.length + 1}`);
        const a = along.get(line);
        const pos = a?.pos.get(node);
        const at =
          a && a.total > 0 && pos !== undefined
            ? Math.round(Math.max(0, Math.min(1, pos / a.total)) * 100) / 100
            : undefined;
        tees.push({ id, on: line, ...(at !== undefined ? { at } : {}) });
        teeAt.set(node, id);
        return id;
      };
      const numberOf = (cs: TraceChain[]) => {
        for (const c of cs) {
          for (const ln of c.lineNumbers) {
            const n = ln.number.slice(0, 40);
            if (!usedNumbers.has(norm(n))) {
              usedNumbers.add(norm(n));
              return n;
            }
          }
        }
        return undefined;
      };
      const emit = (
        cs: TraceChain[],
        start: number,
        stop: number,
        fromTee: string | null,
        branch: boolean,
      ) => {
        if (lines.length >= PID_MAX.lines) {
          cuts.add(`lines past ${PID_MAX.lines}`);
          return null;
        }
        let from: string | undefined = fromTee ?? undefined;
        let to: string | undefined;
        let endKind: 'open' | undefined;
        let deadleg = cs.every((c) => c.role === 'deadleg');
        if (!from) {
          const startEnd = endBy.get(start);
          const ep = startEnd ? endpoint(startEnd, 'from') : null;
          if (ep && 'id' in ep) from = ep.id;
          else if (room()) {
            from = unique(`END-${si + 1}-${start}`);
            offpage.push({
              id: from,
              direction: 'in',
              sheet: short(sheet.title),
              text: 'OPEN END',
            });
            limits.push(
              `${sheet.title}: end #${start} meets nothing drawn; the pid input starts it at a connector marked OPEN END.`,
            );
          } else {
            cuts.add(`connectors past ${PID_MAX.offpage}: runs that start at an open end left off`);
            return null;
          }
        }
        const id = unique(`S${si + 1}-R${run.run}-L${lines.length + 1}`);
        const stopEnd = endBy.get(stop);
        if (stopEnd) {
          const ep = endpoint(stopEnd, 'to');
          if ('id' in ep) to = ep.id;
          else if (ep.stop === 'deadleg') deadleg = true;
          else endKind = ep.stop;
        } else {
          const t = teeOn(stop);
          if (t) to = t;
          else endKind = 'open';
        }
        if (to && to === from) {
          // A loop back onto the tee it left: the template draws no line
          // from a point to itself.
          to = undefined;
          endKind = 'open';
          limits.push(
            `${sheet.title}: a loop that leaves and rejoins one point is drawn open at its far end in the pid input.`,
          );
        }
        const valves = cs.flatMap((c) => c.valves);
        if (valves.length > PID_MAX.inline) cuts.add(`valves past ${PID_MAX.inline} on one line`);
        const inline = valves.slice(0, PID_MAX.inline).map((v) => ({ type: v.type }));
        const number = numberOf(cs);
        lines.push({
          id,
          ...(number ? { number } : {}),
          from,
          ...(to ? { to } : {}),
          ...(!to && endKind ? { end: endKind } : {}),
          ...(deadleg ? { deadleg: true } : {}),
          ...(branch ? { weight: 'secondary' } : {}),
          ...(inline.length ? { inline } : {}),
        });
        const pos = new Map<number, number>([[start, 0]]);
        let cum = 0;
        let at = start;
        for (const c of cs) {
          used.add(c);
          if (!nodeLine.has(c.from)) nodeLine.set(c.from, id);
          if (!nodeLine.has(c.to)) nodeLine.set(c.to, id);
          cum += c.length;
          at = far(c, at);
          if (!pos.has(at)) pos.set(at, cum);
        }
        along.set(id, { pos, total: cum });
        return id;
      };
      // A branch from `node` along `first`, extended through key nodes
      // straight on where it can; the rest hang off it as branches in turn.
      const grow = (node: number, first: TraceChain): TraceChain[] => {
        const path = [first];
        let at = far(first, node);
        const seenNodes = new Set([node, at]);
        let back = dirAt(first, at);
        for (;;) {
          if (endBy.has(at)) break;
          const arrive = { x: -back.x, y: -back.y };
          const next = (chainsAt.get(at) ?? [])
            .filter((c) => !used.has(c) && !path.includes(c) && !seenNodes.has(far(c, at)))
            .map((c) => ({ c, t: turnDeg(arrive, dirAt(c, at)) }))
            .sort((a, b) => a.t - b.t || b.c.length - a.c.length)[0]?.c;
          if (!next) break;
          path.push(next);
          const n2 = far(next, at);
          back = dirAt(next, n2);
          at = n2;
          seenNodes.add(at);
        }
        return path;
      };
      const pathNodes = (start: number, cs: TraceChain[]) => {
        const out = [start];
        let at = start;
        for (const c of cs) {
          at = far(c, at);
          out.push(at);
        }
        return out;
      };
      const branchOff = (nodes: number[]) => {
        for (const n of nodes) {
          for (const c of chainsAt.get(n) ?? []) {
            if (used.has(c)) continue;
            const tee = teeOn(n);
            if (!tee) continue;
            const cs = grow(n, c);
            const ns = pathNodes(n, cs);
            if (emit(cs, n, ns[ns.length - 1]!, tee, true)) branchOff(ns.slice(1));
          }
        }
      };
      if (trunk && trunk.chains.length) {
        // Start the trunk where an equipment or a connector is, if one end has one.
        const s0 = endBy.get(trunk.start);
        const s1 = endBy.get(trunk.end);
        const anchored = (e?: TraceEnd) =>
          !!e && (e.equipment.length > 0 || e.meets.kind === 'circuit' || !!linkOf(e.node));
        const flip = !anchored(s0) && anchored(s1);
        const cs = flip ? [...trunk.chains].reverse() : trunk.chains;
        const start = flip ? trunk.end : trunk.start;
        const stop = flip ? trunk.start : trunk.end;
        if (emit(cs, start, stop, null, false)) branchOff(pathNodes(start, cs));
      }
      // Whatever a closed loop left: draw it from its first node.
      for (const c of run.chains) {
        if (used.has(c)) continue;
        if (nodeLine.has(c.from)) branchOff([c.from]);
        else if (emit([c], c.from, c.to, null, false)) branchOff([c.to]);
      }
    }
  });
  if (cuts.size)
    limits.push(
      `the pid input is cut at the template limits (${[...cuts].join('; ')}); the trace JSON has every chain.`,
    );
  // A tee no line starts or ends at is noise for the template.
  const usedTees = new Set(lines.flatMap((l) => [l.from, l.to]).filter(Boolean) as string[]);
  return {
    template: 'pid',
    title: `Circuit ${circuit}`.slice(0, 80),
    description:
      `Circuit ${circuit} traced from ${walks.length} uploaded drawing${walks.length === 1 ? '' : 's'}: every run, tee, deadleg and valve on its layers.`.slice(
        0,
        300,
      ),
    equipment: [...equipment.values()],
    offpage,
    lines,
    tees: tees.filter((t) => usedTees.has(t.id)),
    circuits: [
      {
        id: tagId(`CIRCUIT-${circuit}`, 'CIRCUIT', PID_MAX.circuitId),
        label: circuit.slice(0, 40),
        lines: lines.map((l) => l.id as string),
        equipment: [...equipment.keys()],
      },
    ],
  };
}

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
  const pid = buildPid(circuit, walks, links, guesses, limits);
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
