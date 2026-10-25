/**
 * circuit_trace honesty: an inference never reaches the result or the
 * drawing as fact. Made-up drawings (every tag, number and sheet name here
 * is invented), one per audit probe:
 *
 *   P1   a vessel on the PROCESS layer: no join runs round its outline
 *   P5a  a stretch carrying another line number: never joined through
 *        (and a process join that is made is said as an inferred join)
 *   P6   a deadleg piece joined to a main piece stays a deadleg
 *   P7   a tag past the near distance is an unconfirmed end, not equipment
 *   P9   a certain link needs the line number on both ends' own chains
 *   P11  a process circuit's branches are never called utility lines
 *
 * and the reads: a sheet with the circuit but nothing to draw is listed, an
 * older table without the Part column still reads, pages are stable and
 * exactly N rows is not "more than N". Then the second audit's probes:
 * MED-A (a line number across an inferred join), MED-B (no main line
 * through a deadleg), MED-C (a tall single-tag outline), L1 to L5 and the
 * register caps.
 */
import { describe, expect, it } from 'vitest';
import { estimateMeasurer, render, validate } from '@mantle/diagram-templates';
import type { WorkbookTabRef } from '@mantle/tabledb';
import { overviewOf } from './fixtures';
import { readSheet } from './read';
import { MAX_DISCREPANCIES, traceCircuit } from './walk';
import type { BlockRow, NodeRow, SegRow, SheetInput, TextRow } from './walk';

const C = '40000-001-01';
const M = `Circuit ${C}`;
const DL = `Circuit ${C}-DL`;
const PIPE = 'PROCESS';

const sg = (
  layer: string,
  handle: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  n1: number,
  n2: number,
  part = 0,
): SegRow => ({
  layer,
  handle,
  x1,
  y1,
  x2,
  y2,
  length: Math.hypot(x2 - x1, y2 - y1),
  n1,
  n2,
  part,
});

/** Nodes for every end point, degree and layers counted over all pieces. */
function nodesOf(segs: SegRow[]): NodeRow[] {
  const at = new Map<number, NodeRow>();
  for (const g of segs) {
    for (const [n, x, y] of [
      [g.n1, g.x1, g.y1],
      [g.n2, g.x2, g.y2],
    ] as const) {
      const row = at.get(n) ?? {
        id: n,
        x,
        y,
        degree: 0,
        kind: 'end',
        block: '',
        blockHandle: '',
        layers: [],
      };
      row.degree += 1;
      if (!row.layers.includes(g.layer)) row.layers.push(g.layer);
      at.set(n, row);
    }
  }
  for (const r of at.values()) r.kind = r.degree === 1 ? 'end' : r.degree === 2 ? 'joint' : 'tee';
  return [...at.values()];
}

const lineNo = (
  handle: string,
  x: number,
  y: number,
  number: string,
  circuit?: string,
): BlockRow => ({
  block: 'LineNumber',
  layer: 'LINENO',
  handle,
  x,
  y,
  attribs: { LINENO: number, ...(circuit ? { CIRCUIT: circuit } : {}) },
});

function sheet(
  title: string,
  segments: SegRow[],
  network: SegRow[],
  texts: TextRow[] = [],
  blocks: BlockRow[] = [],
): SheetInput {
  return {
    tableId: `t-${title}`,
    title,
    sourceFileId: null,
    circuitLayers: [...new Set(segments.map((g) => g.layer))],
    circuitRows: [],
    segments,
    nodes: nodesOf([...segments, ...network]),
    inserts: [],
    texts,
    blocks,
    // An extent of 200: joins up to 30 units, outlines up to 32 across.
    near: 2,
    network,
    limits: [],
  };
}

type Pid = {
  description: string;
  equipment: { id: string }[];
  offpage: { text?: string; direction?: string; link?: string; focus?: string }[];
  lines: Record<string, unknown>[];
};
type SetOf = { pages: { id: string; title: string; data: Pid }[] };

/** Two pieces either side of a vessel at x 20..30 drawn on PROCESS. */
function vesselSheet(closed: boolean): SheetInput {
  const segments = [sg(M, 'A', 0, 0, 20, 0, 1, 2), sg(M, 'B', 30, 0, 50, 0, 3, 4)];
  const corners: [number, number, number][] = [
    [10, 20, -5],
    [11, 30, -5],
    [12, 30, 5],
    [13, 20, 5],
  ];
  // The outline, each side split where a pipe meets it (2 on the left, 3
  // on the right): one closed polyline (handle V, parts 0..3) or four LINEs.
  const sides: [number, number, number?][] = [
    [10, 11],
    [11, 12, 3],
    [12, 13],
    [13, 10, 2],
  ];
  const pt = (n: number) =>
    n === 2 ? [20, 0] : n === 3 ? [30, 0] : corners.find((c) => c[0] === n)!.slice(1);
  const vessel: SegRow[] = [];
  sides.forEach(([a, b, split], i) => {
    const h = closed ? 'V' : `V${i}`;
    const legs = split
      ? [
          [a, split],
          [split, b],
        ]
      : [[a, b]];
    for (const [u, v] of legs) {
      const [x1, y1] = pt(u!);
      const [x2, y2] = pt(v!);
      vessel.push(sg(PIPE, h, x1!, y1!, x2!, y2!, u!, v!, i));
    }
  });
  return sheet(
    'PID-9101',
    segments,
    [sg(PIPE, 'pA', 0, 0, 20, 0, 1, 2), sg(PIPE, 'pB', 30, 0, 50, 0, 3, 4), ...vessel],
    [{ text: 'V-101', layer: 'EQUIP', x: 25, y: 0 }],
  );
}

describe('P1: never joined round a vessel drawn on a pipe layer', () => {
  for (const closed of [true, false]) {
    it(`a vessel drawn as ${closed ? 'one closed polyline' : 'four LINEs'}: two runs, each at the vessel`, () => {
      const r = traceCircuit(C, [vesselSheet(closed)]);
      const s = r.sheets[0]!;
      expect(s.joins).toEqual([]);
      expect(s.runs).toHaveLength(2);
      const ends = s.runs.flatMap((x) => x.ends);
      expect(ends.find((e) => e.node === 2)!.equipment).toEqual(['V-101']);
      expect(ends.find((e) => e.node === 3)!.equipment).toEqual(['V-101']);
    });
  }
});

/** A stretch of process line between two pieces, a line-number block on it. */
function gapSheet(onGap: string): SheetInput {
  return sheet(
    'PID-9201',
    [sg(M, 'A', 0, 0, 20, 0, 1, 2), sg(M, 'B', 30, 0, 50, 0, 3, 4)],
    [
      sg(PIPE, 'pA', 0, 0, 20, 0, 1, 2),
      sg(PIPE, 'pGap', 20, 0, 30, 0, 2, 3),
      sg(PIPE, 'pB', 30, 0, 50, 0, 3, 4),
    ],
    [],
    [lineNo('LA', 10, 1, 'N100-1'), lineNo('LG', 25, 1, onGap)],
  );
}

describe('P5a: a process join is an inference, and never across another line number', () => {
  it('a stretch labelled with another line number (no CIRCUIT attribute) is not joined', () => {
    const s = traceCircuit(C, [gapSheet('N200-1')]).sheets[0]!;
    expect(s.joins).toEqual([]);
    expect(s.runs).toHaveLength(2);
  });

  it('labelled with its own number it is joined, said as an inferred join and marked GUESS', () => {
    const r = traceCircuit(C, [gapSheet('N100-1')]);
    const s = r.sheets[0]!;
    expect(s.joins).toEqual([
      expect.objectContaining({ kind: 'process', inferred: true, length: 10, handles: ['pGap'] }),
    ]);
    expect(r.guesses.join(' ')).toMatch(
      /pieces #2 and #3 of the circuit are joined through 1 process-line segment on PROCESS, 10 drawing units \(handles pGap\): an inferred join/,
    );
    const pid = overviewOf(r.pid) as Pid;
    expect(pid.lines.filter((l) => l.note === 'INFERRED JOIN (GUESS)')).toHaveLength(1);
    expect(validate('pid', pid).ok).toBe(true);
    const svg = render('pid', pid, estimateMeasurer);
    expect(svg.ok && svg.svg).toContain('INFERRED JOIN (GUESS)');
  });
});

describe('P6: a join never changes a piece role', () => {
  // E-101 1 ══ main ══ 2 ·· process join ·· 3 ── deadleg ── 4 V-201
  const s = () =>
    sheet(
      'PID-9301',
      [sg(M, 'A', 0, 0, 20, 0, 1, 2), sg(DL, 'D', 22, 0, 40, 0, 3, 4)],
      [
        sg(PIPE, 'pA', 0, 0, 20, 0, 1, 2),
        sg(PIPE, 'pGap', 20, 0, 22, 0, 2, 3),
        sg(PIPE, 'pD', 22, 0, 40, 0, 3, 4),
      ],
      [
        { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
        { text: 'V-201', layer: 'EQUIP', x: 41, y: 0 },
        { text: 'CONT. ON PID-9302', layer: 'TEXT', x: 40, y: 1 },
      ],
    );

  it('the deadleg piece stays a deadleg chain; its end is a deadleg end', () => {
    const r = traceCircuit(C, [s()]);
    const run = r.sheets[0]!.runs[0]!;
    expect(r.sheets[0]!.runs).toHaveLength(1);
    expect(run.chains.find((c) => c.handles.includes('A'))!.role).toBe('main');
    expect(run.chains.find((c) => c.handles.includes('D'))!.role).toBe('deadleg');
    expect(run.ends.find((e) => e.node === 4)!.deadleg).toBe(true);
    expect(run.ends.find((e) => e.node === 1)!.deadleg).toBe(false);
  });

  it('its end is never a main-line end nor a sheet link', () => {
    const other = sheet(
      'PID-9302',
      [sg(M, 'X', 0, 0, 30, 0, 1, 2)],
      [],
      [{ text: 'CONT. FROM PID-9301', layer: 'TEXT', x: -1, y: 1 }],
    );
    const r = traceCircuit(C, [s(), other]);
    expect(r.links.some((l) => l.from.node === 4 || l.to?.node === 4)).toBe(false);
    expect((overviewOf(r.pid) as Pid).description).toMatch(/no main line/);
  });
});

describe('P7: a tag past the near distance is a reading, never equipment', () => {
  // E-101 sits by end 1 (1 unit); V-201 is 5 units past end 2 (near is 2).
  const s = () =>
    sheet(
      'PID-9401',
      [sg(M, 'A', 0, 0, 20, 0, 1, 2)],
      [],
      [
        { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
        { text: 'V-201', layer: 'EQUIP', x: 25, y: 0 },
      ],
    );

  it('an unconfirmed end, said in guesses, drawn as a marked connector', () => {
    const r = traceCircuit(C, [s()]);
    const end = r.sheets[0]!.runs[0]!.ends.find((e) => e.node === 2)!;
    expect(end.equipment).toEqual([]);
    expect(end.equipmentUnconfirmed).toBe('V-201');
    expect(r.guesses.join(' ')).toMatch(
      /end #2 meets nothing drawn; the nearest equipment tag V-201/,
    );
    const pid = overviewOf(r.pid) as Pid;
    expect(pid.equipment.map((e) => e.id)).toEqual(['E-101']);
    expect(pid.offpage.map((o) => o.text)).toContain('NEAR V-201 (GUESS)');
    expect(pid.description).toMatch(/no main line/);
  });

  it("the register's to confirms it: then the main line ends there", () => {
    const r = traceCircuit(C, [s()], { from: 'E-101', to: 'V-201' });
    const pid = overviewOf(r.pid) as Pid;
    expect(pid.equipment.map((e) => e.id).sort()).toEqual(['E-101', 'V-201']);
    expect(pid.lines[0]).toMatchObject({ from: 'E-101', to: 'V-201' });
  });
});

describe('P9: a certain link needs the line number on both ends own chains', () => {
  // PID-9501: 1 ══ 2 (tee) ══ 3 "CONT. ON PID-9502", a branch 2 ── 4.
  // N300 sits on 1-2 only; 2-3 inherits it.
  const s1 = (onEndChain: boolean) =>
    sheet(
      'PID-9501',
      [
        sg(M, 'A', 0, 0, 20, 0, 1, 2),
        sg(M, 'B', 20, 0, 40, 0, 2, 3),
        sg(M, 'T', 20, 0, 20, 20, 2, 4),
      ],
      [],
      [{ text: 'CONT. ON PID-9502', layer: 'TEXT', x: 41, y: 1 }],
      [lineNo('L1', 10, 1, 'N300-2', C), ...(onEndChain ? [lineNo('L2', 30, 1, 'N300-2', C)] : [])],
    );
  const s2 = () =>
    sheet(
      'PID-9502',
      [sg(M, 'X', 0, 0, 30, 0, 1, 2)],
      [],
      [{ text: 'CONT. FROM PID-9501', layer: 'TEXT', x: -1, y: 1 }],
      [lineNo('L3', 15, 1, 'N300-2', C)],
    );

  it('inherited from further along the run: a guess', () => {
    const r = traceCircuit(C, [s1(false), s2()]);
    const l = r.links.find((x) => x.from.node === 3 || x.to?.node === 3)!;
    expect(l).toMatchObject({ basis: 'label', guessed: true });
    expect(l.note).toMatch(/not on both ends' own chains/);
  });

  it('on both ends own chains, with labels naming each other: certain', () => {
    const r = traceCircuit(C, [s1(true), s2()]);
    expect(r.links.find((x) => x.from.node === 3)).toMatchObject({
      to: { sheet: 'PID-9502', node: 1 },
      basis: 'label',
      guessed: false,
    });
  });
});

describe('P11: the branches of a process circuit are process lines', () => {
  it('the legend names them as the circuit lines, never utility lines', () => {
    const r = traceCircuit(C, [
      sheet(
        'PID-9601',
        [
          sg(M, 'A', 0, 0, 20, 0, 1, 2),
          sg(M, 'B', 20, 0, 40, 0, 2, 3),
          sg(DL, 'T', 20, 0, 20, 15, 2, 4),
        ],
        [],
        [
          { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
          { text: 'V-201', layer: 'EQUIP', x: 41, y: 0 },
        ],
      ),
    ]);
    const pid = overviewOf(r.pid) as Pid & { legendNames: Record<string, string> };
    expect(pid.lines.some((l) => l.weight === 'secondary')).toBe(true);
    const out = render('pid', r.pid, estimateMeasurer);
    expect(out.ok).toBe(true);
    const svg = out.ok ? out.svg : '';
    expect(svg).toMatch(/Process branch or deadleg/i);
    expect(svg).toMatch(/Main process line/i);
    expect(svg).not.toMatch(/Utility line/i);
  });
});

describe('the main line: ties and the register', () => {
  // Two separate runs of the same length, each between two pieces of equipment.
  const twin = () =>
    sheet(
      'PID-9701',
      [sg(M, 'A', 0, 0, 20, 0, 1, 2), sg(M, 'B', 0, 50, 20, 50, 3, 4)],
      [],
      [
        { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
        { text: 'V-101', layer: 'EQUIP', x: 21, y: 0 },
        { text: 'E-102', layer: 'EQUIP', x: -1, y: 50 },
        { text: 'V-102', layer: 'EQUIP', x: 21, y: 50 },
      ],
    );

  it('a tie between two pairs is said', () => {
    const r = traceCircuit(C, [twin()]);
    expect(r.guesses.join(' ')).toMatch(/a tie, broken by the order/);
  });

  it("the register's from and to with no path between them: a limit", () => {
    const r = traceCircuit(C, [twin()], { from: 'E-101', to: 'V-102' });
    expect(r.limits.join(' ')).toMatch(/no path that keeps off deadlegs joins them/);
    expect((overviewOf(r.pid) as Pid).description).toMatch(/no main line/);
  });

  it("the register's text echoed in limits is cut short", () => {
    const long = `Z-${'9'.repeat(300)}`;
    const r = traceCircuit(C, [twin()], { from: long });
    const l = r.limits.find((x) => x.includes("register's circuit from"))!;
    expect(l).toBeDefined();
    expect(l.length).toBeLessThan(200);
  });
});

/* ------------------------------------------------------------------ reads */

type Tab = { name: string; columns: string[]; rows: unknown[][] };

/** A fake table_sql over in-memory tabs: honours the FROM tab and the last
 *  LIMIT/OFFSET, and throws on a column the tab has not got (as SQLite does). */
function fakeTables(tabs: Tab[], log: string[] = []) {
  const refs = tabs.map(
    (t) =>
      ({
        tabId: t.name,
        name: t.name,
        viewName: t.name,
        physicalTable: t.name,
        ftsTable: null,
        rowCount: t.rows.length,
        columns: t.columns.map((c) => ({ colId: c, name: c, physical: c, type: 'text' })),
      }) as unknown as WorkbookTabRef,
  );
  const run = async (_abs: string, q: string) => {
    log.push(q);
    const from = /FROM "([^"]+)"/.exec(q)?.[1];
    const tab = tabs.find((t) => t.name === from);
    if (!tab) throw new Error(`no such table: ${from}`);
    for (const m of q.matchAll(/"([^"]+)"/g)) {
      const name = m[1]!;
      if (
        name !== tab.name &&
        name !== '_rid' &&
        !tab.columns.includes(name) &&
        !tabs.some((t) => t.name === name)
      )
        throw new Error(`no such column: ${name}`);
    }
    let rows = tab.rows;
    // The circuit's own segments, or every other layer's (the network).
    if (tab.name === 'Segments')
      rows = /NOT IN/.test(q)
        ? rows.filter((r) => !String(r[0]).startsWith('Circuit'))
        : rows.filter((r) => String(r[0]).startsWith('Circuit'));
    const lim = /LIMIT (\d+) OFFSET (\d+)\s*$/.exec(q);
    if (lim) rows = rows.slice(Number(lim[2]), Number(lim[2]) + Number(lim[1]));
    return { columns: tab.columns, rows, truncated: false } as never;
  };
  return { surface: async () => ({ abs: '/fake', tabs: refs }), run };
}

const SEG_COLS = ['Layer', 'Handle', 'X1', 'Y1', 'X2', 'Y2', 'Length', 'Node 1', 'Node 2'];
const NODE_COLS = ['Node', 'X', 'Y', 'Degree', 'Kind', 'Block', 'Block handle', 'Layers'];
const table = {
  id: 'tbl-1',
  title: 'PID-9801',
  description: 'AutoCAD DWG model-space registry ... within 2 drawing units of it ... (test)',
  sourceFileId: null,
};
const plainSheet = (extra: Tab[] = [], segCols = SEG_COLS) => [
  { name: 'Layers', columns: ['Layer', 'Entities'], rows: [[M, 1]] },
  {
    name: 'Segments',
    columns: segCols,
    rows: [
      [M, 'H1', 0, 0, 10, 0, 10, 1, 2, ...(segCols.includes('Part') ? [0] : [])],
      ['PROCESS', 'P1', 10, 0, 20, 0, 10, 2, 3, ...(segCols.includes('Part') ? [0] : [])],
    ],
  },
  {
    name: 'Nodes',
    columns: NODE_COLS,
    rows: [
      [1, 0, 0, 1, 'end', '', '', M],
      [2, 10, 0, 2, 'joint', '', '', `${M}; PROCESS`],
    ],
  },
  ...extra,
];

describe('a sheet with the circuit is always listed', () => {
  it('one segment, two plain ends, no equipment, a Segments tab with no Part column', async () => {
    const r = await readSheet('owner', table, C, fakeTables(plainSheet()));
    expect(r.kind).toBe('sheet');
    if (r.kind !== 'sheet') return;
    expect(r.sheet.segments).toHaveLength(1);
    expect((r.sheet.network ?? []).map((g) => g.handle)).toEqual(['P1']);
    const t = traceCircuit(C, [r.sheet]);
    expect(t.sheets.map((s) => s.title)).toEqual(['PID-9801']);
    expect((overviewOf(t.pid) as Pid).equipment).toEqual([]);
  });

  it('a neighbourhood tab that cannot be read is a limit, not a missing sheet', async () => {
    const r = await readSheet(
      'owner',
      table,
      C,
      fakeTables(plainSheet([{ name: 'Texts', columns: ['Text', 'Layer'], rows: [] }])),
    );
    expect(r.kind).toBe('sheet');
    if (r.kind !== 'sheet') return;
    expect(r.sheet.limits.join(' ')).toMatch(
      /the labels around the circuit \(Texts\) could not be read/,
    );
    expect(traceCircuit(C, [r.sheet]).sheets).toHaveLength(1);
  });

  it('a sheet named for the circuit with no segment read is listed too', () => {
    const t = traceCircuit(C, [{ ...sheet('PID-9802', [], []), circuitLayers: [M] }]);
    expect(t.sheets.map((s) => s.title)).toEqual(['PID-9802']);
    expect(t.limits.join(' ')).toMatch(/no segment on its layers was read/);
  });
});

describe('paged reads', () => {
  const texts = (n: number): Tab => ({
    name: 'Texts',
    columns: ['Text', 'Layer', 'X', 'Y'],
    rows: Array.from({ length: n }, (_, i) => [`T${i}`, 'TEXT', 1, 1]),
  });

  it('exactly the cap is not "more than"; one more is', async () => {
    const at = async (n: number) => {
      const r = await readSheet('owner', table, C, fakeTables(plainSheet([texts(n)])));
      return r.kind === 'sheet' ? r.sheet : null;
    };
    const exact = (await at(3000))!;
    expect(exact.texts).toHaveLength(3000);
    expect(exact.limits.join(' ')).not.toMatch(/more than 3000 labels/);
    expect((await at(3001))!.limits.join(' ')).toMatch(/more than 3000 labels/);
  });

  it('every page is in a stable order', async () => {
    const log: string[] = [];
    await readSheet('owner', table, C, fakeTables(plainSheet([texts(5)]), log));
    const pages = log.filter((q) => /LIMIT \d+ OFFSET \d+$/.test(q));
    expect(pages.length).toBeGreaterThan(0);
    for (const q of pages) expect(q).toMatch(/ORDER BY "_rid" LIMIT/);
  });
});

/* ------------------------------------------------- re-audit (round two) */

const under = (segs: SegRow[]) => segs.map((g) => ({ ...g, layer: PIPE, handle: `p${g.handle}` }));
const chainsOf = (r: ReturnType<typeof traceCircuit>) =>
  r.sheets.flatMap((s) => s.runs.flatMap((x) => x.chains));

describe('MED-A: a line number across an inferred join is not the end’s own', () => {
  // PID-9511: A (N300-2 on it) and B joined through 10 units of PROCESS
  // (an inferred join); B ends at "CONT. ON PID-9512", whose end names it back
  // and carries N300-2 too. Only the inferred join ties N300-2 to B's end.
  const s1 = () => {
    const segs = [sg(M, 'A', 0, 0, 20, 0, 1, 2), sg(M, 'B', 30, 0, 50, 0, 3, 4)];
    return sheet(
      'PID-9511',
      segs,
      [...under(segs), sg(PIPE, 'gap', 20, 0, 30, 0, 2, 3)],
      [
        { text: 'CONT. ON PID-9512', layer: 'T', x: 51, y: 1 },
        { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
      ],
      [lineNo('L1', 10, 1, 'N300-2', C)],
    );
  };
  const s2 = () =>
    sheet(
      'PID-9512',
      [sg(M, 'X', 0, 0, 30, 0, 1, 2)],
      [],
      [{ text: 'CONT. FROM PID-9511', layer: 'T', x: -1, y: 1 }],
      [lineNo('L3', 15, 1, 'N300-2', C)],
    );

  it('the link is a guess, and says the inferred join is why', () => {
    const r = traceCircuit(C, [s1(), s2()]);
    expect(r.sheets[0]!.joins.map((j) => j.kind)).toEqual(['process']);
    expect(r.links).toHaveLength(1);
    expect(r.links[0]!.guessed).toBe(true);
    expect(r.links[0]!.note).toMatch(/runs through an inferred join/);
  });
});

describe('MED-B: the main line never runs through a deadleg chain', () => {
  const tags = [
    { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
    { text: 'E-201', layer: 'EQUIP', x: 71, y: 0 },
  ];
  // main A, inferred join, deadleg D, inferred join, main B.
  const joined = () => {
    const segs = [
      sg(M, 'A', 0, 0, 20, 0, 1, 2),
      sg(DL, 'D', 25, 0, 45, 0, 3, 4),
      sg(M, 'B', 50, 0, 70, 0, 5, 6),
    ];
    return sheet(
      'PID-9521',
      segs,
      [...under(segs), sg(PIPE, 'g1', 20, 0, 25, 0, 2, 3), sg(PIPE, 'g2', 45, 0, 50, 0, 4, 5)],
      tags,
    );
  };
  // The same with the pieces sharing their nodes (drawn fact, no join).
  const shared = () => {
    const segs = [
      sg(M, 'A', 0, 0, 20, 0, 1, 2),
      sg(DL, 'D', 20, 0, 45, 0, 2, 3),
      sg(M, 'B', 45, 0, 70, 0, 3, 4),
    ];
    return sheet('PID-9522', segs, under(segs), tags);
  };

  for (const [name, s] of [
    ['joined through process lines', joined],
    ['sharing nodes', shared],
  ] as const) {
    it(`${name}: no main line, said in limits; the deadleg is drawn as a deadleg`, () => {
      const r = traceCircuit(C, [s()]);
      const pid = overviewOf(r.pid) as Pid;
      expect(pid.description).toMatch(/no main line/);
      expect(r.limits.join(' ')).toMatch(
        /E-101 and E-201 are joined only through a deadleg chain; a main line never runs through a deadleg/,
      );
      expect(r.guesses.join(' ')).not.toMatch(/on main layers/);
      // Every line carries one role: the deadleg is a line of its own.
      const dl = pid.lines.filter((l) => l.deadleg === true);
      expect(dl).toHaveLength(1);
      expect(pid.lines.filter((l) => !l.deadleg && l.weight !== 'secondary')).toEqual([]);
      expect(validate('pid', pid).ok).toBe(true);
    });
  }

  it("with the register's from and to: the limit names the deadleg", () => {
    const r = traceCircuit(C, [shared()], { from: 'E-101', to: 'E-201' });
    expect(r.limits.join(' ')).toMatch(/the only path runs through a deadleg chain/);
  });

  it('the main line sentence says what is true of it', () => {
    const segs = [sg(M, 'A', 0, 0, 20, 0, 1, 2), sg(M, 'B', 25, 0, 45, 0, 3, 4)];
    const r = traceCircuit(C, [
      sheet(
        'PID-9523',
        segs,
        [...under(segs), sg(PIPE, 'g', 20, 0, 25, 0, 2, 3)],
        [
          { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
          { text: 'E-201', layer: 'EQUIP', x: 46, y: 0 },
        ],
      ),
    ]);
    expect(r.guesses.join(' ')).toMatch(
      /never through a deadleg \(1 inferred join through process lines on it\)/,
    );
  });
});

describe('MED-C: a tall single-tag outline is one piece of equipment', () => {
  // The extent is 200 (near 2): one piece is at most 32 across. The outline
  // at x 20..30, y -22..22 is 10 by 44 (5% by 22%): wider than 32, but tall,
  // small in area and holding one tag.
  const outline = (w: number, h: number, extraTags: TextRow[] = []) => {
    const a = sg(M, 'A', 0, 0, 20, 0, 1, 2);
    const x2 = 20 + w;
    const box = [
      sg('EQUIP', 'S', 20, 0, 20, h / 2, 2, 11, 0),
      sg('EQUIP', 'S', 20, h / 2, x2, h / 2, 11, 12, 1),
      sg('EQUIP', 'S', x2, h / 2, x2, -h / 2, 12, 13, 2),
      sg('EQUIP', 'S', x2, -h / 2, 20, -h / 2, 13, 14, 3),
      sg('EQUIP', 'S', 20, -h / 2, 20, 0, 14, 2, 4),
    ];
    return sheet(
      'PID-9531',
      [a],
      [...under([a]), ...box, sg(PIPE, 'far', 150, 150, 151, 151, 98, 99)],
      [
        { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
        { text: 'E-201', layer: 'EQUIP', x: 20 + w / 2, y: 0 },
        ...extraTags,
      ],
    );
  };

  it('confirmed: the end is at E-201 and the main line runs to it', () => {
    const r = traceCircuit(C, [outline(10, 44)]);
    const end = r.sheets[0]!.runs[0]!.ends.find((e) => e.node === 2)!;
    expect(end.equipment).toEqual(['E-201']);
    expect(end.equipmentBasis).toMatch(/elongated outline/);
    expect((overviewOf(r.pid) as Pid).description).toMatch(/main line E-101 to E-201/);
  });

  it('two distinct tags inside: a cluster, only a reading', () => {
    const r = traceCircuit(C, [outline(10, 44, [{ text: 'E-202', layer: 'EQUIP', x: 25, y: 15 }])]);
    const end = r.sheets[0]!.runs[0]!.ends.find((e) => e.node === 2)!;
    expect(end.equipment).toEqual([]);
    expect(end.equipmentUnconfirmed).toBe('E-201');
  });

  it('wide and square (not elongated): only a reading', () => {
    const r = traceCircuit(C, [outline(40, 40)]);
    const end = r.sheets[0]!.runs[0]!.ends.find((e) => e.node === 2)!;
    expect(end.equipment).toEqual([]);
    expect(end.equipmentUnconfirmed).toBe('E-201');
  });
});

describe('a reading is a main-line end only across more sheets, as a guess', () => {
  // PID-9541: E-101 ══ A ══ "CONT. ON PID-9542"; PID-9542: "CONT. FROM
  // PID-9541" ══ X ══ an end 5 units short of V-201 (near is 2). N400 on both.
  const sheets = () => [
    sheet(
      'PID-9541',
      [sg(M, 'A', 0, 0, 20, 0, 1, 2)],
      [],
      [
        { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
        { text: 'CONT. ON PID-9542', layer: 'T', x: 21, y: 1 },
      ],
      [lineNo('L1', 10, 1, 'N400-1', C)],
    ),
    sheet(
      'PID-9542',
      [sg(M, 'X', 0, 0, 20, 0, 1, 2)],
      [],
      [
        { text: 'CONT. FROM PID-9541', layer: 'T', x: -1, y: 1 },
        { text: 'V-201', layer: 'EQUIP', x: 25, y: 0 },
      ],
      [lineNo('L2', 10, 1, 'N400-1', C)],
    ),
  ];

  it('drawn to a NEAR connector marked GUESS, never as the equipment, and said', () => {
    const r = traceCircuit(C, sheets());
    expect(r.links.filter((l) => !l.guessed)).toHaveLength(1);
    const pid = overviewOf(r.pid) as Pid;
    expect(pid.description).toMatch(/main line E-101 to near V-201 \(GUESS\).*across 2 sheets/);
    expect(pid.equipment.map((e) => e.id)).toEqual(['E-101']);
    expect(pid.offpage.map((o) => o.text)).toContain('NEAR V-201 (GUESS)');
    expect(r.guesses.join(' ')).toMatch(/its to end is only near V-201/);
  });

  it('the reading stays a marked guess on the sheet page that draws that end', () => {
    const r = traceCircuit(C, sheets());
    const v = validate('pid', r.pid);
    expect(v.ok ? [] : v.errors).toEqual([]);
    const set = r.pid as unknown as SetOf;
    expect(set.pages.map((p) => p.title)).toEqual(['Overview', 'PID-9541', 'PID-9542']);
    const texts = (i: number) => set.pages[i]!.data.offpage.map((o) => o.text);
    expect(texts(2)).toContain('NEAR V-201 (GUESS)');
    expect(texts(1)).not.toContain('NEAR V-201 (GUESS)');
    expect(set.pages[2]!.data.equipment.map((e) => e.id)).toEqual([]);
  });
});

describe('a drawing set marks every guess on every page that draws it', () => {
  // PID-9201: E-101 to a tee; up from it to "CONT. ON PID-9202" (the main
  // run, a certain link: labels and N100-1 on both ends' own chains); on
  // from the tee as a branch, joined through the process line (an
  // inference) to a second piece. PID-9202: on to V-201.
  //
  //            6 "CONT. ON PID-9202"
  //            |
  //   E-101 1--2--5 .. gap .. 3--4
  const two = () => {
    const one = sheet(
      'PID-9201',
      [
        sg(M, 'A', 0, 0, 20, 0, 1, 2),
        sg(M, 'T', 20, 0, 40, 0, 2, 5),
        sg(M, 'U', 20, 0, 20, 20, 2, 6),
        sg(M, 'B', 50, 0, 70, 0, 3, 4),
      ],
      [
        sg(PIPE, 'pA', 0, 0, 20, 0, 1, 2),
        sg(PIPE, 'pT', 20, 0, 40, 0, 2, 5),
        sg(PIPE, 'pU', 20, 0, 20, 20, 2, 6),
        sg(PIPE, 'pGap', 40, 0, 50, 0, 5, 3),
        sg(PIPE, 'pB', 50, 0, 70, 0, 3, 4),
      ],
      [
        { text: 'E-101', layer: 'EQUIP', x: -1, y: 0 },
        { text: 'CONT. ON PID-9202', layer: 'T', x: 21, y: 21 },
      ],
      [
        lineNo('LA', 10, 1, 'N100-1', C),
        lineNo('LU', 21, 10, 'N100-1', C),
        lineNo('LG', 45, 1, 'N100-1'),
      ],
    );
    return [
      one,
      sheet(
        'PID-9202',
        [sg(M, 'X', 0, 0, 20, 0, 1, 2)],
        [],
        [
          { text: 'CONT. FROM PID-9201', layer: 'T', x: -1, y: 1 },
          { text: 'V-201', layer: 'EQUIP', x: 21, y: 0 },
        ],
        [lineNo('LX', 10, 1, 'N100-1', C)],
      ),
    ];
  };

  it('an inferred join is marked on the overview and on its sheet page; links go both ways', () => {
    const r = traceCircuit(C, two());
    expect(r.links.filter((l) => !l.guessed)).toHaveLength(1);
    const v = validate('pid', r.pid);
    expect(v.ok ? [] : v.errors).toEqual([]);
    const set = r.pid as unknown as SetOf;
    expect(set.pages.map((p) => p.title)).toEqual(['Overview', 'PID-9201', 'PID-9202']);
    const notes = (i: number) =>
      set.pages[i]!.data.lines.filter((l) => l.note === 'INFERRED JOIN (GUESS)');
    expect(notes(0)).toHaveLength(1);
    expect(notes(1)).toHaveLength(1);
    expect(notes(2)).toHaveLength(0);
    // The sheet connectors jump to the neighbour sheet's page, to the line.
    const out = set.pages[1]!.data.offpage.find((o) => o.link)!;
    const back = set.pages[2]!.data.offpage.find((o) => o.link)!;
    expect(out).toMatchObject({ direction: 'out', text: 'TO PID-9202', link: set.pages[2]!.id });
    expect(back).toMatchObject({ direction: 'in', text: 'FROM PID-9201', link: set.pages[1]!.id });
    expect(set.pages[2]!.data.lines.map((l) => l.id)).toContain(out.focus);
    expect(set.pages[1]!.data.lines.map((l) => l.id)).toContain(back.focus);
    // The static export prints each link as the page it goes to.
    const drawn = render('pid', r.pid, estimateMeasurer);
    expect(drawn.ok && drawn.svg).toContain('SEE PAGE 3: PID-9202');
    expect(drawn.ok && drawn.svg).toContain('SEE PAGE 2: PID-9201');
    expect(
      drawn.ok && drawn.pages!.filter((p) => p.svg.includes('INFERRED JOIN (GUESS)')),
    ).toHaveLength(2);
  });

  it('a guessed link: GUESS on the connector of every page that draws the end, never a page link', () => {
    const [one, other] = two();
    one!.texts = one!.texts.filter((t) => !t.text.startsWith('CONT'));
    other!.texts = other!.texts.filter((t) => !t.text.startsWith('CONT'));
    const r = traceCircuit(C, [one!, other!]);
    const set = r.pid as unknown as SetOf;
    const v = validate('pid', r.pid);
    expect(v.ok ? [] : v.errors).toEqual([]);
    for (const p of set.pages) {
      for (const o of p.data.offpage) {
        if (/PID-920/.test(o.text ?? '')) {
          expect(o.text).toMatch(/\(GUESS\)$/);
          expect(o.link).toBeUndefined();
        }
      }
    }
    expect(
      set.pages.flatMap((p) => p.data.offpage).filter((o) => /GUESS/.test(o.text ?? '')).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('outlines on the pipe layers keep to the size and one-tag rule', () => {
  it('L1: a large closed polyline (a skid edge) is no outline and lends no tag', () => {
    const a = sg(M, 'A', -60, 50, 0, 50, 1, 2);
    const ring: [number, number, number, number, number, number][] = [
      [0, 0, 0, 50, 10, 2],
      [0, 50, 0, 120, 2, 11],
      [0, 120, 150, 120, 11, 12],
      [150, 120, 150, 0, 12, 13],
      [150, 0, 0, 0, 13, 10],
    ];
    const net = [
      ...under([a]),
      ...ring.map(([x1, y1, x2, y2, n1, n2], i) => sg(PIPE, 'SKID', x1, y1, x2, y2, n1, n2, i)),
      sg(PIPE, 'far', 300, 300, 301, 301, 98, 99),
      sg(PIPE, 'far2', -100, -100, -99, -99, 96, 97),
    ];
    const r = traceCircuit(C, [
      sheet('PID-9551', [a], net, [
        { text: 'E-101', layer: 'EQUIP', x: -61, y: 50 },
        { text: 'P-101', layer: 'EQUIP', x: 100, y: 30 },
        { text: 'E-205', layer: 'EQUIP', x: 20, y: 100 },
      ]),
    ]);
    const end = r.sheets[0]!.runs[0]!.ends.find((e) => e.node === 2)!;
    expect(end.equipment).toEqual([]);
    expect((overviewOf(r.pid) as Pid).equipment.map((e) => e.id)).toEqual(['E-101']);
  });

  it('L2: a pipe loop round a tag (a bypass the circuit is drawn over) is no outline', () => {
    const segs = [
      sg(M, 'A1', -20, 0, 0, 0, 1, 2),
      sg(M, 'A2', 0, 0, 8, 0, 2, 3),
      sg(M, 'B1', 12, 0, 24, 0, 4, 5),
      sg(M, 'B2', 24, 0, 44, 0, 5, 6),
    ];
    const net = [
      ...under(segs),
      sg(PIPE, 'gap', 8, 0, 12, 0, 3, 4),
      sg(PIPE, 'by1', 0, 0, 0, 12, 2, 7),
      sg(PIPE, 'by2', 0, 12, 24, 12, 7, 8),
      sg(PIPE, 'by3', 24, 12, 24, 0, 8, 5),
    ];
    const r = traceCircuit(C, [
      sheet('PID-9552', segs, net, [
        { text: 'E-101', layer: 'EQUIP', x: -21, y: 0 },
        { text: 'E-301', layer: 'EQUIP', x: 45, y: 0 },
        { text: 'P-101', layer: 'EQUIP', x: 12, y: 6 },
      ]),
    ]);
    const ends = r.sheets[0]!.runs.flatMap((x) => x.ends);
    expect(ends.flatMap((e) => e.equipment).sort()).toEqual(['E-101', 'E-301']);
    expect((overviewOf(r.pid) as Pid).description).toMatch(/main line E-101 to E-301/);
  });

  it('L3: a join-only chain from a main end to a deadleg is a deadleg chain', () => {
    const segs = [
      sg(M, 'A', 0, 0, 20, 0, 1, 2),
      sg(DL, 'D1', 30, -10, 30, 0, 3, 4),
      sg(DL, 'D2', 30, 0, 30, 10, 4, 5),
    ];
    const r = traceCircuit(C, [
      sheet(
        'PID-9553',
        segs,
        [...under(segs), sg(PIPE, 'gap', 20, 0, 30, 0, 2, 4)],
        [{ text: 'E-101', layer: 'EQUIP', x: -1, y: 0 }],
      ),
    ]);
    const joinOnly = chainsOf(r).find((c) => c.joins?.length && c.from === 2)!;
    expect(joinOnly.role).toBe('deadleg');
  });
});

describe('reads that come back short say so', () => {
  it('L4: a Segments tab with no Part column is a limit naming the rebuild', async () => {
    const r = await readSheet(
      'owner',
      { ...table, sourceFileId: 'file-1' },
      C,
      fakeTables(plainSheet()),
    );
    expect(r.kind).toBe('sheet');
    if (r.kind !== 'sheet') return;
    expect(r.sheet.limits.join(' ')).toMatch(/no Part column/);
    expect(r.sheet.limits.join(' ')).toMatch(/pnpm maintain dwg-reindex --file=file-1 --again/);
    const withPart = await readSheet(
      'owner',
      table,
      C,
      fakeTables(plainSheet([], [...SEG_COLS, 'Part'])),
    );
    if (withPart.kind === 'sheet')
      expect(withPart.sheet.limits.join(' ')).not.toMatch(/Part column/);
  });

  it('L5: the network failing on a later page keeps what was read and says partial', async () => {
    const base = plainSheet([], [...SEG_COLS, 'Part']);
    const seg = base.find((t) => t.name === 'Segments')!;
    for (let i = 0; i < 1200; i++)
      seg.rows.push(['PROCESS', `Q${i}`, 30 + i, 0, 31 + i, 0, 1, 1000 + i, 2000 + i, 0]);
    const fake = fakeTables(base);
    const run = async (abs: string, q: string) => {
      if (/NOT IN/.test(q) && /OFFSET 1000$/.test(q)) throw new Error('database is locked');
      return fake.run(abs, q);
    };
    const r = await readSheet('owner', table, C, { surface: fake.surface, run });
    expect(r.kind).toBe('sheet');
    if (r.kind !== 'sheet') return;
    expect(r.sheet.network).toHaveLength(1000);
    expect(r.sheet.limits.join(' ')).toMatch(
      /could only be read in part: the first 1000 segments, then a page failed/,
    );
    expect(r.sheet.limits.join(' ')).not.toMatch(/goes on without it/);
  });
});

describe('register text echoed back is capped', () => {
  it('differences past the cap are counted, missing sheets named ten at a time', () => {
    const lines = Array.from({ length: 150 }, (_, i) => ({ number: `Z${i}-${'x'.repeat(60)}` }));
    const sheets = Array.from({ length: 15 }, (_, i) => `SHEET-${i}`);
    const r = traceCircuit(C, [sheet('PID-9561', [sg(M, 'A', 0, 0, 20, 0, 1, 2)], [])], {
      source: 's'.repeat(200),
      lines,
      sheets,
    });
    expect(r.register!.discrepancies).toHaveLength(MAX_DISCREPANCIES);
    expect(r.register!.source.length).toBeLessThanOrEqual(40);
    expect(r.register!.discrepancies.every((d) => d.detail.length < 200)).toBe(true);
    const lim = r.limits.join('\n');
    expect(lim).toMatch(
      /the register differs in 165 places; the first 100 are listed, 65 more are not/,
    );
    expect(r.limits.filter((l) => /is on the register but not among/.test(l))).toHaveLength(10);
    expect(lim).toMatch(
      /5 more register sheets are not among the traced drawings \(not listed anywhere: the register's differences stop at 100 before them\)/,
    );
  });

  it('L3: the rest of the missing sheets says how many the capped differences list', () => {
    // 86 line differences, then 15 sheets (at 86..100), then the deadleg
    // count: the five sheets past the ten named sit at 96..100, four listed.
    const lines = Array.from({ length: 86 }, (_, i) => ({ number: `Z${i}` }));
    const sheets = Array.from({ length: 15 }, (_, i) => `SHEET-${i}`);
    const r = traceCircuit(C, [sheet('PID-9562', [sg(M, 'A', 0, 0, 20, 0, 1, 2)], [])], {
      lines,
      sheets,
      deadlegs: 5,
    });
    expect(r.register!.discrepancies).toHaveLength(MAX_DISCREPANCIES);
    expect(r.limits.join('\n')).toMatch(
      /5 more register sheets are not among the traced drawings \(the register's differences list 4 of them, 1 is not listed anywhere: the differences stop at 100\)/,
    );
    const all = traceCircuit(C, [sheet('PID-9563', [sg(M, 'A', 0, 0, 20, 0, 1, 2)], [])], {
      sheets,
    });
    expect(all.limits.join('\n')).toMatch(
      /5 more register sheets .*\(the register's differences list them\)/,
    );
  });
});

describe('round 3: a continuation label wins over a reading, readings ranked and said', () => {
  const T = (text: string, x: number, y: number, layer = 'EQUIP'): TextRow => ({
    text,
    layer,
    x,
    y,
  });
  // PID-9571 E-101 ══ "CONT. ON PID-9572"; PID-9572 runs on to "CONT. ON
  // PID-9573" with V-555 4.5 units off that end (near is 2); PID-9573 ends
  // at E-301. N500-1 on 9571/9572, N500-2 on 9572/9573.
  const three = (far: boolean) => [
    sheet(
      'PID-9571',
      [sg(M, 'a1', 0, 0, 80, 0, 1, 2)],
      [],
      [T('E-101', -1, 0), T('CONT. ON PID-9572', 81, 1, 'T')],
      [lineNo('L1', 60, 1, 'N500-1')],
    ),
    sheet(
      'PID-9572',
      [sg(M, 'b1', 0, 0, 60, 0, 1, 2)],
      [],
      [
        T('CONT. FROM PID-9571', -1, 1, 'T'),
        T('CONT. ON PID-9573', 61, 1, 'T'),
        ...(far ? [T('V-555', 64, -2)] : []),
      ],
      [lineNo('L2', 20, 1, 'N500-1'), lineNo('L3', 45, 1, 'N500-2')],
    ),
    sheet(
      'PID-9573',
      [sg(M, 'c1', 0, 0, 50, 0, 1, 2)],
      [],
      [T('CONT. FROM PID-9572', -1, 1, 'T'), T('E-301', 51, 0)],
      [lineNo('L4', 20, 1, 'N500-2')],
    ),
  ];

  it('M1: a tag a few units off a labelled end takes no reading; both links stay certain', () => {
    for (const far of [false, true]) {
      const r = traceCircuit(C, three(far));
      const end = r.sheets[1]!.runs[0]!.ends.find((e) => e.node === 2)!;
      expect(end.equipmentUnconfirmed).toBeUndefined();
      expect(end.labels).toContain('CONT. ON PID-9573');
      expect(r.links.filter((l) => !l.guessed)).toHaveLength(2);
      const pid = overviewOf(r.pid) as Pid;
      expect(pid.description).toMatch(/main line E-101 to E-301, .* across 3 sheets/);
      expect(r.guesses.join(' ')).not.toMatch(/V-555/);
    }
  });

  it('M1: a label finding no end says what each end there is', () => {
    // PID-9575's one piece runs E-301 to E-302: no end is left to link.
    const r = traceCircuit(C, [
      sheet(
        'PID-9574',
        [sg(M, 'a1', 0, 0, 80, 0, 1, 2)],
        [],
        [T('E-101', -1, 0), T('CONT. ON PID-9575', 81, 1, 'T')],
      ),
      sheet(
        'PID-9575',
        [sg(M, 'b1', 0, 0, 60, 0, 1, 2)],
        [],
        [T('E-301', -1, 0), T('E-302', 61, 0)],
      ),
    ]);
    const link = r.links.find((l) => l.from.sheet === 'PID-9574')!;
    expect(link.to).toBeNull();
    expect(link.note).toBe(
      'the label names PID-9575, but no end there is matched: of its 2 ends, 2 at equipment',
    );
  });

  // PID-9576 E-101 ══ "CONT. ON PID-9577"; PID-9577 tees into two arms,
  // each ending short of a tag past the near distance.
  const tee = (up: [number, number], down: [number, number]) => [
    sheet(
      'PID-9576',
      [sg(M, 'a1', 0, 0, 80, 0, 1, 2)],
      [],
      [T('E-101', -1, 0), T('CONT. ON PID-9577', 81, 1, 'T')],
      [lineNo('L1', 60, 1, 'N600-1')],
    ),
    sheet(
      'PID-9577',
      [
        sg(M, 'b1', 0, 0, 30, 0, 1, 2),
        sg(M, 'b2', 30, 0, 30, up[0], 2, 3),
        sg(M, 'b3', 30, 0, 30, -down[0], 2, 4),
      ],
      [],
      [
        T('CONT. FROM PID-9576', -1, 1, 'T'),
        T('V-901', 30, up[0] + up[1]),
        T('V-902', 30, -down[0] - down[1]),
      ],
      [lineNo('L2', 15, 1, 'N600-1')],
    ),
  ];

  it('L1: a tie between two readings is said, never dropped', () => {
    const r = traceCircuit(C, tee([30, 4], [30, 4]));
    const g = r.guesses.find((x) => x.startsWith('the main line runs'))!;
    expect(g).toMatch(/near V-901 \(GUESS\)/);
    expect(g).toMatch(/another pair scores the same \(a tie/);
  });

  it('L1: the closer tag ranks first, before the longer arm, and the rule is said', () => {
    const r = traceCircuit(C, tee([30, 2.5], [31, 5.5]));
    const g = r.guesses.find((x) => x.startsWith('the main line runs'))!;
    expect(g).toMatch(/runs E-101 to near V-901 \(GUESS\)/);
    expect(g).not.toMatch(/a tie/);
    expect(g).toMatch(/only near V-901, 2\.5 drawing units off, past the 2 near distance/);
    expect(g).toMatch(/the one whose tag is closer to its end ranks first, before length/);
    expect(g).toMatch(
      /across 2 sheets, each once, while no path that keeps off deadlegs joins two pieces of confirmed equipment/,
    );
  });

  it('L2: a reading on a wide outline names the tags it holds', () => {
    // A 40 by 40 box (wider than one piece at 32) holding E-201 and E-202.
    const a = sg(M, 'A', 0, 0, 20, 0, 1, 2);
    const box = [
      sg('EQUIP', 'S', 20, 0, 20, 20, 2, 11, 0),
      sg('EQUIP', 'S', 20, 20, 60, 20, 11, 12, 1),
      sg('EQUIP', 'S', 60, 20, 60, -20, 12, 13, 2),
      sg('EQUIP', 'S', 60, -20, 20, -20, 13, 14, 3),
      sg('EQUIP', 'S', 20, -20, 20, 0, 14, 2, 4),
    ];
    const r = traceCircuit(C, [
      sheet(
        'PID-9578',
        [a],
        [...under([a]), ...box, sg(PIPE, 'far', 150, 150, 151, 151, 98, 99)],
        [T('E-101', -1, 0), T('E-201', 30, 0), T('E-202', 50, 10)],
      ),
    ]);
    const end = r.sheets[0]!.runs[0]!.ends.find((e) => e.node === 2)!;
    expect(end.equipmentUnconfirmed).toBe('E-201');
    expect(end.reading).toMatchObject({ kind: 'outline', count: 2, tags: ['E-201', 'E-202'] });
    expect(end.equipmentBasis).toMatch(/holds 2 equipment tags \(E-201, E-202\), E-201 nearest/);
    const g = r.guesses.join(' ');
    expect(g).toMatch(/sits on an outline holding 2 equipment tags \(E-201, E-202\)/);
    expect(g).not.toMatch(/past the near distance/);
  });
});
