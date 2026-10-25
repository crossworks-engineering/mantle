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
import type { BlockRow, NodeRow, SegRow, SheetInput } from './walk';

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

/** The first drawing of a trace: the overview page of a drawing set, or
 *  the drawing itself when one page holds the circuit. */
export function overviewOf(pid: unknown): Record<string, unknown> {
  const set = pid as { pages?: { data: Record<string, unknown> }[] };
  return set.pages ? set.pages[0]!.data : (pid as Record<string, unknown>);
}
