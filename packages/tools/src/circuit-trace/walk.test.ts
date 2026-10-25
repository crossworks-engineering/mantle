import { describe, expect, it } from 'vitest';
import { validate } from '@mantle/diagram-templates';
import { CIRCUIT, DL, MAIN, sheetOne, sheetTwo } from './fixtures';
import { layersOf, parseCircuitLayer, parseLineNumbers, traceCircuit, valveOf } from './walk';

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
  const pid = r.pid as {
    equipment: { id: string; type: string }[];
    offpage: { id: string; direction: string; sheet: string; text?: string }[];
    lines: Record<string, unknown>[];
    tees: { id: string; on: string }[];
  };

  it('validates against the pid template', () => {
    const checked = validate('pid', pid);
    expect(checked.ok ? [] : checked.errors).toEqual([]);
  });

  it('draws the trunk from the equipment to the next sheet, the deadleg on a tee', () => {
    expect(pid.equipment).toEqual([{ id: 'E-101', type: 'shell-tube-exchanger' }]);
    const trunk = pid.lines.find((l) => l.from === 'E-101')!;
    const out = pid.offpage.find((o) => o.id === trunk.to)!;
    expect(out).toMatchObject({ direction: 'out', text: 'TO PID-1002' });
    expect(trunk.inline).toEqual([{ type: 'gate' }]);
    expect(pid.tees).toEqual([{ id: pid.tees[0]!.id, on: trunk.id }]);
    const dl = pid.lines.find((l) => l.deadleg === true)!;
    expect(dl.from).toBe(pid.tees[0]!.id);
    expect(dl.to).toBeUndefined();
    expect(dl.number).toBe('1"-P-0003-A1');
  });

  it('the second sheet comes in from the first and goes to the other circuit', () => {
    const texts = pid.offpage.map((o) => o.text);
    expect(texts).toContain('FROM PID-1001');
    expect(texts).toContain('CIRCUIT 10000-002-01');
  });

  it('a guessed link is labelled GUESS on its connector', () => {
    const one = sheetOne();
    one.texts = one.texts.filter((t) => !t.text.startsWith('CONT'));
    const two = sheetTwo();
    two.texts = [];
    const g = traceCircuit(CIRCUIT, [one, two]).pid as typeof pid;
    expect(g.offpage.some((o) => /\(GUESS\)$/.test(o.text ?? ''))).toBe(true);
    expect(validate('pid', g).ok).toBe(true);
  });

  it('an end that meets nothing starts at a connector marked OPEN END, said in limits', () => {
    const one = sheetOne();
    one.texts = [];
    const r1 = traceCircuit(CIRCUIT, [one]);
    const p = r1.pid as typeof pid;
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
