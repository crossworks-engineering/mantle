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

import { buildPid, clip, type ChainRole, type PidChecks } from './pid';
import type { StoredCheck } from './check';

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
  /** The drawing's revision (the sha256 of the bytes its table was built
   *  from, cut short; null for a table imported before that stamp), and
   *  the image check's answers stored in the table's Checks tab (check.ts). */
  revision?: string | null;
  /** The full stamped sha256 the revision is cut from. */
  sourceSha?: string | null;
  /** Whether the drawing file still holds the bytes the table was built
   *  from (read.ts sourceStateOf): `stale` once it was replaced in place. */
  source?: SourceState;
  checks?: StoredCheck[];
};

export type SourceState = 'current' | 'stale' | 'unstamped' | 'unreadable';

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
  /** Equipment the end is drawn at: an outline it sits on holds the tag, or
   *  the tag is the nearest label within the near distance. */
  equipment: string[];
  /** How the equipment (or the unconfirmed tag) was found. */
  equipmentBasis?: string;
  /** The nearest equipment tag past the near distance from an end that
   *  meets nothing drawn (or one on an outline too wide to be one piece): a
   *  reading, never drawn as that equipment. A main-line end only when the
   *  register's from or to names it, or as a NEAR connector marked GUESS
   *  when it carries the main line across more sheets (two at least) than
   *  confirmed equipment does (pid.ts). */
  equipmentUnconfirmed?: string;
  /** How `equipmentUnconfirmed` was read: `far`, the nearest equipment tag
   *  `distance` drawing units from an end that meets nothing drawn (past
   *  the sheet's `near` distance); `outline`, the end sits on an outline too
   *  wide to be one piece that holds `count` distinct tags, `tags` the
   *  first of them nearest first, the nearest `distance` off. Never taken
   *  at an end that carries a continuation label. */
  reading?:
    | { kind: 'far'; distance: number; near: number }
    | { kind: 'outline'; distance: number; near: number; tags: string[]; count: number };
  /** Instrument tags near the end (PI-2001, FV-101): never equipment. */
  instruments: string[];
  labels: string[];
  /** What the trace knows of what lies past this end, when it stops at a
   *  block (a valve): the circuit's layers end there. */
  beyond?: string;
};
export type TraceValve = { block: string; handle: string; type: string; guessed: boolean };
/** Two pieces of the circuit joined where its layer breaks: across a short
 *  gap in one straight line (`gap`: a dash, a break where another line
 *  crosses, a valve drawn in the gap), or through the process line it is
 *  drawn over (`process`, with the path's handles). A process join is an
 *  INFERENCE (`inferred`, said in `guesses` and marked GUESS on the
 *  drawing): nothing on the circuit's layers says the stretch is the
 *  circuit's. A join never changes a piece's role: a deadleg piece stays a
 *  deadleg chain. */
export type TraceJoin = {
  kind: 'process' | 'gap';
  /** Set on every process join: inferred, not drawn on the circuit's layers. */
  inferred?: true;
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
 *  match line (never an equipment outline). */
export const EDGE_REL = 0.4;
/** An equipment outline's box diagonal is at most this share of the extent
 *  (16%): a title block (about 18% of an A1 sheet's diagonal, more on a
 *  smaller sheet) or a stack of equipment drawn joined on one layer (22-24%
 *  on the sheets measured, where single pieces of equipment were at most
 *  14%) is wider, and is not one piece of equipment. */
export const OUTLINE_REL = 0.16;
/** The tags of a too-wide outline a reading names (the count says the rest). */
const MAX_OUTLINE_TAGS = 5;
/** An elongated outline wider than OUTLINE_REL is still one piece of
 *  equipment (a tall exchanger stack, a column, a long horizontal drum)
 *  when it holds exactly ONE distinct equipment tag, its long side is at
 *  least this many times its short side, and its box is no larger than the
 *  square at the OUTLINE_REL cap (OUTLINE_LONG_AREA of the extent squared).
 *  Measured: an exchanger stack 5% wide and 22% tall of its sheet, one tag
 *  inside. A title block is joined to the sheet border (so wider than
 *  EDGE_REL) and holds no equipment tag; a stack of several pieces holds
 *  several tags: neither passes. */
export const OUTLINE_LONG_ASPECT = 3;
export const OUTLINE_LONG_AREA = OUTLINE_REL ** 2 / 2;
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

/** Adds `v` to the list at `k`, in place (a copy per add is quadratic on a
 *  node many lines meet). */
function append<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
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

type TagPoint = { tag: string; x: number; y: number };

/** Whether point `p` lies inside the polygon `poly` (even-odd rule). */
function inPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };
const boxOf = (pts: Pt[]): Box => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

/** The distinct equipment tags among `tags` (E-101 and E-101/R1 are one). */
const distinctTags = (tags: readonly TagPoint[]): string[] => [
  ...new Set(tags.map((t) => t.tag.toUpperCase().replace(/\s*\/.*$/, ''))),
];

/**
 * Whether a box is the size of one piece of equipment on a sheet whose
 * trimmed extent diagonal is `extent`: its diagonal at most OUTLINE_REL of
 * it; or, past that, an elongated box (OUTLINE_LONG_ASPECT, at most
 * OUTLINE_LONG_AREA, under EDGE_REL across) that holds exactly one distinct
 * equipment tag (`tags`, the count inside it).
 */
export function equipmentSized(
  box: Box,
  extent: number,
  tags: number,
): 'small' | 'elongated' | false {
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const diag = Math.hypot(w, h);
  if (!(extent > 0) || !Number.isFinite(diag)) return false;
  if (diag <= extent * OUTLINE_REL) return 'small';
  if (
    tags === 1 &&
    diag <= extent * EDGE_REL &&
    Math.max(w, h) >= OUTLINE_LONG_ASPECT * Math.min(w, h) &&
    w * h <= OUTLINE_LONG_AREA * extent * extent
  )
    return 'elongated';
  return false;
}

/** Pipe-layer segments looked at around one equipment tag for an outline
 *  drawn as plain lines (each costs one bounded search). */
const MAX_OUTLINE_SEGS = 200;

/**
 * Equipment and symbol outlines drawn ON the pipe layers (a vessel drawn on
 * the PROCESS layer): the process-line joins must never run along them, and
 * an end on one sits at that equipment. A segment a circuit layer is drawn
 * over (the same two nodes) is pipe, never an outline, so a pipe loop round
 * a tag (a bypass) is not one. Three shapes count, whatever the layer, each
 * at most the size of one piece of equipment (`equipmentSized`: under
 * OUTLINE_REL of the sheet, or elongated and holding exactly one tag):
 *
 * 1. A closed polyline: one handle whose pieces close a ring (every node
 *    meets exactly two of them). A ring larger than that (a skid or area
 *    boundary) is not an outline.
 * 2. A closed loop of pipe-layer pieces around an equipment tag (a vessel
 *    drawn as LINEs): for each tag, the pieces within OUTLINE_REL of the
 *    sheet of it, each tried for the shortest way round back to itself; a
 *    loop that holds the tag and whose box is under OUTLINE_REL is one.
 * 3. The box of an insert that holds exactly one distinct equipment tag (an
 *    equipment block), at most OUTLINE_REL of the sheet: a piece whose
 *    middle is inside it.
 *
 * An outline takes a tag only when exactly one distinct equipment tag is
 * inside it: one holding several is a cluster, never read as any one of
 * them. Returns the network indexes of those pieces, their nodes, and per
 * piece the equipment tag inside its outline when there is one.
 */
function outlinesOf(
  s: SheetInput,
  pipe: Set<string>,
  tags: readonly TagPoint[],
): { segs: Set<number>; nodes: Set<number>; tagAt: Map<number, string> } {
  const net = s.network ?? [];
  const extent = extentOf(s);
  const cap = extent * OUTLINE_REL;
  const segs = new Set<number>();
  const tagAt = new Map<number, string>();
  const point = new Map<number, Pt>();
  const onPipe: number[] = [];
  // The node pairs a circuit layer is drawn over: those pieces are pipe.
  const overlaid = new Set<string>(
    [...s.segments, ...net]
      .filter((g) => parseCircuitLayer(g.layer))
      .map((g) => pairKey(g.n1, g.n2)),
  );
  net.forEach((g, i) => {
    if (!pipe.has(g.layer) || parseCircuitLayer(g.layer) || g.n1 === g.n2) return;
    if (![g.n1, g.n2, g.x1, g.y1, g.x2, g.y2].every(Number.isFinite)) return;
    if (overlaid.has(pairKey(g.n1, g.n2))) return;
    onPipe.push(i);
    if (!point.has(g.n1)) point.set(g.n1, { x: g.x1, y: g.y1 });
    if (!point.has(g.n2)) point.set(g.n2, { x: g.x2, y: g.y2 });
  });
  /** Mark a ring of pieces as an outline when it is equipment sized; its tag
   *  only when exactly one distinct tag is inside. */
  const mark = (idx: number[], poly: Pt[]) => {
    const inside = poly.length >= 3 ? tags.filter((t) => inPolygon(t, poly)) : [];
    const distinct = distinctTags(inside);
    if (!equipmentSized(boxOf(poly), extent, distinct.length)) return;
    const tag = distinct.length === 1 ? inside[0]! : undefined;
    for (const i of idx) {
      segs.add(i);
      if (tag && !tagAt.has(i)) tagAt.set(i, tag.tag);
    }
  };
  // 1. Closed polylines.
  const byHandle = new Map<string, number[]>();
  for (const i of onPipe) {
    const h = net[i]!.handle;
    if (h) append(byHandle, h, i);
  }
  for (const idx of byHandle.values()) {
    if (idx.length < 3) continue;
    const count = new Map<number, number>();
    for (const i of idx) {
      for (const n of [net[i]!.n1, net[i]!.n2]) count.set(n, (count.get(n) ?? 0) + 1);
    }
    if (![...count.values()].every((c) => c === 2)) continue;
    // Walk the ring for its polygon.
    const poly: Pt[] = [];
    const left = new Set(idx);
    let at = net[idx[0]!]!.n1;
    while (left.size) {
      const next = [...left].find((i) => net[i]!.n1 === at || net[i]!.n2 === at);
      if (next === undefined) break;
      left.delete(next);
      poly.push(point.get(at)!);
      at = net[next]!.n1 === at ? net[next]!.n2 : net[next]!.n1;
    }
    if (left.size === 0) mark(idx, poly);
  }
  // 2. Loops of plain lines around an equipment tag.
  for (const t of tags) {
    const local = onPipe
      .filter((i) => {
        if (segs.has(i)) return false;
        const g = net[i]!;
        return dist(g.x1, g.y1, t.x, t.y) <= cap && dist(g.x2, g.y2, t.x, t.y) <= cap;
      })
      .sort((a, b) => {
        const ga = net[a]!;
        const gb = net[b]!;
        return (
          dist((ga.x1 + ga.x2) / 2, (ga.y1 + ga.y2) / 2, t.x, t.y) -
          dist((gb.x1 + gb.x2) / 2, (gb.y1 + gb.y2) / 2, t.x, t.y)
        );
      })
      .slice(0, MAX_OUTLINE_SEGS);
    if (local.length < 3) continue;
    const at = new Map<number, number[]>();
    for (const i of local) {
      for (const n of [net[i]!.n1, net[i]!.n2]) append(at, n, i);
    }
    for (const first of local) {
      if (segs.has(first)) continue;
      const g0 = net[first]!;
      // The shortest way from one end of the piece to the other, not along it.
      const cost = new Map<number, number>([[g0.n1, 0]]);
      const via = new Map<number, number>();
      const heap = new Heap();
      heap.push([0, g0.n1]);
      let found = false;
      while (heap.size) {
        const [c, n] = heap.pop()!;
        if (c > (cost.get(n) ?? Infinity)) continue;
        if (n === g0.n2) {
          found = true;
          break;
        }
        for (const i of at.get(n) ?? []) {
          if (i === first) continue;
          const g = net[i]!;
          const m = g.n1 === n ? g.n2 : g.n1;
          const nc = c + g.length;
          if (nc > 4 * cap || nc >= (cost.get(m) ?? Infinity)) continue;
          cost.set(m, nc);
          via.set(m, i);
          heap.push([nc, m]);
        }
      }
      if (!found) continue;
      const loop = [first];
      const poly: Pt[] = [point.get(g0.n2)!];
      for (let m = g0.n2; m !== g0.n1;) {
        const i = via.get(m)!;
        loop.push(i);
        m = net[i]!.n1 === m ? net[i]!.n2 : net[i]!.n1;
        poly.push(point.get(m)!);
      }
      if (equipmentSized(boxOf(poly), extent, 0) !== 'small' || !inPolygon(t, poly)) continue;
      mark(loop, poly);
    }
  }
  // 3. Equipment blocks.
  for (const ins of s.inserts) {
    if (ins.minX === null || ins.minY === null || ins.maxX === null || ins.maxY === null) continue;
    if (valveOf(ins.block) || isContinuationBlock(ins.block)) continue;
    const box = { minX: ins.minX, minY: ins.minY, maxX: ins.maxX, maxY: ins.maxY };
    if (Math.hypot(box.maxX - box.minX, box.maxY - box.minY) > cap) continue;
    const holds = (p: Pt) => p.x > box.minX && p.x < box.maxX && p.y > box.minY && p.y < box.maxY;
    const inside = tags.filter((t) => holds(t));
    if (distinctTags(inside).length !== 1) continue;
    const tag = inside[0]!;
    for (const i of onPipe) {
      const g = net[i]!;
      if (!holds({ x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 })) continue;
      segs.add(i);
      if (!tagAt.has(i)) tagAt.set(i, tag.tag);
    }
  }
  const nodes = new Set<number>();
  for (const i of segs) {
    nodes.add(net[i]!.n1);
    nodes.add(net[i]!.n2);
  }
  return { segs, nodes, tagAt };
}

/** Two line numbers name the same line: equal, or one holds the other
 *  (`N100` in `N100-39-6"`), four characters or more. */
function sameNumber(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)));
}

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
 *    or a symbol layer, so two runs that meet only at a vessel stay apart:
 *    never along or through a node of an outline on a pipe layer either
 *    (`outlinesOf`: a closed polyline, a loop round an equipment tag, an
 *    equipment block's box). The path never runs on another circuit's
 *    layer, a segment another circuit is drawn over, a node another circuit
 *    touches, the segment a line-number block naming another circuit sits
 *    on, the segment a line-number block of another line number sits on
 *    (one this circuit does not carry, CIRCUIT attribute or not), or a
 *    straight piece longer than the cap (a sheet border, a match line); and
 *    never through another piece of this circuit. Shortest first, each pair
 *    of pieces joined once. Every such join is an inference: said in
 *    `guesses` with its handles and length, and `inferred` on the join.
 *
 * A join takes the deadleg role when either piece it joins is a deadleg
 * (the chains split where the role changes, so it never turns a deadleg
 * piece into main line). The joins are pushed onto `edges` and returned. A
 * piece no path reaches stays apart.
 */
function joinPieces(
  circuit: string,
  s: SheetInput,
  edges: Edge[],
  guesses: string[],
  ctx: {
    outlines: { segs: Set<number>; nodes: Set<number> };
    blocks: BlockRow[];
    ownNumbers: string[];
  },
): TraceJoin[] {
  const out: TraceJoin[] = [];
  const near = s.near;
  if (!(near > 0)) return out;
  const cap = extentOf(s) * BRIDGE_REL;
  const at = new Map<number, Edge[]>();
  for (const e of edges) {
    append(at, e.a, e);
    append(at, e.b, e);
  }
  const own = new Set(at.keys());
  const uf = new Union();
  for (const e of edges) uf.join(e.a, e.b);
  const roleAt = (n: number): 'main' | 'deadleg' =>
    (at.get(n) ?? []).some((e) => e.role === 'main') ? 'main' : 'deadleg';
  const roleOf = (a: number, b: number): 'main' | 'deadleg' =>
    roleAt(a) === 'main' && roleAt(b) === 'main' ? 'main' : 'deadleg';
  const add = (j: TraceJoin, role: 'main' | 'deadleg') => {
    edges.push({ a: j.from, b: j.to, role, join: j });
    append(at, j.from, edges[edges.length - 1]!);
    append(at, j.to, edges[edges.length - 1]!);
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
    // Ends in cells twice `near` across: a pair (a gap of at most `near`)
    // is at most one cell apart. The pairs come in the order a loop over
    // every pair gives (i, then k); an end off the plane pairs with none.
    const cell = (v: number) => Math.floor(v / (2 * near));
    const grid = new Map<string, number[]>();
    ends.forEach((e, i) => append(grid, `${cell(e.x)},${cell(e.y)}`, i));
    for (let i = 0; i < ends.length; i++) {
      const cx = cell(ends[i]!.x);
      const cy = cell(ends[i]!.y);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      const ks = new Set<number>();
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (const k of grid.get(`${cx + ox},${cy + oy}`) ?? []) if (k > i) ks.add(k);
        }
      }
      for (const k of [...ks].sort((x, y) => x - y)) {
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
        roleOf(a.n, b.n),
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
  // The segment a line-number block of another circuit, or of a line
  // number this circuit does not carry, sits on.
  const foreign = new Set<number>();
  const isThis = (v: string) => same(v, circuit) || same(v.replace(/^circuit\s+/i, ''), circuit);
  for (const b of ctx.blocks) {
    const number = lineNumberOf(b.attribs);
    if (!number) continue;
    const named = Object.entries(b.attribs)
      .filter(([k, v]) => CIRCUIT_TAG.test(k) && v.trim())
      .map(([, v]) => v);
    if (named.some(isThis)) continue;
    if (!named.length && ctx.ownNumbers.some((n) => sameNumber(n, number))) continue;
    const { x, y } = b;
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
    if (otherPairs.has(pairKey(g.n1, g.n2)) || foreign.has(i) || ctx.outlines.segs.has(i)) return;
    if ((straight.get(`${g.handle}#${g.part ?? 0}`) ?? 0) > cap) return;
    append(adj, g.n1, i);
    append(adj, g.n2, i);
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
        // Never through an outline's node (a pipe meeting a vessel wall).
        if (ctx.outlines.nodes.has(m) && !own.has(m)) continue;
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
    const handles = [...new Set(segs.map((g) => g.handle))];
    const layers = [...new Set(segs.map((g) => g.layer))];
    add(
      {
        kind: 'process',
        inferred: true,
        from: c.from,
        to: c.to,
        length: round(c.cost),
        handles: handles.slice(0, MAX_JOIN_HANDLES),
        layers,
        ...(symbol ? { symbol: true } : {}),
      },
      roleOf(c.from, c.to),
    );
    guesses.push(
      `${s.title}: pieces #${c.from} and #${c.to} of the circuit are joined through ${segs.length} process-line segment${segs.length === 1 ? '' : 's'} on ${layers.join(', ')}, ${round(c.cost)} drawing units (handles ${handles.slice(0, 6).join(', ')}${handles.length > 6 ? ` and ${handles.length - 6} more` : ''}): an inferred join, not drawn on the circuit's layers; marked GUESS on the drawing, check it.`,
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
      append(bridgeGroups, n.blockHandle, id);
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
    // A bridge between a main piece and a deadleg piece is the deadleg's:
    // the chains split there, so neither piece changes role.
    const mainAt = (n: number) =>
      edges.some((e) => !e.bridge && (e.a === n || e.b === n) && e.role === 'main');
    for (const other of group.slice(1)) {
      const role = mainAt(group[0]!) && mainAt(other) ? 'main' : 'deadleg';
      edges.push({ a: group[0]!, b: other, role, bridge: ins });
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
  const tagPoints: TagPoint[] = [];
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
  const pipe = pipeLayersOf(s);
  const outlines = outlinesOf(s, pipe, tagPoints);
  // The line numbers this circuit carries: its Circuits row, the blocks
  // that name it, and the unnamed ones on its own pieces.
  const isThis = (v: string) => same(v, circuit) || same(v.replace(/^circuit\s+/i, ''), circuit);
  const circuitNamed = (b: BlockRow) =>
    Object.entries(b.attribs)
      .filter(([k, v]) => CIRCUIT_TAG.test(k) && v.trim())
      .map(([, v]) => v);
  const ownNumbers: string[] = [];
  for (const row of s.circuitRows) {
    if (row['Circuit'] !== undefined && !isThis(String(row['Circuit'] ?? ''))) continue;
    for (const ln of parseLineNumbers(row['Line numbers'])) ownNumbers.push(ln.number);
  }
  for (const b of blocks) {
    const number = lineNumberOf(b.attribs);
    if (!number) continue;
    const named = circuitNamed(b);
    if (named.some(isThis)) ownNumbers.push(number);
    else if (!named.length && edges.some((e) => e.seg && pointSegment(b.x, b.y, e.seg) <= s.near))
      ownNumbers.push(number);
  }

  const joins = joinPieces(circuit, s, edges, guesses, { outlines, blocks, ownNumbers });

  const adj = new Map<number, number[]>();
  edges.forEach((e, i) => {
    append(adj, e.a, i);
    append(adj, e.b, i);
  });
  const degree = (n: number) => adj.get(n)?.length ?? 0;
  /** Main and deadleg edges meet here: a chain ends, so neither changes role. */
  const mixed = (n: number) => {
    const rs = new Set((adj.get(n) ?? []).map((i) => edges[i]!.role));
    return rs.size > 1;
  };
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

  // Line numbers: this circuit's own Circuits row (an injection point's row
  // is its own circuit's), and the line-number blocks that name this
  // circuit or, naming none, sit near its pieces. A block whose CIRCUIT
  // attribute names another circuit is that circuit's, wherever it sits.
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

  const isKey = (n: number) => degree(n) !== 2 || mixed(n);
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
  const netAt = new Map<number, number[]>();
  const straightLen = new Map<string, number>();
  net.forEach((g, i) => {
    append(netAt, g.n1, i);
    append(netAt, g.n2, i);
    const k = `${g.handle}#${g.part ?? 0}`;
    straightLen.set(k, (straightLen.get(k) ?? 0) + g.length);
  });
  const edge = extentOf(s) * EDGE_REL;
  const contTexts = [
    ...s.texts.filter((t) => CONTINUATION_TEXT.test(t.text)),
    ...blocks.flatMap((b) =>
      Object.values(b.attribs)
        .filter((v) => v && CONTINUATION_TEXT.test(v))
        .map((v) => ({ text: v, layer: b.layer, x: b.x, y: b.y })),
    ),
  ];
  type EndContext = {
    /** The outline the end sits on: equipment sized (`elongated` when it
     *  passed as a tall or long single piece, its box as shares of the
     *  sheet). */
    outline?: { tag: string; layer: string; elongated?: { w: number; h: number } };
    /** An outline that holds the tag but is wider than one piece of
     *  equipment (up to EDGE_REL): maybe one large piece, maybe a stack of
     *  several. */
    wide?: { tag: string; layer: string; rel: number; d: number; tags: string[] };
    edgeLabel?: string;
  };
  const endContext = (n: number, p: Pt): EndContext => {
    const out: EndContext = {};
    for (const i of netAt.get(n) ?? []) {
      // An outline drawn on a pipe layer (outlinesOf) that holds a tag.
      const tag = outlines.tagAt.get(i);
      if (tag && !out.outline) out.outline = { tag, layer: net[i]!.layer };
    }
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
      if (!inside.length) continue;
      const box = { minX, minY, maxX, maxY };
      const fit = equipmentSized(box, extentOf(s), distinctTags(inside).length);
      if (fit === 'small') out.outline = { tag: inside[0]!.tag, layer: g.layer };
      else if (fit === 'elongated') {
        out.outline = {
          tag: inside[0]!.tag,
          layer: g.layer,
          elongated: { w: (maxX - minX) / extentOf(s), h: (maxY - minY) / extentOf(s) },
        };
      } else if (!out.wide) {
        const size = Math.hypot(maxX - minX, maxY - minY);
        out.wide = {
          tag: inside[0]!.tag,
          layer: g.layer,
          rel: size / extentOf(s),
          d: dist(inside[0]!.x, inside[0]!.y, p.x, p.y),
          tags: distinctTags(inside),
        };
      }
    }
    return out;
  };

  const runs: TraceRun[] = [];
  const blocksOnPath: TraceValve[] = [];
  const dirs = new Map<string, { from: Pt; to: Pt }>();
  let chainNo = 0;
  // Each run's nodes and edges, grouped in one pass (a pass per run is
  // quadratic on a sheet of many runs).
  const nodesOf = new Map<number, number[]>();
  for (const n of ownNodes) append(nodesOf, uf.find(n), n);
  const edgesOf = new Map<number, number[]>();
  edges.forEach((e, i) => append(edgesOf, uf.find(e.a), i));
  runRoots.forEach((root, ri) => {
    const runNodes = (nodesOf.get(root) ?? []).sort((a, b) => a - b);
    const runEdges = edgesOf.get(root) ?? [];
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
      /** A deadleg edge on the chain (a zero-length bridge has one too). */
      let deadlegEdge = false;
      let at = start;
      let ei: number | undefined = first;
      const out = leave(edges[first]!, start);
      let last: { e: Edge; at: number } = { e: edges[first]!, at: start };
      while (ei !== undefined && !used.has(ei)) {
        used.add(ei);
        const e = edges[ei]!;
        if (e.role === 'deadleg') deadlegEdge = true;
        if (e.seg) {
          if (handles.length < MAX_CHAIN_HANDLES && !handles.includes(e.seg.handle))
            handles.push(e.seg.handle);
          length += e.seg.length;
          if (e.role === 'deadleg') deadleg += e.seg.length;
          else main += e.seg.length;
        }
        if (e.join) {
          length += e.join.length;
          // A join's length counts to its role (a join-only chain between a
          // main end and a deadleg is the deadleg's).
          if (e.role === 'deadleg') deadleg += e.join.length;
          else main += e.join.length;
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
        role: deadleg > main || (deadleg === main && deadlegEdge) ? 'deadleg' : 'main',
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

    // Each node's first chain, in chain order (a scan of every chain at
    // every end is quadratic on a run with many deadlegs).
    const firstChainAt = new Map<number, TraceChain>();
    for (const c of chains) {
      if (!firstChainAt.has(c.from)) firstChainAt.set(c.from, c);
      if (!firstChainAt.has(c.to)) firstChainAt.set(c.to, c);
    }
    const ends: TraceEnd[] = runNodes
      .filter((n) => degree(n) === 1)
      .map((n) => {
        const at = pointOf(n);
        const meets = meetsOf(n);
        const chain = firstChainAt.get(n);
        if (!byNode.has(n)) {
          limits.push(
            `${s.title}: end #${n} is not in the Nodes rows read (a capped tab); what it meets is unknown${at ? ', its place is its segment’s end' : ''}.`,
          );
        }
        const near = at ? labelsNear(at.x, at.y) : { labels: [], equipment: [], instruments: [] };
        let equipmentBasis: string | undefined;
        let equipmentUnconfirmed: string | undefined;
        let reading: TraceEnd['reading'];
        if (at && meets.kind !== 'circuit') {
          const ctx = endContext(n, at);
          if (ctx.edgeLabel && !near.labels.includes(ctx.edgeLabel))
            near.labels.push(ctx.edgeLabel);
          // A continuation label is drawn fact naming where the line goes on:
          // no reading is taken at such an end, so a tag a few units off
          // never takes it out of the sheet links.
          const labelled = near.labels.length > 0;
          if (ctx.outline) {
            near.equipment = [ctx.outline.tag];
            const long = ctx.outline.elongated;
            equipmentBasis = long
              ? `the end sits on an elongated outline on layer ${ctx.outline.layer} (${Math.round(long.w * 100)}% by ${Math.round(long.h * 100)}% of the sheet) that holds one equipment tag, ${ctx.outline.tag}: one tall or long piece of equipment`
              : `the end sits on an outline on layer ${ctx.outline.layer} that holds the tag ${ctx.outline.tag}`;
          } else if (ctx.wide && !near.equipment.length && !labelled) {
            // Too wide to be sure it is one piece of equipment: a reading.
            const w = ctx.wide;
            const named = w.tags.slice(0, MAX_OUTLINE_TAGS).join(', ');
            const held =
              w.tags.length === 1
                ? `the tag ${w.tag}`
                : `${w.tags.length} equipment tags (${named}${w.tags.length > MAX_OUTLINE_TAGS ? ', ...' : ''}), ${w.tag} nearest the end`;
            equipmentUnconfirmed = w.tag;
            reading = {
              kind: 'outline',
              distance: round(w.d),
              near: round(s.near),
              tags: w.tags.slice(0, MAX_OUTLINE_TAGS),
              count: w.tags.length,
            };
            equipmentBasis = `the end sits on an outline on layer ${w.layer} that holds ${held}, but the outline spans ${Math.round(w.rel * 100)}% of the sheet (one piece of equipment is at most ${Math.round(OUTLINE_REL * 100)}%, or a tall or long outline holding exactly one tag): it may be several drawn joined; a reading, check it`;
            guesses.push(
              `${s.title}: end #${n} sits on an outline holding ${held} that spans ${Math.round(w.rel * 100)}% of the sheet, too wide to be sure it is one piece of equipment: drawn as an unconfirmed end marked GUESS. The register's from or to confirms it.`,
            );
          } else if (near.equipment.length) {
            equipmentBasis = `the nearest equipment tag to the end, within ${round(s.near)} drawing units; no outline joins them`;
          } else if (meets.kind === 'open' && !labelled) {
            // An end that meets nothing drawn, short of a nozzle: the nearest
            // equipment tag a little further out, said as a reading.
            const far = tagPoints
              .map((t) => ({ t, d: dist(t.x, t.y, at.x, at.y) }))
              .filter((x) => x.d <= 3 * s.near)
              .sort((a, b) => a.d - b.d)[0];
            if (far) {
              // A reading, never a fact: not drawn as the equipment.
              equipmentUnconfirmed = far.t.tag;
              reading = { kind: 'far', distance: round(far.d), near: round(s.near) };
              equipmentBasis = `the nearest equipment tag, ${round(far.d)} drawing units from an end that meets nothing drawn (past the ${round(s.near)} near distance); a reading, check it`;
              guesses.push(
                `${s.title}: end #${n} meets nothing drawn; the nearest equipment tag ${far.t.tag} is ${round(far.d)} drawing units off, past the near distance: drawn as an unconfirmed end marked GUESS, not as ${far.t.tag}. The register's from or to confirms it.`,
              );
            }
          }
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
          ...(equipmentBasis && (near.equipment.length || equipmentUnconfirmed)
            ? { equipmentBasis }
            : {}),
          ...(equipmentUnconfirmed ? { equipmentUnconfirmed, reading } : {}),
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

/** `numbers`: the line numbers of the pipe at the end, inherited along the
 *  run when its own chain has none (a guess's evidence); `own`: those on
 *  the end's own chain only, and none when that chain runs through an
 *  inferred join (a certain link's). */
type EndRef = {
  sheet: TraceSheet;
  end: TraceEnd;
  numbers: string[];
  own: string[];
  /** The end's own chain runs through an inferred join. */
  inferred: boolean;
};

/** A run's chains at each node, in the run's chain order (built once per
 *  run: a scan of every chain at every step is quadratic on a branchy
 *  run). */
function chainsAt(run: TraceRun): Map<number, TraceChain[]> {
  const at = new Map<number, TraceChain[]>();
  for (const c of run.chains) {
    append(at, c.from, c);
    if (c.to !== c.from) append(at, c.to, c);
  }
  return at;
}

/** The line numbers of the pipe at an end: its own chain's, else the
 *  nearest numbered main chain back along the run (fewest chains away; a
 *  line is labelled once, not at every tee). */
function numbersFrom(at: Map<number, TraceChain[]>, node: number): string[] {
  const seen = new Set<TraceChain>();
  let frontier = [node];
  const visited = new Set(frontier);
  while (frontier.length) {
    const found: string[] = [];
    const next: number[] = [];
    for (const n of frontier) {
      for (const c of at.get(n) ?? []) {
        if (seen.has(c)) continue;
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
    const at = chainsAt(run);
    for (const end of run.ends) {
      if (end.deadleg) continue;
      // Another circuit's layer is a known end; a non-circuit line touching
      // the end (a leader, an arrow) does not stop it being a link, nor does
      // an instrument tag near it.
      if (end.meets.kind === 'circuit' || end.meets.kind === 'unknown') continue;
      if (end.equipment.length || end.equipmentUnconfirmed) continue;
      const chain = at.get(end.node)?.[0];
      // A chain that runs through an inferred join supplies no own numbers:
      // a number past the join may sit on another pipe the join only guessed
      // is this one, and a certain link must rest on drawn fact alone.
      const inferred = (chain?.joins ?? []).some((j) => j.inferred);
      const own =
        chain && chain.role === 'main' && !inferred
          ? [...new Set(chain.lineNumbers.map((l) => norm(l.number)))]
          : [];
      out.push({
        sheet,
        end,
        numbers: numbersFrom(at, end.node),
        own,
        inferred,
      });
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
      // Certain ONLY when labels on both sheets name each other and both
      // ends' own chains carry the same line number, at exactly one end
      // there: every other link is a guess.
      guessed: !(certain && b !== null),
      ...(target && !b ? { target } : {}),
      note,
    });
  };
  /** What was checked at a sheet where a label found no end: its ends by
   *  why each is not a candidate, or the candidates none of which matched. */
  const unmatched = (t: TraceSheet, open: number, backs: number): string => {
    if (open > 1) {
      return `of ${open} open ends there, none shares a line number with this end without naming another sheet, and ${backs ? `${backs} name this sheet back, not one alone` : 'none names this sheet back'}`;
    }
    const why = new Map<string, number>();
    const tick = (k: string) => why.set(k, (why.get(k) ?? 0) + 1);
    for (const run of t.runs) {
      for (const end of run.ends) {
        if (end.deadleg) tick('on a deadleg');
        else if (end.meets.kind === 'circuit') tick("at another circuit's layer");
        else if (end.meets.kind === 'unknown') tick('not in the Nodes rows read');
        else if (end.equipment.length) tick('at equipment');
        else if (end.equipmentUnconfirmed) tick('only near an equipment tag (a reading)');
        else if (linked.has(`${t.tableId}#${end.node}`)) tick('already linked');
      }
    }
    const total = [...why.values()].reduce((a, c) => a + c, 0);
    if (!total) return 'the circuit there has no ends';
    return `of its ${total} end${total === 1 ? '' : 's'}, ${[...why].map(([k, c]) => `${c} ${k}`).join(', ')}`;
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
        // Certain: the label names the other sheet, the label there names
        // this sheet back, and the same line number sits on BOTH ends' own
        // chains (never one inherited from further along the run), at
        // exactly one end there; a chain through an inferred join has no own
        // numbers.
        const ownShare = (b: EndRef) => b.own.some((n) => a.own.includes(n));
        const strong = there.filter((b) => namesBack(b) && ownShare(b));
        const certain = strong.length === 1;
        const b = certain
          ? strong[0]!
          : (both[0] ?? byNumber[0] ?? (backs.length === 1 ? backs[0] : undefined) ?? only);
        if (pass === 'certain' && !certain) continue;
        add(
          a,
          b ?? null,
          'label',
          !b
            ? `the label names ${target.title}, but no end there is matched: ${unmatched(target, there.length, backs.length)}`
            : certain
              ? `the label names ${target.title}, the label there names this sheet back, and the same line number sits on both ends' own chains`
              : strong.length > 1
                ? `the label names ${target.title}; ${strong.length} ends there name this sheet back with the same line number, the one matched is a guess`
                : sharesNumber(b) && namesBack(b) && (a.inferred || b.inferred)
                  ? `the label names ${target.title} and the label there names this sheet back, but ${a.inferred && b.inferred ? "both ends' chains run" : `the chain at ${a.inferred ? 'this' : 'that'} end runs`} through an inferred join, so the line number on it is not drawn fact; a guess`
                  : sharesNumber(b) && namesBack(b)
                    ? `the label names ${target.title} and the label there names this sheet back, but the line number is not on both ends' own chains (read from further along the run); a guess`
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

/** Register differences listed (the rest are counted in limits), and the
 *  missing register sheets named one by one in limits. */
export const MAX_DISCREPANCIES = 100;
const MAX_REGISTER_ECHO = 10;

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
      detail: `line ${clip(k)} is on the circuit's layers (${[...sheets].map(clip).join(', ')}) but not in the register`,
    });
  }
  for (const l of regLines) {
    const n = norm(l.number);
    const hit = found(n);
    if (!hit) {
      const sheetNote = l.sheet
        ? matchSheet(l.sheet)
          ? ` (its sheet ${clip(l.sheet)} is uploaded)`
          : ` (its sheet ${clip(l.sheet)} is not uploaded)`
        : '';
      out.push({
        kind: 'register_line_no_geometry',
        detail: `register line ${clip(l.number)} has no line-number label on the circuit's geometry${sheetNote}`,
      });
      continue;
    }
    if (l.sheet) {
      const want = matchSheet(l.sheet);
      if (want && !onSheets.get(hit)!.has(want.sheet.title)) {
        out.push({
          kind: 'register_line_other_sheet',
          detail: `register puts line ${clip(l.number)} on ${clip(l.sheet)}; the geometry has it on ${[...onSheets.get(hit)!].map(clip).join(', ')}`,
        });
      }
    }
    if (l.deadleg !== undefined && l.deadleg !== onDeadleg.has(hit)) {
      out.push({
        kind: 'deadleg_flag',
        detail: `register says line ${clip(l.number)} is ${l.deadleg ? '' : 'not '}a deadleg; on the drawing it sits on ${onDeadleg.has(hit) ? 'a deadleg' : 'the main'} layer`,
      });
    }
  }
  const regSheets = new Set([...(reg.sheets ?? []), ...regLines.map((l) => l.sheet ?? '')]);
  /** Register sheets not traced, with where each sits in the differences. */
  const missing: { name: string; at: number }[] = [];
  for (const name of regSheets) {
    if (!name.trim()) continue;
    if (!matchSheet(name)) {
      out.push({
        kind: 'register_sheet_not_uploaded',
        detail: `register sheet ${clip(name)} has no uploaded drawing with this circuit that this caller can read`,
      });
      missing.push({ name, at: out.length - 1 });
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
  for (const { name } of missing.slice(0, MAX_REGISTER_ECHO))
    limits.push(`sheet ${clip(name)} is on the register but not among the traced drawings.`);
  if (missing.length > MAX_REGISTER_ECHO) {
    // The differences are capped: say how many of the rest they list.
    const rest = missing.slice(MAX_REGISTER_ECHO);
    const listed = rest.filter((m) => m.at < MAX_DISCREPANCIES).length;
    limits.push(
      `${rest.length} more register sheets are not among the traced drawings (${
        listed === rest.length
          ? "the register's differences list them"
          : listed === 0
            ? `not listed anywhere: the register's differences stop at ${MAX_DISCREPANCIES} before them`
            : `the register's differences list ${listed} of them, ${rest.length - listed} ${rest.length - listed === 1 ? 'is' : 'are'} not listed anywhere: the differences stop at ${MAX_DISCREPANCIES}`
      }).`,
    );
  }
  if (out.length > MAX_DISCREPANCIES) {
    limits.push(
      `the register differs in ${out.length} places; the first ${MAX_DISCREPANCIES} are listed, ${out.length - MAX_DISCREPANCIES} more are not.`,
    );
    return out.slice(0, MAX_DISCREPANCIES);
  }
  return out;
}

/* ------------------------------------------------------------------ trace */

export type TraceOptions = {
  /** The image check's answers for this trace's guesses, built from the
   *  walked sheets and links before the drawing is made (check.ts). */
  checks?: (sheets: TraceSheet[], links: SheetLink[]) => PidChecks | undefined;
  /** Filled with each chain's role on the drawing (pid.ts PidInput.roles). */
  roles?: Map<string, ChainRole>;
};

export function traceCircuit(
  circuit: string,
  inputs: SheetInput[],
  register?: RegisterInput,
  opts: TraceOptions = {},
): TraceResult {
  const guesses: string[] = [];
  const limits: string[] = inputs.flatMap((s) => s.limits.map((l) => `${s.title}: ${l}`));
  // Every sheet the circuit is on is listed, whatever can or cannot be
  // drawn from it (no equipment, no main line, no segment read).
  const walks = inputs
    .map((s) => walkSheet(circuit, s, guesses, limits))
    .filter(
      (w) =>
        w.sheet.runs.length > 0 ||
        w.sheet.layers.length > 0 ||
        w.sheet.circuitRows.some(
          (r) =>
            r['Circuit'] === undefined ||
            same(String(r['Circuit'] ?? ''), circuit) ||
            same(String(r['Parent'] ?? ''), circuit),
        ),
    );
  for (const w of walks) {
    if (!w.sheet.runs.length) {
      limits.push(
        `${w.sheet.title}: the circuit is named here but no segment on its layers was read.`,
      );
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
  const checked = opts.checks?.(sheets, links);
  const pid = buildPid(
    {
      circuit,
      sheets,
      links,
      register,
      ...(checked ? { checked } : {}),
      ...(opts.roles ? { roles: opts.roles } : {}),
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
    runs === 0
      ? sheets.length
        ? `Circuit ${circuit}: named on ${sheets.length} sheet${sheets.length === 1 ? '' : 's'} (${sheets.map((s) => s.title).join(', ')}), but no geometry on its layers was read.`
        : `Circuit ${circuit}: no uploaded drawing this caller can read has geometry on its layers.`
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
      ? { register: { source: clip(register?.source?.trim() || 'register'), discrepancies } }
      : {}),
    guesses,
    limits,
    summary,
  };
}
