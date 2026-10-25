import { describe, expect, it } from 'vitest';
import { checkStaticSvg, estimateMeasurer, render, validate } from '@mantle/diagram-templates';
import { CIRCUIT, DL, MAIN, overviewOf, sheetOne, sheetTwo } from './fixtures';
import {
  isContinuationBlock,
  layersOf,
  parseCircuitLayer,
  parseLineNumbers,
  readTag,
  traceCircuit,
  valveOf,
  type NodeRow,
  type SegRow,
  type SheetInput,
} from './walk';

describe('the layer rule (the phase 1 table)', () => {
  it('reads main, deadleg and injection-point layers', () => {
    expect(parseCircuitLayer('Circuit 10000-001-01')).toMatchObject({
      circuit: '10000-001-01',
      role: 'main',
    });
    expect(parseCircuitLayer('Circuit 10000-001-01-DL')).toMatchObject({
      role: 'deadleg',
      sub: 'DL',
    });
    expect(parseCircuitLayer('Circuit 10000-001-01-B02-DL')).toMatchObject({
      role: 'deadleg',
      sub: 'B02-DL',
    });
    expect(parseCircuitLayer('Circuit 10000-001-01-D03')).toMatchObject({
      circuit: '10000-001-01',
      role: 'deadleg',
    });
    expect(parseCircuitLayer('Circuit 10000-001-01-IP1')).toMatchObject({
      circuit: '10000-001-01-IP1',
      parent: '10000-001-01',
    });
    expect(parseCircuitLayer('PIPING')).toBeNull();
  });

  it('sorts a drawing’s layers by role for one circuit', () => {
    const l = layersOf(CIRCUIT, [
      MAIN,
      DL,
      'Circuit 10000-001-01-IP1',
      'Circuit 10000-002-01',
      'TEXT',
    ]);
    expect(l).toEqual({ main: [MAIN], deadleg: [DL], injection: ['Circuit 10000-001-01-IP1'] });
  });

  it('parses the Circuits tab line-number cell and valve names', () => {
    expect(parseLineNumbers('A-1 [1F]; B-2 [20]; +3 more')).toEqual([
      { number: 'A-1', handle: '1F' },
      { number: 'B-2', handle: '20' },
    ]);
    expect(valveOf('GATE_VALVE')).toEqual({ type: 'gate', guessed: false });
    expect(valveOf('VALVE-GENERIC')).toEqual({ type: 'gate', guessed: true });
    expect(valveOf('TITLEBLOCK')).toBeNull();
  });
});

describe('the walk on one sheet', () => {
  const r = traceCircuit(CIRCUIT, [sheetOne()]);
  const sheet = r.sheets[0]!;
  const run = sheet.runs[0]!;

  it('finds one run with a tee, three ends and the deadleg', () => {
    expect(sheet.runs).toHaveLength(1);
    expect(run.tees).toEqual([4]);
    expect(run.ends.map((e) => e.node).sort()).toEqual([1, 5, 6]);
    expect(sheet.deadlegRuns).toBe(1);
    expect(run.ends.find((e) => e.node === 6)!.deadleg).toBe(true);
  });

  it('walks ordered chains through the valve bridge', () => {
    const chain = run.chains.find((c) => [c.from, c.to].includes(1))!;
    expect([chain.from, chain.to].sort()).toEqual([1, 4]);
    expect(chain.handles).toEqual(chain.from === 1 ? ['A1', 'B1'] : ['B1', 'A1']);
    expect(chain.valves).toEqual([
      { block: 'GATE_VALVE', handle: 'V1', type: 'gate', guessed: false },
    ]);
    expect(run.chains.find((c) => c.role === 'deadleg')!.handles).toEqual(['D1']);
    expect(run.length).toBe(128);
  });

  it('says what each end meets: equipment, a continuation label, nothing', () => {
    const end = (n: number) => run.ends.find((e) => e.node === n)!;
    expect(end(1).equipment).toEqual(['E-101']);
    expect(end(5).labels).toEqual(['CONT. ON PID-1002']);
    expect(end(5).meets).toEqual({ kind: 'open' });
  });

  it('keeps line numbers with their handles on the chains', () => {
    const numbers = run.chains.flatMap((c) => c.lineNumbers.map((l) => l.number)).sort();
    expect(numbers).toEqual(['1"-P-0003-A1', '2"-P-0001-A1', '2"-P-0002-A1']);
    expect(sheet.lineNumbers.map((l) => l.handle).sort()).toEqual(['L1', 'L2', 'L3']);
  });

  it('a label naming a sheet that is not uploaded is a limit, never a link', () => {
    expect(r.links).toEqual([]);
    expect(r.limits.join(' ')).toMatch(/names no uploaded sheet/);
  });
});

describe('sheet links', () => {
  it('links two sheets by labels that name each other (not a guess)', () => {
    const r = traceCircuit(CIRCUIT, [sheetOne(), sheetTwo()]);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({
      from: { sheet: 'PID-1001', node: 5 },
      to: { sheet: 'PID-1002', node: 1 },
      basis: 'label',
      guessed: false,
    });
  });

  it('falls back to the same line number, marked as a guess', () => {
    const one = sheetOne();
    one.texts = one.texts.filter((t) => !t.text.startsWith('CONT'));
    const two = sheetTwo();
    two.texts = [];
    const r = traceCircuit(CIRCUIT, [one, two]);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({ basis: 'line-number', guessed: true });
    expect(r.guesses.join(' ')).toMatch(/is a guess/);
  });

  it('an end on another circuit’s layer names that circuit', () => {
    const r = traceCircuit(CIRCUIT, [sheetTwo()]);
    const end = r.sheets[0]!.runs[0]!.ends.find((e) => e.node === 2)!;
    expect(end.meets).toEqual({
      kind: 'circuit',
      circuit: '10000-002-01',
      layer: 'Circuit 10000-002-01',
    });
  });
});

describe('the pid template input', () => {
  const r = traceCircuit(CIRCUIT, [sheetOne(), sheetTwo()]);
  const pid = overviewOf(r.pid) as {
    equipment: { id: string; type: string }[];
    offpage: { id: string; direction: string; sheet: string; text?: string }[];
    lines: Record<string, unknown>[];
    tees: { id: string; on: string }[];
  };

  it('validates against the pid template', () => {
    const checked = validate('pid', pid);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
  });

  it('draws the trunk from the equipment across the certain sheet link, the deadleg on a tee', () => {
    expect(pid.equipment).toEqual([{ id: 'E-101', type: 'shell-tube-exchanger' }]);
    const trunk = pid.lines.find((l) => l.from === 'E-101')!;
    // Labels on both sheets and the same line number: one point, no break.
    const out = pid.offpage.find((o) => o.id === trunk.to)!;
    expect(out).toMatchObject({ direction: 'out', text: 'CIRCUIT 10000-002-01' });
    expect(trunk.inline).toEqual([{ type: 'gate' }]);
    // 48 of the 138 units from E-101 (20 + 28 on this sheet, 50 + 40 on).
    expect(pid.tees).toEqual([{ id: pid.tees[0]!.id, on: trunk.id, at: 0.35 }]);
    const dl = pid.lines.find((l) => l.deadleg === true)!;
    expect(dl.from).toBe(pid.tees[0]!.id);
    expect(dl.to).toBeUndefined();
    expect(dl.number).toBe('1"-P-0003-A1');
  });

  it('a certain link draws no connector pair: the line runs on to the other circuit', () => {
    const texts = pid.offpage.map((o) => o.text);
    expect(texts).toEqual(['CIRCUIT 10000-002-01']);
    expect(r.links).toEqual([expect.objectContaining({ basis: 'label', guessed: false })]);
  });

  it('a guessed link is labelled GUESS on its connector', () => {
    const one = sheetOne();
    one.texts = one.texts.filter((t) => !t.text.startsWith('CONT'));
    const two = sheetTwo();
    two.texts = [];
    const g = overviewOf(traceCircuit(CIRCUIT, [one, two]).pid) as typeof pid;
    expect(g.offpage.some((o) => /\(GUESS\)$/.test(o.text ?? ''))).toBe(true);
    expect(validate('pid', g).ok).toBe(true);
  });

  it('an end that meets nothing starts at a connector marked OPEN END, said in limits', () => {
    const one = sheetOne();
    one.texts = [];
    const r1 = traceCircuit(CIRCUIT, [one]);
    const p = overviewOf(r1.pid) as typeof pid;
    expect(p.offpage.some((o) => o.text === 'OPEN END')).toBe(true);
    expect(r1.limits.join(' ')).toMatch(/meets nothing drawn/);
    expect(validate('pid', p).ok).toBe(true);
  });
});

describe('register differences, both ways', () => {
  const r = traceCircuit(CIRCUIT, [sheetOne(), sheetTwo()], {
    source: 'test register',
    lines: [
      { number: '2"-P-0001-A1', sheet: 'PID-1001' },
      { number: '2"-P-0002-A1', sheet: 'PID-1001' },
      { number: '2"-P-0009-A1', sheet: 'PID-1003' },
    ],
    sheets: ['PID-1001', 'PID-1002', 'PID-1003'],
    deadlegs: 2,
  });
  const kinds = (k: string) => r.register!.discrepancies.filter((d) => d.kind === k);

  it('a line on the layer that the register lacks', () => {
    expect(
      kinds('line_not_in_register')
        .map((d) => d.detail)
        .join(),
    ).toMatch(/1-P-0003-A1/);
  });
  it('a register line with no geometry, and its sheet not uploaded', () => {
    expect(kinds('register_line_no_geometry')[0]!.detail).toMatch(
      /2"-P-0009-A1.*PID-1003 is not uploaded/,
    );
    expect(
      kinds('register_sheet_not_uploaded')
        .map((d) => d.detail)
        .join(),
    ).toMatch(/PID-1003/);
    expect(r.limits.join(' ')).toMatch(
      /PID-1003 is on the register but not among the traced drawings/,
    );
  });
  it('the deadleg count', () => {
    expect(kinds('deadleg_count')[0]!.detail).toMatch(
      /register has 2 deadlegs; the drawings show 1/,
    );
  });
  it('no difference where they agree', () => {
    expect(kinds('register_line_other_sheet')).toEqual([]);
    expect(r.register!.source).toBe('test register');
  });
  it('a deadleg flag that disagrees with the layer', () => {
    const f = traceCircuit(CIRCUIT, [sheetOne()], {
      lines: [{ number: '1"-P-0003-A1', deadleg: false }],
    });
    expect(f.register!.discrepancies.map((d) => d.kind)).toContain('deadleg_flag');
  });
});

describe('nothing to trace', () => {
  it('says so plainly', () => {
    const r = traceCircuit('99999-999-99', [sheetOne()]);
    expect(r.sheets).toEqual([]);
    expect(r.summary).toMatch(/no uploaded drawing/);
  });
});

/* Round 1 audit regressions: each built from the auditors' probe inputs. */

const C = '10000-001-01';
const M = `Circuit ${C}`;
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
const sheet = (over: Partial<SheetInput>): SheetInput => ({
  tableId: 't1',
  title: 'PID-1001',
  sourceFileId: null,
  circuitLayers: [M],
  circuitRows: [],
  segments: [],
  nodes: [],
  inserts: [],
  texts: [],
  blocks: [],
  near: 10,
  limits: [],
  ...over,
});
const line = (over: Partial<SheetInput> = {}) =>
  sheet({
    segments: [sg(M, 'A', 0, 0, 100, 0, 1, 2)],
    nodes: [nd(1, 0, 0, 1, 'end', [M]), nd(2, 100, 0, 1, 'end', [M])],
    ...over,
  });
type Pid = {
  equipment: { id: string; type: string }[];
  offpage: { id: string; text?: string }[];
  lines: Record<string, unknown>[];
  tees: { id: string; on: string; at?: number }[];
  circuits: { id: string }[];
};
const pidOf = (r: ReturnType<typeof traceCircuit>) => overviewOf(r.pid) as unknown as Pid;
const valid = (r: ReturnType<typeof traceCircuit>) => {
  const v = validate('pid', r.pid);
  return v.ok ? [] : v.errors;
};

describe('round 1: the walk', () => {
  it('a copied LINE (same two nodes, a new handle) is one piece', () => {
    const r = traceCircuit(C, [
      sheet({
        segments: [
          sg(M, 'A', 0, 0, 100, 0, 1, 2),
          sg(M, 'A2', 0, 0, 100, 0, 1, 2),
          sg(M, 'B', 100, 0, 200, 0, 2, 3),
        ],
        nodes: [
          nd(1, 0, 0, 1, 'end', [M]),
          nd(2, 100, 0, 2, 'joint', [M]),
          nd(3, 200, 0, 1, 'end', [M]),
        ],
      }),
    ]);
    const run = r.sheets[0]!.runs[0]!;
    expect(run.tees).toEqual([]);
    expect(run.ends.map((e) => e.node)).toEqual([1, 3]);
    expect(run.length).toBe(200);
  });

  it('a line number whose CIRCUIT names another circuit is not credited here (MED-2)', () => {
    const r = traceCircuit(C, [
      line({
        blocks: [
          {
            block: 'LineNumber',
            layer: 'LN',
            handle: 'LY',
            x: 50,
            y: 2,
            attribs: { LINENO: '2"-P-0099', CIRCUIT: '10000-002-01' },
          },
          {
            block: 'LineNumber',
            layer: 'LN',
            handle: 'LX',
            x: 30,
            y: 2,
            attribs: { LINENO: '2"-P-0001', CIRCUIT: C },
          },
          // Named for this circuit but drawn far from it: on the sheet's
          // list, on no chain.
          {
            block: 'LineNumber',
            layer: 'LN',
            handle: 'LF',
            x: 5000,
            y: 5000,
            attribs: { LINENO: '2"-P-0002', CIRCUIT: C },
          },
        ],
      }),
    ]);
    const s = r.sheets[0]!;
    expect(s.lineNumbers.map((l) => l.handle).sort()).toEqual(['LF', 'LX']);
    expect(s.runs[0]!.chains.flatMap((c) => c.lineNumbers.map((l) => l.handle))).toEqual(['LX']);
  });

  it('an injection point’s row keeps its own line numbers (MED-2)', () => {
    const r = traceCircuit(C, [
      line({
        circuitRows: [
          { Circuit: C, Parent: '', 'Line numbers': '2"-P-0001 [L1]' },
          { Circuit: `${C}-IP1`, Parent: C, 'Line numbers': '1"-P-0900 [L9]' },
        ],
      }),
    ]);
    expect(r.sheets[0]!.lineNumbers.map((l) => l.handle)).toEqual(['L1']);
  });

  it('an end at a valve keeps the valve and says the line beyond is not traced (MED-4)', () => {
    const r = traceCircuit(C, [
      line({
        nodes: [nd(1, 0, 0, 1, 'end', [M]), nd(2, 100, 0, 1, 'end', [M], 'GATE_VALVE', 'V9')],
        inserts: [
          {
            block: 'GATE_VALVE',
            layer: 'V',
            handle: 'V9',
            x: 103,
            y: 0,
            minX: 100,
            minY: -1.5,
            maxX: 106,
            maxY: 1.5,
          },
        ],
      }),
    ]);
    const end = r.sheets[0]!.runs[0]!.ends.find((e) => e.node === 2)!;
    expect(end.beyond).toMatch(/stop at block GATE_VALVE \[V9\].*not traced/);
    const l = pidOf(r).lines[0]!;
    expect(l.inline).toEqual([{ type: 'gate' }]);
    expect(l.end).not.toBe('cap');
    expect(r.limits.join(' ')).toMatch(/end #2: the circuit's layers stop at block GATE_VALVE/);
    expect(valid(r)).toEqual([]);
  });

  it('instrument tags are instruments, never equipment; the end stays a link candidate (MED-5)', () => {
    const one = line({
      texts: [
        { text: 'PI-2001', layer: 'INST', x: 98, y: 5 },
        { text: 'FV-101', layer: 'INST', x: 2, y: 5 },
        { text: 'CONT. ON PID-1002', layer: 'T', x: 102, y: -3 },
      ],
    });
    const two = line({
      tableId: 't2',
      title: 'PID-1002',
      texts: [{ text: 'CONT. FROM PID-1001', layer: 'T', x: -2, y: 2 }],
    });
    const r = traceCircuit(C, [one, two]);
    expect(pidOf(r).equipment).toEqual([]);
    const ends = r.sheets[0]!.runs[0]!.ends;
    expect(ends.find((e) => e.node === 2)!.instruments).toEqual(['PI-2001']);
    expect(ends.find((e) => e.node === 1)!.instruments).toEqual(['FV-101']);
    const label = r.links.find((l) => l.basis === 'label')!;
    // Labels alone, no line number on both ends: matched, but a guess.
    expect(label).toMatchObject({
      from: { sheet: 'PID-1001', node: 2 },
      to: { sheet: 'PID-1002', node: 1 },
      guessed: true,
    });
    expect(readTag('TT-501')).toEqual({ tag: 'TT-501', kind: 'instrument' });
    expect(readTag('LT-20')).toMatchObject({ kind: 'instrument' });
    expect(readTag('E-101')).toMatchObject({ kind: 'equipment', type: 'shell-tube-exchanger' });
    expect(readTag('TK-501')).toMatchObject({ kind: 'equipment', type: 'tank' });
  });

  it('a control valve is not a continuation symbol (LOW)', () => {
    expect(isContinuationBlock('CONTROL_VALVE')).toBe(false);
    expect(isContinuationBlock('CONT_ARROW')).toBe(true);
    expect(isContinuationBlock('OFFPAGE_CONNECTOR')).toBe(true);
    const r = traceCircuit(C, [
      line({
        inserts: [
          {
            block: 'CONTROL_VALVE',
            layer: 'V',
            handle: 'CV1',
            x: 103,
            y: 0,
            minX: 100,
            minY: -2,
            maxX: 106,
            maxY: 2,
          },
        ],
      }),
    ]);
    expect(r.sheets[0]!.runs[0]!.ends.every((e) => e.labels.length === 0)).toBe(true);
  });

  it('a leader line touching an end does not stop it being a sheet link (LOW)', () => {
    const one = line({
      nodes: [nd(1, 0, 0, 1, 'end', [M]), nd(2, 100, 0, 2, 'joint', [M, 'LEADERS'])],
      texts: [{ text: 'CONT. ON PID-1002', layer: 'T', x: 102, y: 2 }],
    });
    const two = line({
      tableId: 't2',
      title: 'PID-1002',
      texts: [{ text: 'CONT. FROM PID-1001', layer: 'T', x: -2, y: 2 }],
    });
    const r = traceCircuit(C, [one, two]);
    expect(r.links.find((l) => l.basis === 'label')).toMatchObject({
      from: { sheet: 'PID-1001', node: 2 },
      to: { sheet: 'PID-1002', node: 1 },
      guessed: true,
    });
  });

  it('an end missing from a capped Nodes tab is unknown, never placed at (0,0) (LOW)', () => {
    const r = traceCircuit(C, [
      sheet({
        segments: [sg(M, 'A', 500, 500, 600, 500, 1, 2)],
        nodes: [nd(1, 500, 500, 1, 'end', [M])],
        texts: [{ text: 'E-101', layer: 'T', x: 0, y: 0 }],
      }),
    ]);
    const end = r.sheets[0]!.runs[0]!.ends.find((e) => e.node === 2)!;
    expect(end.meets).toEqual({ kind: 'unknown' });
    expect([end.x, end.y]).toEqual([600, 500]);
    expect(end.equipment).toEqual([]);
    expect(r.limits.join(' ')).toMatch(/end #2 is not in the Nodes rows read/);
  });

  it('an attribute block is placed at its Inserts (WCS) point, not its OCS one (LOW)', () => {
    // A Z-mirrored insert: the Blocks tab says (-50, 2) (OCS), Inserts (50, 2).
    const r = traceCircuit(C, [
      line({
        blocks: [
          {
            block: 'LineNumber',
            layer: 'LN',
            handle: 'LM',
            x: -50,
            y: 2,
            attribs: { LINENO: '2"-P-0007' },
          },
        ],
        inserts: [
          {
            block: 'LineNumber',
            layer: 'LN',
            handle: 'LM',
            x: 50,
            y: 2,
            minX: null,
            minY: null,
            maxX: null,
            maxY: null,
          },
        ],
      }),
    ]);
    expect(r.sheets[0]!.runs[0]!.chains[0]!.lineNumbers).toEqual([
      { number: '2"-P-0007', handle: 'LM' },
    ]);
  });
});

describe('round 1: sheet links', () => {
  it('a label link matched only as "the only open end" is a guess, said everywhere (MED-3)', () => {
    const one = line({
      texts: [
        { text: 'CONT. ON PID-1002', layer: 'T', x: 102, y: 2 },
        { text: 'P-101', layer: 'T', x: -3, y: 2 },
      ],
    });
    const two = line({
      tableId: 't2',
      title: 'PID-1002',
      texts: [{ text: 'E-201', layer: 'T', x: 103, y: 1 }],
    });
    const r = traceCircuit(C, [one, two]);
    expect(r.links).toEqual([expect.objectContaining({ basis: 'label', guessed: true })]);
    expect(r.summary).toMatch(/1 sheet link \(1 guessed\)/);
    const texts = pidOf(r).offpage.map((o) => o.text);
    // Both ends stay ends, each a connector marked GUESS (the line runs
    // from its equipment, so each reads TO the other sheet).
    expect(texts).toContain('TO PID-1002 (GUESS)');
    expect(texts).toContain('TO PID-1001 (GUESS)');
  });

  it('a label naming a sheet with no end to match still gets its connector, as a guess', () => {
    const one = line({ texts: [{ text: 'CONT. ON PID-1002', layer: 'T', x: 102, y: 2 }] });
    const two = sheet({
      tableId: 't2',
      title: 'PID-1002',
      segments: [sg(M, 'B', 0, 0, 100, 0, 1, 2)],
      nodes: [
        nd(1, 0, 0, 1, 'end', [M, 'Circuit 10000-002-01']),
        nd(2, 100, 0, 1, 'end', [M, 'Circuit 10000-003-01']),
      ],
    });
    const r = traceCircuit(C, [one, two]);
    expect(r.links[0]).toMatchObject({ to: null, guessed: true, target: 'PID-1002' });
    expect(pidOf(r).offpage.map((o) => o.text)).toContain('TO PID-1002 (GUESS)');
    expect(valid(r)).toEqual([]);
  });
});

describe('round 1: the pid input always passes the template check (MED-6)', () => {
  type SetOf = {
    description: string;
    pages: { id: string; title: string; data: Pid }[];
  };
  it('25 open runs: the overview draws 20, the sheet splits into parts, nothing is cut', () => {
    const segments: SegRow[] = [];
    const nodes: NodeRow[] = [];
    for (let i = 0; i < 25; i++) {
      segments.push(sg(M, `H${i}`, 0, i * 50, 100, i * 50, 2 * i + 1, 2 * i + 2));
      nodes.push(
        nd(2 * i + 1, 0, i * 50, 1, 'end', [M]),
        nd(2 * i + 2, 100, i * 50, 1, 'end', [M]),
      );
    }
    const r = traceCircuit(C, [sheet({ segments, nodes })]);
    expect(valid(r)).toEqual([]);
    const set = r.pid as unknown as SetOf;
    expect(set.pages.map((p) => [p.id, p.title, p.data.lines.length])).toEqual([
      ['overview', 'Overview', 20],
      ['sheet-1-p1', 'PID-1001 (part 1 of 2)', 20],
      ['sheet-1-p2', 'PID-1001 (part 2 of 2)', 5],
    ]);
    for (const p of set.pages) expect(p.data.offpage.length).toBeLessThanOrEqual(20);
    expect(set.description).toMatch(
      /the overview draws 20 of 25 lines; the sheet pages draw every line/,
    );
    expect(r.limits.join(' ')).not.toMatch(/holds 20 lines|left off|cut at|no page/);
  });

  it('a long circuit name keeps the circuit id within the schema', () => {
    const name = '25000-015-01-LONGNAME-XYZ';
    const L = `Circuit ${name}`;
    const r = traceCircuit(name, [
      sheet({
        circuitLayers: [L],
        segments: [sg(L, 'A', 0, 0, 100, 0, 1, 2)],
        nodes: [nd(1, 0, 0, 1, 'end', [L]), nd(2, 100, 0, 1, 'end', [L])],
      }),
    ]);
    expect(pidOf(r).circuits[0]!.id.length).toBeLessThanOrEqual(24);
    expect(valid(r)).toEqual([]);
  });

  it('equipment past 30: the overview stops at the equipment cap, the sheet splits, nothing is cut', () => {
    const segments: SegRow[] = [];
    const nodes: NodeRow[] = [];
    const texts: { text: string; layer: string; x: number; y: number }[] = [];
    for (let i = 0; i < 20; i++) {
      segments.push(sg(M, `H${i}`, 0, i * 50, 100, i * 50, 2 * i + 1, 2 * i + 2));
      nodes.push(
        nd(2 * i + 1, 0, i * 50, 1, 'end', [M]),
        nd(2 * i + 2, 100, i * 50, 1, 'end', [M]),
      );
      texts.push({ text: `E-${100 + i}`, layer: 'T', x: -2, y: i * 50 });
      texts.push({ text: `P-${100 + i}`, layer: 'T', x: 102, y: i * 50 });
    }
    const r = traceCircuit(C, [sheet({ segments, nodes, texts })]);
    expect(valid(r)).toEqual([]);
    const set = r.pid as unknown as SetOf;
    // 2 pieces of equipment a line: 15 lines fill the 30 a page draws.
    expect(set.pages.map((p) => [p.title, p.data.lines.length, p.data.equipment.length])).toEqual([
      ['Overview', 15, 30],
      ['PID-1001 (part 1 of 2)', 15, 30],
      ['PID-1001 (part 2 of 2)', 5, 10],
    ]);
    expect(r.limits.join(' ')).not.toMatch(/equipment past 30|left off|no page/);
  });
});

describe('round 1: branch order along a header (MED-9)', () => {
  // The auditors' header: 400 units, seven branches to pumps, V-100 and E-999
  // at its ends.
  const header = () => {
    const segments: SegRow[] = [];
    const nodes: NodeRow[] = [nd(1, 0, 0, 1, 'end', [M]), nd(2, 400, 0, 1, 'end', [M])];
    const texts = [
      { text: 'V-100', layer: 'T', x: -2, y: 2 },
      { text: 'E-999', layer: 'T', x: 402, y: 2 },
    ];
    let id = 3;
    let prev = 1;
    let px = 0;
    [50, 100, 150, 200, 250, 300, 350].forEach((x, i) => {
      const t = id++;
      nodes.push(nd(t, x, 0, 3, 'tee', [M]));
      segments.push(sg(M, 'H', px, 0, x, 0, prev, t));
      prev = t;
      px = x;
      const e = id++;
      const dy = i % 2 ? -60 : 60;
      nodes.push(nd(e, x, dy, 1, 'end', [M]));
      segments.push(sg(M, `B${x}`, x, 0, x, dy, t, e));
      texts.push({ text: `P-${100 + x}`, layer: 'T', x: x + 1, y: dy + 1 });
    });
    segments.push(sg(M, 'H', px, 0, 400, 0, prev, 2));
    return sheet({ segments, nodes, texts });
  };

  it('the trunk runs along the header, not branch to branch, and says it is a reading', () => {
    const r = traceCircuit(C, [header()]);
    const trunk = pidOf(r).lines.find((l) => l.weight !== 'secondary')!;
    expect([trunk.from, trunk.to]).toEqual(['V-100', 'E-999']);
    expect(r.guesses.join(' ')).toMatch(/straightest through its tees/);
    expect(valid(r)).toEqual([]);
  });

  it('each tee carries its place along the parent, in the drawing’s order', () => {
    const p = pidOf(traceCircuit(C, [header()]));
    const at = p.tees.map((t) => t.at!);
    expect(at).toEqual([0.13, 0.25, 0.38, 0.5, 0.63, 0.75, 0.88]);
    // The branch to P-150 (x = 50) hangs on the first tee, P-450 on the last.
    const branchTo = (eq: string) => p.lines.find((l) => l.to === eq)!.from;
    expect(branchTo('P-150')).toBe(p.tees[0]!.id);
    expect(branchTo('P-450')).toBe(p.tees[6]!.id);
  });
});

describe('the drawing set: past the budget it splits, never cuts', () => {
  type SetOf = { pages: { id: string; title: string; data: Pid }[] };
  /** V-100 to E-999 along a header of `stretches` pieces, a gate valve in
   *  each and a tee between them; off each tee `dl` deadlegs side by side
   *  (stubs on the deadleg layer). */
  const valvedHeader = (stretches: number, dl: number) => {
    const DLL = `${M}-DL`;
    const segments: SegRow[] = [];
    const nodes: NodeRow[] = [];
    const inserts: SheetInput['inserts'] = [];
    let id = 1;
    const at = (x: number, y: number, kind: string, deg = 1, layers = [M], block = '', bh = '') => {
      nodes.push(nd(id, x, y, deg, kind, layers, block, bh));
      return id++;
    };
    let prev = at(0, 0, 'end');
    for (let i = 0; i < stretches; i++) {
      const x = i * 100;
      const v1 = at(x + 40, 0, 'block', 1, [M], 'GATE_VALVE', `V${i}`);
      const v2 = at(x + 44, 0, 'block', 1, [M], 'GATE_VALVE', `V${i}`);
      inserts.push({
        block: 'GATE_VALVE',
        layer: 'VALVES',
        handle: `V${i}`,
        x: x + 42,
        y: 0,
        minX: x + 40,
        minY: -2,
        maxX: x + 44,
        maxY: 2,
      });
      segments.push(sg(M, `H${i}a`, x, 0, x + 40, 0, prev, v1));
      const last = i === stretches - 1;
      const t = at(x + 100, 0, last ? 'end' : 'tee', last ? 1 : 2 + dl, last ? [M] : [M, DLL]);
      segments.push(sg(M, `H${i}b`, x + 44, 0, x + 100, 0, v2, t));
      prev = t;
      if (last) break;
      for (let k = 0; k < dl; k++) {
        const e = at(x + 100 + k * 3, 30 + k * 5, 'end', 1, [DLL]);
        segments.push(sg(DLL, `D${i}-${k}`, x + 100, 0, x + 100 + k * 3, 30 + k * 5, t, e));
      }
    }
    return sheet({
      circuitLayers: [M, DLL],
      segments,
      nodes,
      inserts,
      texts: [
        { text: 'V-100', layer: 'T', x: -2, y: 2 },
        { text: 'E-999', layer: 'T', x: stretches * 100 + 2, y: 2 },
      ],
    });
  };
  const owned = (set: SetOf) => set.pages.slice(1);

  it('a line with more valves than one drawn line holds goes on through a CONTINUES pair', () => {
    const r = traceCircuit(C, [valvedHeader(9, 1)]);
    const v = validate('pid', r.pid);
    expect(v.ok ? [] : v.errors).toEqual([]);
    const set = r.pid as unknown as SetOf;
    // The overview draws six of the nine valves and its marker counts the rest.
    const ov = set.pages[0]!.data;
    expect(ov.lines[0]!.inline).toHaveLength(6);
    expect(ov.lines[0]!.more).toMatchObject({ text: '+3 VALVES', link: 'sheet-1' });
    // The sheet page holds all nine: six on one line, three on the next,
    // joined by a pair of connectors that link to each other.
    const sheetLines = set.pages[1]!.data.lines.filter((l) => !l.deadleg);
    expect(sheetLines.map((l) => (l.inline as unknown[]).length)).toEqual([6, 3]);
    const pair = set.pages[1]!.data.offpage as { text?: string; link?: string; focus?: string }[];
    expect(pair.map((o) => [o.text, o.link, o.focus])).toEqual([
      ['CONTINUES', 'sheet-1', sheetLines[1]!.id],
      ['CONTINUED', 'sheet-1', sheetLines[0]!.id],
    ]);
    expect(r.limits.join(' ')).not.toMatch(/past six|left off|no page/);
  });

  it('a long sheet name keeps every page title within the template', () => {
    const s = valvedHeader(6, 7);
    s.title = `PID-${'X'.repeat(80)}`;
    const r = traceCircuit(C, [s]);
    const v = validate('pid', r.pid);
    expect(v.ok ? [] : v.errors).toEqual([]);
    const set = r.pid as unknown as SetOf;
    expect(set.pages.length).toBeGreaterThan(2);
    for (const p of set.pages) expect(p.title.length).toBeLessThanOrEqual(60);
  });

  it('a busy sheet: every deadleg on exactly one page, each page in budget, the set valid', () => {
    const r = traceCircuit(C, [valvedHeader(6, 7)]);
    const v = validate('pid', r.pid);
    expect(v.ok ? [] : v.errors).toEqual([]);
    const set = r.pid as unknown as SetOf;
    for (const p of set.pages) {
      expect(p.data.lines.length, p.id).toBeLessThanOrEqual(20);
      expect(p.data.offpage.length, p.id).toBeLessThanOrEqual(20);
    }
    // 5 tees, 7 deadlegs each: 35, each drawn as a deadleg once on a page
    // that owns it (a detail page draws its parent again, never a deadleg).
    const dls = owned(set).flatMap((p) => p.data.lines.filter((l) => l.deadleg === true));
    expect(dls).toHaveLength(35);
    expect(
      new Set(
        owned(set).flatMap((p) =>
          p.data.lines.filter((l) => l.deadleg).map((l) => `${p.id}:${l.id}`),
        ),
      ).size,
    ).toBe(35);
    expect(r.limits.join(' ')).not.toMatch(/left off|no page|cut at/);
    // Every detail page is reached by a link (a sheet page by its button).
    const linked = new Set(
      set.pages.flatMap((p) => [
        ...p.data.lines.map((l) => (l.more as { link?: string } | undefined)?.link),
        ...(p.data.offpage as { link?: string }[]).map((o) => o.link),
      ]),
    );
    const details = set.pages.filter((p) => /^sheet-\d+-\d+$/.test(p.id));
    expect(details.length).toBeGreaterThan(0);
    for (const p of details) expect(linked.has(p.id), p.id).toBe(true);
    // The set draws, and its export is static.
    const drawn = render('pid', r.pid, estimateMeasurer);
    expect(drawn.ok).toBe(true);
    expect(drawn.ok && checkStaticSvg(drawn.svg)).toEqual([]);
  });
});
