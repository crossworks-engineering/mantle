/**
 * circuit_trace v2 on made-up drawings (every tag, line number and sheet
 * name here is invented): the circuit layer as an overlay drawn in pieces
 * over the process lines, joined through them; a REDU block read as a
 * reducer; equipment found on the outline a run ends on; a sheet border
 * with a continuation label along it; a certain two-sheet link (label AND
 * line number); many deadleg stubs on the line budget; a dashed line.
 */
import { describe, expect, it } from 'vitest';
import { validate } from '@mantle/diagram-templates';
import { lineNumberOf, readTag, traceCircuit, valveOf } from './walk';
import type { BlockRow, InsertRow, NodeRow, SegRow, SheetInput } from './walk';

const C = '30000-001-01';
const M = `Circuit ${C}`;
const DL = `Circuit ${C}-DL`;
const PIPE = 'PROCESS';
const EQ = 'EQUIP';
const BORDER = 'FRAME';
const NUMBER = 'N100-39-6"';

const sg = (
  layer: string,
  handle: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  n1: number,
  n2: number,
): SegRow => ({ layer, handle, x1, y1, x2, y2, length: Math.hypot(x2 - x1, y2 - y1), n1, n2 });
const nd = (
  id: number,
  x: number,
  y: number,
  degree: number,
  kind: string,
  layers: string[],
  block = '',
  blockHandle = '',
): NodeRow => ({ id, x, y, degree, kind, block, blockHandle, layers });
const lineNo = (handle: string, x: number, y: number): BlockRow => ({
  block: 'LineNumber',
  layer: 'LINENO',
  handle,
  x,
  y,
  attribs: { LINE: 'N100', LINENO: NUMBER, CIRCUIT: M },
});
/** A box outline of four segments on `layer`, `split` naming a node on one
 *  side (the pipe end) as [side 0..3, node id, x, y]. */
function box(
  h: string,
  [x0, y0, x1, y1]: [number, number, number, number],
  ids: [number, number, number, number],
  split?: [number, number, number, number],
): SegRow[] {
  const pts: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const out: SegRow[] = [];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % 4]!;
    const a = ids[i]!;
    const b = ids[(i + 1) % 4]!;
    if (split && split[0] === i) {
      const [, n, sx, sy] = split;
      out.push(sg(EQ, `${h}${i}`, ax, ay, sx, sy, a, n), sg(EQ, `${h}${i}`, sx, sy, bx, by, n, b));
    } else out.push(sg(EQ, `${h}${i}`, ax, ay, bx, by, a, b));
  }
  return out;
}

/**
 * Sheet PID-2001 (near 2, so the bridge cap is 30 units):
 *
 *   [E-301/R1] 1 ══ 2 ── 3 ══ 4 [REDU] 5 ══╤╤╤…╤══ 6 | border, "COD PID-2002"
 *   7 ══ 8 on the exchanger's other side (a run of its own)
 *
 * ══ is the circuit overlay with the process line under it; 2 ── 3 is a
 * stretch of process line nobody overlaid; ╤ are `stubs` deadleg stubs.
 */
function sheetA(stubs = 3): SheetInput {
  const segments: SegRow[] = [
    sg(M, 'A', 0, 0, 20, 0, 1, 2),
    sg(M, 'B', 30, 0, 60, 0, 3, 4),
    sg(M, 'Q', -20, 0, -50, 0, 7, 8),
  ];
  const network: SegRow[] = [
    sg(PIPE, 'pA', 0, 0, 20, 0, 1, 2),
    sg(PIPE, 'pGap', 20, 0, 30, 0, 2, 3),
    sg(PIPE, 'pB', 30, 0, 60, 0, 3, 4),
    sg(PIPE, 'pQ', -20, 0, -50, 0, 7, 8),
    // The exchanger: its right side meets end 1, its left side end 7.
    ...box('E', [-20, -10, 0, 10], [100, 101, 102, 103], [1, 1, 0, 0]),
    // The border, one long line split at end 6.
    sg(BORDER, 'BRD', 100, -100, 100, 0, 200, 6),
    sg(BORDER, 'BRD', 100, 0, 100, 100, 6, 201),
  ];
  // Fix the exchanger's left side: split at node 7 (-20, 0).
  const left = network.findIndex((g) => g.handle === 'E3');
  network.splice(
    left,
    1,
    sg(EQ, 'E3', -20, 10, -20, 0, 103, 7),
    sg(EQ, 'E3', -20, 0, -20, -10, 7, 100),
  );
  const nodes: NodeRow[] = [
    nd(1, 0, 0, 3, 'tee', [M, PIPE, EQ]),
    nd(2, 20, 0, 3, 'joint', [M, PIPE]),
    nd(3, 30, 0, 3, 'joint', [M, PIPE]),
    nd(4, 60, 0, 1, 'block', [M, PIPE], 'REDU', 'R1'),
    nd(5, 62, 0, 1, 'block', [M, PIPE], 'REDU', 'R1'),
    nd(6, 100, 0, 3, 'tee', [M, BORDER]),
    nd(7, -20, 0, 3, 'tee', [M, PIPE, EQ]),
    nd(8, -50, 0, 2, 'joint', [M, PIPE]),
  ];
  // The run past the reducer, split at each stub's tee.
  let prev = 5;
  let px = 62;
  for (let i = 0; i < stubs; i++) {
    const x = 64 + (i * 34) / Math.max(1, stubs);
    const t = 300 + i;
    const top = 400 + i;
    segments.push(sg(M, `C${i}`, px, 0, x, 0, prev, t), sg(DL, `D${i}`, x, 0, x, 5, t, top));
    network.push(sg(PIPE, `pC${i}`, px, 0, x, 0, prev, t));
    nodes.push(nd(t, x, 0, 3, 'tee', [M, DL]), nd(top, x, 5, 1, 'end', [DL]));
    prev = t;
    px = x;
  }
  segments.push(sg(M, 'Z', px, 0, 100, 0, prev, 6));
  network.push(sg(PIPE, 'pZ', px, 0, 100, 0, prev, 6));
  const inserts: InsertRow[] = [
    { block: 'REDU', layer: 'V', handle: 'R1', x: 61, y: 0, minX: 60, minY: -1, maxX: 62, maxY: 1 },
  ];
  return {
    tableId: 't-a',
    title: 'PID-2001-rev-2',
    sourceFileId: null,
    circuitLayers: [M, DL],
    circuitRows: [],
    segments,
    nodes,
    inserts,
    texts: [
      { text: 'E-301/R1', layer: EQ, x: -10, y: 0 },
      { text: 'COD PID-2002', layer: BORDER, x: 101, y: 30 },
    ],
    blocks: [lineNo('LA', 45, -1)],
    near: 2,
    network,
    limits: [],
  };
}

/** Sheet PID-2002: in at the border under "COD PID-2001", on to C-401. */
function sheetB(): SheetInput {
  return {
    tableId: 't-b',
    title: 'PID-2002',
    sourceFileId: null,
    circuitLayers: [M],
    circuitRows: [],
    segments: [sg(M, 'A', 0, 0, 50, 0, 1, 2)],
    nodes: [nd(1, 0, 0, 3, 'tee', [M, BORDER]), nd(2, 50, 0, 3, 'tee', [M, EQ])],
    inserts: [],
    texts: [
      { text: 'COD PID-2001', layer: BORDER, x: -1, y: -30 },
      { text: 'C-401', layer: EQ, x: 60, y: 0 },
    ],
    blocks: [lineNo('LB', 25, 1)],
    near: 2,
    network: [
      sg(PIPE, 'pA', 0, 0, 50, 0, 1, 2),
      sg(BORDER, 'BRD', 0, -100, 0, 0, 200, 1),
      sg(BORDER, 'BRD', 0, 0, 0, 100, 1, 201),
      ...box('K', [50, -20, 70, 20], [100, 101, 102, 103], [3, 2, 50, 0]),
    ],
    limits: [],
  };
}

type Pid = {
  equipment: { id: string; type: string }[];
  offpage: { text?: string }[];
  lines: Record<string, unknown>[];
};

describe('pieces of the overlay are joined through the process line', () => {
  const r = traceCircuit(C, [sheetA()]);
  const s = r.sheets[0]!;

  it('a stretch nobody overlaid joins two pieces: one run, the join with its handles', () => {
    const process = s.joins.filter((j) => j.kind === 'process');
    expect(process).toEqual([
      expect.objectContaining({ from: 2, to: 3, length: 10, handles: ['pGap'] }),
    ]);
    // The main run and the run on the exchanger's other side: never joined
    // through the exchanger's outline.
    expect(s.runs).toHaveLength(2);
  });

  it('a REDU block is a reducer, never a valve, and no guess', () => {
    expect(valveOf('REDU')).toEqual({ type: 'reducer', guessed: false });
    expect(valveOf('RED_CONC')).toMatchObject({ type: 'reducer' });
    expect(s.blocksOnPath.find((v) => v.block === 'REDU')).toMatchObject({ type: 'reducer' });
    expect(r.guesses.join(' ')).not.toMatch(/REDU/);
  });

  it('the end on an outline takes the tag inside it, revision and all', () => {
    expect(readTag('E-301/R1')).toMatchObject({ kind: 'equipment', tag: 'E-301/R1' });
    expect(readTag('C-205/ 02')).toMatchObject({ kind: 'equipment', tag: 'C-205/02' });
    const end1 = s.runs.flatMap((x) => x.ends).find((e) => e.node === 1)!;
    expect(end1.equipment).toEqual(['E-301/R1']);
    expect(end1.equipmentBasis).toMatch(/outline on layer EQUIP/);
    const end7 = s.runs.flatMap((x) => x.ends).find((e) => e.node === 7)!;
    expect(end7.equipment).toEqual(['E-301/R1']);
  });

  it('the line number is the full tag as written (LINENO over LINE)', () => {
    expect(lineNumberOf({ LINE: 'N100', LINENO: NUMBER })).toBe(NUMBER);
    expect(s.lineNumbers.map((l) => l.number)).toEqual([NUMBER]);
  });

  it('an end on a sheet border takes the continuation label along it', () => {
    const end6 = s.runs.flatMap((x) => x.ends).find((e) => e.node === 6)!;
    expect(end6.labels).toContain('COD PID-2002');
  });
});

describe('the main line along the flow, across a certain sheet link', () => {
  it('label AND the same line number make a certain link; the main line runs equipment to equipment', () => {
    const r = traceCircuit(C, [sheetA(), sheetB()]);
    expect(r.links).toEqual([
      expect.objectContaining({
        from: { sheet: 'PID-2001-rev-2', node: 6 },
        to: { sheet: 'PID-2002', node: 1 },
        guessed: false,
      }),
    ]);
    const pid = r.pid as Pid;
    expect(validate('pid', pid).ok).toBe(true);
    expect(pid.equipment).toEqual([
      { id: 'E-301/R1', type: 'shell-tube-exchanger' },
      { id: 'C-401', type: 'column' },
    ]);
    const main = pid.lines[0]!;
    expect(main).toMatchObject({ from: 'E-301/R1', to: 'C-401', number: NUMBER });
    expect(main.inline).toEqual([{ type: 'reducer' }]);
    // No connector pair for a link both sheets confirm.
    expect(pid.offpage).toEqual([]);
  });

  it("the register's from and to fix the direction", () => {
    const r = traceCircuit(C, [sheetA(), sheetB()], { from: 'C-401', to: 'E-301' });
    const main = (r.pid as Pid).lines[0]!;
    expect(main).toMatchObject({ from: 'C-401', to: 'E-301/R1' });
    expect((r.pid as { description: string }).description).toMatch(/register's circuit from C-401/);
  });
});

describe('deadlegs come after the main run on the line budget', () => {
  it('24 stubs: the main run first, the stubs drawn to the budget, the rest counted', () => {
    const r = traceCircuit(C, [sheetA(24), sheetB()]);
    const pid = r.pid as Pid;
    expect(validate('pid', pid).ok).toBe(true);
    expect(pid.lines).toHaveLength(20);
    expect(pid.lines[0]).toMatchObject({ from: 'E-301/R1', to: 'C-401' });
    const stubs = pid.lines.filter((l) => l.deadleg === true);
    expect(stubs).toHaveLength(18);
    expect(r.limits.join(' ')).toMatch(/24 on line N100-39-6" \(18 drawn, the longest\)/);
  });
});

describe('a dashed line is one line', () => {
  it('collinear dashes of one layer join across their gaps', () => {
    const segments = [0, 1, 2, 3].map((i) =>
      sg(DL, `d${i}`, i * 4.5, 0, i * 4.5 + 3, 0, 2 * i + 1, 2 * i + 2),
    );
    const nodes = segments.flatMap((g) => [
      nd(g.n1, g.x1, g.y1, 1, 'end', [DL]),
      nd(g.n2, g.x2, g.y2, 1, 'end', [DL]),
    ]);
    const r = traceCircuit(C, [
      { ...sheetB(), segments, nodes, circuitLayers: [DL], network: [], blocks: [], texts: [] },
    ]);
    const s = r.sheets[0]!;
    expect(s.runs).toHaveLength(1);
    expect(s.deadlegRuns).toBe(1);
    expect(s.joins.map((j) => j.kind)).toEqual(['gap', 'gap', 'gap']);
  });
});
