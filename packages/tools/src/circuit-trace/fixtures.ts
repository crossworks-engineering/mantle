/**
 * Made-up drawings for the circuit_trace tests: two sheets of circuit
 * 10000-001-01 (names, tags and line numbers invented for the tests).
 *
 * Sheet PID-1001: E-101 feeds a pipe through a gate valve (a block bridge)
 * to a tee; a deadleg leaves the tee upwards; the main line runs on to a
 * continuation label naming PID-1002.
 *
 *   E-101  1 ──A── 2 [GATE] 3 ──B── 4 ──C── 5  "CONT. ON PID-1002"
 *                                   │
 *                                   D (deadleg layer)
 *                                   6
 *
 * Sheet PID-1002: the line comes in under "CONT. FROM PID-1001" and ends on
 * another circuit's layer (10000-002-01).
 */
import { lineNoteSuffix, markSuffix } from '@mantle/diagram-templates';
import type { BlockRow, NodeRow, SegRow, SheetInput } from './walk';

/**
 * `pid` data (a drawing or a set) with its labels as the view draws them
 * (@mantle/diagram-templates markSuffix, lineNoteSuffix): a connector's
 * text with its mark's trust word, a line's note with its marks'. The
 * trace writes the words only where an element has no mark; the tests read
 * the drawing as a person sees it.
 */
export function shown<T>(pid: T): T {
  const obj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const drawing = (d: Record<string, unknown>) => ({
    ...d,
    ...(Array.isArray(d.offpage)
      ? {
          offpage: d.offpage.map((o: unknown) =>
            obj(o) && obj(o.check)
              ? { ...o, text: `${String(o.text ?? '')}${markSuffix(o.check)}` }
              : o,
          ),
        }
      : {}),
    ...(Array.isArray(d.lines)
      ? {
          lines: d.lines.map((l: unknown) => {
            if (!obj(l)) return l;
            const words = lineNoteSuffix(l);
            return words ? { ...l, note: `${String(l.note ?? '')}${words}`.trim() } : l;
          }),
        }
      : {}),
  });
  if (!obj(pid)) return pid;
  if (Array.isArray(pid.pages))
    return {
      ...pid,
      pages: pid.pages.map((p: unknown) =>
        obj(p) && obj(p.data) ? { ...p, data: drawing(p.data) } : p,
      ),
    } as T;
  return drawing(pid) as T;
}

export const CIRCUIT = '10000-001-01';
export const MAIN = `Circuit ${CIRCUIT}`;
export const DL = `Circuit ${CIRCUIT}-DL`;
export const OTHER = 'Circuit 10000-002-01';

const seg = (
  layer: string,
  handle: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  n1: number,
  n2: number,
): SegRow => ({ layer, handle, x1, y1, x2, y2, length: Math.hypot(x2 - x1, y2 - y1), n1, n2 });

const node = (
  id: number,
  x: number,
  y: number,
  degree: number,
  kind: string,
  layers: string[],
  block = '',
  blockHandle = '',
): NodeRow => ({ id, x, y, degree, kind, block, blockHandle, layers });

const lineNo = (handle: string, x: number, y: number, number: string): BlockRow => ({
  block: 'LineNumber',
  layer: 'LINENO',
  handle,
  x,
  y,
  attribs: { LINENO: number, CIRCUIT },
});

export function sheetOne(): SheetInput {
  return {
    tableId: 'table-1001',
    title: 'PID-1001',
    sourceFileId: 'file-1001',
    circuitLayers: [MAIN, DL],
    circuitRows: [
      {
        Circuit: CIRCUIT,
        'Line numbers': '2"-P-0001-A1 [L1]; 2"-P-0002-A1 [L2]; 1"-P-0003-A1 [L3]',
      },
    ],
    segments: [
      seg(MAIN, 'A1', 0, 0, 20, 0, 1, 2),
      seg(MAIN, 'B1', 22, 0, 50, 0, 3, 4),
      seg(MAIN, 'C1', 50, 0, 100, 0, 4, 5),
      seg(DL, 'D1', 50, 0, 50, 30, 4, 6),
    ],
    nodes: [
      node(1, 0, 0, 1, 'end', [MAIN]),
      node(2, 20, 0, 1, 'block', [MAIN], 'GATE_VALVE', 'V1'),
      node(3, 22, 0, 1, 'block', [MAIN], 'GATE_VALVE', 'V1'),
      node(4, 50, 0, 3, 'tee', [MAIN, DL]),
      node(5, 100, 0, 1, 'end', [MAIN]),
      node(6, 50, 30, 1, 'end', [DL]),
    ],
    inserts: [
      {
        block: 'GATE_VALVE',
        layer: 'VALVES',
        handle: 'V1',
        x: 21,
        y: 0,
        minX: 20,
        minY: -1,
        maxX: 22,
        maxY: 1,
      },
    ],
    texts: [
      { text: 'E-101', layer: 'EQUIP', x: -2, y: 3 },
      { text: 'CONT. ON PID-1002', layer: 'TEXT', x: 101, y: 2 },
    ],
    blocks: [
      lineNo('L1', 35, 1, '2"-P-0001-A1'),
      lineNo('L2', 75, 1, '2"-P-0002-A1'),
      lineNo('L3', 51, 15, '1"-P-0003-A1'),
    ],
    near: 5,
    limits: [],
  };
}

export function sheetTwo(): SheetInput {
  return {
    tableId: 'table-1002',
    title: 'PID-1002',
    sourceFileId: 'file-1002',
    circuitLayers: [MAIN, OTHER],
    circuitRows: [{ Circuit: CIRCUIT, 'Line numbers': '2"-P-0002-A1 [L4]' }],
    segments: [seg(MAIN, 'E1', 0, 0, 40, 0, 1, 2), seg(OTHER, 'F1', 40, 0, 40, -20, 2, 3)],
    nodes: [node(1, 0, 0, 1, 'end', [MAIN]), node(2, 40, 0, 2, 'joint', [MAIN, OTHER])],
    inserts: [],
    texts: [{ text: 'CONT. FROM PID-1001', layer: 'TEXT', x: -1, y: 2 }],
    blocks: [lineNo('L4', 20, 1, '2"-P-0002-A1')],
    near: 5,
    limits: [],
  };
}

/** Sheet one with its valve read only from a generic block name (a guess
 *  the check asks about). */
export const genericValveSheet = (): SheetInput => {
  const s = JSON.parse(
    JSON.stringify(sheetOne()).replaceAll('GATE_VALVE', 'VALVE-GENERIC'),
  ) as SheetInput;
  s.revision = 'rev1';
  return s;
};

/**
 * Two sheets whose main line starts at a reading: on PID-1001 the start
 * end (node 1) meets nothing drawn and E-101 is written 7 units off (past
 * the near distance, 5), and a second main-layer branch off the tee ends
 * at node 7 with E-101 written 9 units off; PID-1002 ends at V-201. The
 * closer reading (node 1) takes the main line first.
 */
export function readingSheets(): SheetInput[] {
  const one = sheetOne();
  one.revision = 'rev1';
  one.texts = [
    { text: 'E-101', layer: 'EQUIP', x: -7, y: 0 },
    { text: 'P-150', layer: 'EQUIP', x: -6, y: -6 },
    { text: 'E-101', layer: 'EQUIP', x: 59, y: -30 },
    { text: 'CONT. ON PID-1002', layer: 'TEXT', x: 101, y: 2 },
  ];
  one.segments.push({
    layer: MAIN,
    handle: 'G1',
    x1: 50,
    y1: 0,
    x2: 50,
    y2: -30,
    length: 30,
    n1: 4,
    n2: 7,
  });
  one.nodes = one.nodes.map((n) => (n.id === 4 ? { ...n, degree: 4 } : n));
  one.nodes.push({
    id: 7,
    x: 50,
    y: -30,
    degree: 1,
    kind: 'end',
    block: '',
    blockHandle: '',
    layers: [MAIN],
  });
  const two = sheetTwo();
  two.revision = 'rev1';
  two.circuitLayers = [MAIN];
  two.segments = two.segments.filter((g) => g.layer === MAIN);
  two.nodes = [
    two.nodes[0]!,
    { id: 2, x: 40, y: 0, degree: 1, kind: 'end', block: '', blockHandle: '', layers: [MAIN] },
  ];
  two.texts.push({ text: 'V-201', layer: 'EQUIP', x: 42, y: 1 });
  return [one, two];
}

/** The first drawing of a trace: the overview page of a drawing set, or
 *  the drawing itself when one page holds the circuit. */
export function overviewOf(pid: unknown): Record<string, unknown> {
  const set = pid as { pages?: { data: Record<string, unknown> }[] };
  return set.pages ? set.pages[0]!.data : (pid as Record<string, unknown>);
}

/** A seeded generator (the same numbers for the same seed, every run). */
export function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * A random sheet for fuzzing: up to `k` polylines on the circuit's layers
 * (some dashed, with gaps at the joining tolerance, some sharing points so
 * they tee), ends that are valves, labels near points, line number blocks
 * and process strokes joining random points. Nothing in it is a real
 * drawing.
 */
export function randomSheet(
  rnd: () => number,
  k: number,
  title = 'PID-1001',
  tableId = 't1',
): SheetInput {
  const ri = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(a: T[]): T => a[ri(a.length)]!;
  const near = pick([1, 2.5, 10, 0.5, 7]);
  const segments: SegRow[] = [];
  const nodes: NodeRow[] = [];
  const network: SegRow[] = [];
  let id = 1;
  let h = 0;
  const nodeAt = new Map<string, number>();
  const at = (x: number, y: number, layer: string, share: boolean) => {
    const key = `${x},${y},${layer}`;
    if (share && nodeAt.has(key)) return nodeAt.get(key)!;
    const n = id++;
    nodeAt.set(key, n);
    nodes.push(node(n, x, y, 1, 'end', [layer]));
    return n;
  };
  const piece = (
    layer: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    a: number,
    b: number,
  ) => seg(layer, `H${h++}`, x1, y1, x2, y2, a, b);
  const starts: [number, number][] = [];
  const lines = 1 + ri(k);
  for (let L = 0; L < lines; L++) {
    const layer = rnd() < 0.25 ? DL : MAIN;
    let x = rnd() < 0.3 ? 2 * near * ri(20) : Math.round(rnd() * 400 * 100) / 100;
    let y = rnd() < 0.3 ? 2 * near * ri(20) : Math.round(rnd() * 400 * 100) / 100;
    if (starts.length && rnd() < 0.4) [x, y] = pick(starts);
    const ang = pick([
      0,
      Math.PI / 2,
      Math.PI,
      -Math.PI / 2,
      rnd() * 2 * Math.PI,
      0.01,
      Math.PI / 4,
    ]);
    const dashed = rnd() < 0.5;
    const pieces = 1 + ri(6);
    let n0 = at(x, y, layer, true);
    starts.push([x, y]);
    for (let p = 0; p < pieces; p++) {
      const len = pick([near * 0.3, near, near * 2, 3 * near, rnd() * 20 * near, near * 0.5]);
      const x2 = x + Math.cos(ang) * len;
      const y2 = y + Math.sin(ang) * len;
      const n1 = at(x2, y2, layer, true);
      segments.push(piece(layer, x, y, x2, y2, n0, n1));
      starts.push([x2, y2]);
      x = x2;
      y = y2;
      n0 = n1;
      if (dashed) {
        const gap = pick([near, near * 0.999, near * 1.0001, near * 0.5, 0, near * 2, near * 0.1]);
        const jitter = rnd() < 0.3 ? (rnd() - 0.5) * near * 0.2 : 0;
        x = x + Math.cos(ang) * gap + (rnd() < 0.5 ? jitter : 0);
        y = y + Math.sin(ang) * gap;
        n0 = at(x, y, layer, rnd() < 0.5);
      }
    }
  }
  const strokes = ri(k * 2);
  for (let i = 0; i < strokes; i++) {
    const a = pick(nodes);
    const b = pick(nodes);
    network.push(piece(pick(['PROCESS', 'PROCESS', 'SYMBOL']), a.x, a.y, b.x, b.y, a.id, b.id));
  }
  const deg = new Map<number, number>();
  for (const s of segments) {
    deg.set(s.n1, (deg.get(s.n1) ?? 0) + 1);
    deg.set(s.n2, (deg.get(s.n2) ?? 0) + 1);
  }
  for (const n of nodes) {
    const d = deg.get(n.id) ?? 0;
    n.degree = d;
    n.kind = d >= 3 ? 'tee' : d === 2 ? 'vertex' : 'end';
    if (d === 1 && rnd() < 0.05) {
      n.kind = 'block';
      n.block = 'GATE_VALVE';
      n.blockHandle = `V${ri(4)}`;
    }
    const ls = new Set<string>();
    for (const s of segments) if (s.n1 === n.id || s.n2 === n.id) ls.add(s.layer);
    if (ls.size) n.layers = [...ls];
  }
  const texts: SheetInput['texts'] = [];
  const tags = [
    'V-100',
    'E-999',
    'P-201',
    'T-5',
    'PI-2001',
    'CONT. ON PID-1002',
    'CONT. FROM PID-1001',
  ];
  for (let i = 0; i < ri(6); i++) {
    const n = pick(nodes);
    texts.push({
      text: pick(tags),
      layer: 'T',
      x: n.x + (rnd() - 0.5) * near * 2,
      y: n.y + (rnd() - 0.5) * near * 2,
    });
  }
  const blocks: BlockRow[] = [];
  for (let i = 0; i < ri(3); i++) {
    const n = pick(nodes);
    blocks.push(lineNo(`LN${i}`, n.x, n.y, `2"-P-000${ri(5)}-A1`));
  }
  return {
    tableId,
    title,
    sourceFileId: null,
    circuitLayers: [MAIN, DL],
    circuitRows: [],
    segments,
    nodes,
    inserts: [],
    texts,
    blocks,
    near,
    limits: [],
    ...(rnd() < 0.6 ? { network } : {}),
  };
}
