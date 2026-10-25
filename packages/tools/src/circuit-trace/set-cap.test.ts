/**
 * The drawing set at its cap (made-up drawings only): a set holds 40
 * pages, every page within the template's hard limits, and what does not
 * fit is counted in `limits`, per sheet. A circuit that fits one page is
 * one plain drawing.
 */
import { describe, expect, it } from 'vitest';
import { checkStaticSvg, estimateMeasurer, render, validate } from '@mantle/diagram-templates';
import { sheetOne, sheetTwo } from './fixtures';
import { traceCircuit, type NodeRow, type SegRow, type SheetInput } from './walk';

const C = '10000-001-01';
const M = `Circuit ${C}`;
const DLL = `${M}-DL`;
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
const nd = (id: number, x: number, y: number, degree: number, kind: string, layers: string[]) =>
  ({ id, x, y, degree, kind, block: '', blockHandle: '', layers }) satisfies NodeRow;
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
/** V-100 to E-999 along a header of `tees` stretches; off each tee but the
 *  last, `dl` deadlegs side by side. */
const header = (tees: number, dl: number, tableId = 't1', title = 'PID-1001') => {
  const segments: SegRow[] = [];
  const nodes: NodeRow[] = [];
  let id = 1;
  const at = (x: number, y: number, kind: string, deg = 1, layers = [M]) => {
    nodes.push(nd(id, x, y, deg, kind, layers));
    return id++;
  };
  let prev = at(0, 0, 'end');
  for (let i = 0; i < tees; i++) {
    const x = (i + 1) * 100;
    const last = i === tees - 1;
    const t = at(x, 0, last ? 'end' : 'tee', last ? 1 : 2 + dl, last ? [M] : [M, DLL]);
    segments.push(sg(M, `H${i}`, x - 100, 0, x, 0, prev, t));
    prev = t;
    if (last) break;
    for (let k = 0; k < dl; k++) {
      const e = at(x + k * 3, 30 + k * 5, 'end', 1, [DLL]);
      segments.push(sg(DLL, `D${i}-${k}`, x, 0, x + k * 3, 30 + k * 5, t, e));
    }
  }
  return sheet({
    tableId,
    title,
    circuitLayers: [M, DLL],
    segments,
    nodes,
    texts: [
      { text: 'V-100', layer: 'T', x: -2, y: 2 },
      { text: 'E-999', layer: 'T', x: tees * 100 + 2, y: 2 },
    ],
  });
};
/** `n` separate open runs on one sheet. */
const runs = (n: number) => {
  const segments: SegRow[] = [];
  const nodes: NodeRow[] = [];
  for (let i = 0; i < n; i++) {
    const a = 2 * i + 1;
    const b = 2 * i + 2;
    nodes.push(nd(a, 0, i * 20, 1, 'end', [M]), nd(b, 100, i * 20, 1, 'end', [M]));
    segments.push(sg(M, `S${i}`, 0, i * 20, 100, i * 20, a, b));
  }
  return sheet({ segments, nodes });
};

/** V-100 to E-999 along a header; off it `branches` branch lines, each of
 *  `sub` stretches, `dl` deadlegs off every tee on a branch but its end. */
const tree = (branches: number, sub: number, dl: number) => {
  const segments: SegRow[] = [];
  const nodes: NodeRow[] = [];
  let id = 1;
  let h = 0;
  const at = (x: number, y: number, kind: string, deg: number, layers: string[]) => {
    nodes.push(nd(id, x, y, deg, kind, layers));
    return id++;
  };
  let prev = at(0, 0, 'end', 1, [M]);
  for (let i = 0; i < branches; i++) {
    const x = (i + 1) * 1000;
    const t = at(x, 0, 'tee', 3, [M]);
    segments.push(sg(M, `H${h++}`, x - 1000, 0, x, 0, prev, t));
    prev = t;
    let bp = t;
    for (let j = 0; j < sub; j++) {
      const y = (j + 1) * 100;
      const last = j === sub - 1;
      const bt = at(x, y, last ? 'end' : 'tee', last ? 1 : 2 + dl, last ? [M] : [M, DLL]);
      segments.push(sg(M, `H${h++}`, x, y - 100, x, y, bp, bt));
      bp = bt;
      if (last) break;
      for (let k = 0; k < dl; k++) {
        const e = at(x + 30 + k * 3, y + k * 2, 'end', 1, [DLL]);
        segments.push(sg(DLL, `H${h++}`, x, y, x + 30 + k * 3, y + k * 2, bt, e));
      }
    }
  }
  const end = at((branches + 1) * 1000, 0, 'end', 1, [M]);
  segments.push(sg(M, `H${h}`, branches * 1000, 0, (branches + 1) * 1000, 0, prev, end));
  return sheet({
    circuitLayers: [M, DLL],
    segments,
    nodes,
    texts: [
      { text: 'V-100', layer: 'T', x: -2, y: 2 },
      { text: 'E-999', layer: 'T', x: (branches + 1) * 1000 + 2, y: 2 },
    ],
  });
};

type Page = {
  id: string;
  title: string;
  data: { lines: unknown[]; equipment: unknown[]; offpage: unknown[]; tees: unknown[] };
};
const pagesOf = (r: ReturnType<typeof traceCircuit>) =>
  (r.pid as unknown as { pages: Page[] }).pages;
const chainsOf = (ss: SheetInput[]) => ss.reduce((a, s) => a + s.segments.length, 0);
/** The set checks clean, holds 40 pages, and every page keeps within the
 *  template's hard limits. */
const atCap = (r: ReturnType<typeof traceCircuit>) => {
  const v = validate('pid', r.pid);
  expect(v.ok ? [] : v.errors).toEqual([]);
  const pages = pagesOf(r);
  expect(pages).toHaveLength(40);
  for (const p of pages) {
    expect(p.data.lines.length).toBeLessThanOrEqual(60);
    expect(p.data.equipment.length).toBeLessThanOrEqual(30);
    expect(p.data.offpage.length).toBeLessThanOrEqual(20);
    expect(p.data.tees.length).toBeLessThanOrEqual(30);
  }
  return pages;
};
/** The one limit that counts the chains on no page, and its count. */
const onNoPage = (r: ReturnType<typeof traceCircuit>) => {
  const said = r.limits.filter((l) => /on no page/.test(l));
  expect(said).toHaveLength(1);
  expect(said[0]).toMatch(
    /are on no page of the drawing set: a set holds at most 40 pages, each within the template's limits, and they do not fit; the trace JSON has every chain\.$/,
  );
  expect(r.limits.join(' ')).not.toMatch(/drawn over the line budget/);
  return { text: said[0]!, n: Number(/^(\d+) chains/.exec(said[0]!)?.[1]) };
};

describe('the drawing set at its 40-page cap', () => {
  it('45 sheets: the sheets past the cap are on no page, named and counted', () => {
    const ss = Array.from({ length: 45 }, (_, i) => header(3, 1, `t${i}`, `PID-${2000 + i}`));
    const r = traceCircuit(C, ss);
    const pages = atCap(r);
    const { text, n } = onNoPage(r);
    // Each sheet holds 5 chains (three header stretches, two deadlegs); the
    // overview and 39 sheet pages fill the set, 6 sheets are left.
    expect(n).toBe(30);
    expect(text).toMatch(/^30 chains of sheets PID-2039 \(5\), PID-2040 \(5\), .* and 2 more /);
    expect(pages.at(-1)!.title).toBe('PID-2038');
  });

  it('1000 separate runs on one sheet: 39 parts, the rest counted', () => {
    const r = traceCircuit(C, [runs(1000)]);
    const pages = atCap(r);
    const { text, n } = onNoPage(r);
    const drawn = pages.slice(1).reduce((a, p) => a + p.data.lines.length, 0);
    expect(n + drawn).toBe(1000);
    expect(text).toMatch(/^\d+ chains of sheet PID-1001 are on no page/);
    expect(pages[1]!.title).toBe('PID-1001 (part 1 of 39)');
  });

  it('3000 deadlegs off one line: chained detail pages, the last within the hard limits', () => {
    const ss = [header(2, 3000)];
    const r = traceCircuit(C, ss);
    const pages = atCap(r);
    const { n } = onNoPage(r);
    const sheetPages = pages.slice(1);
    // A detail page draws its line again as context: owned lines are the rest.
    const owned = sheetPages.reduce((a, p, i) => a + p.data.lines.length - (i === 0 ? 0 : 1), 0);
    // The main line is one drawn line of two chains (the header either
    // side of the tee).
    expect(n + owned).toBe(chainsOf(ss) - 1);
    // The page past the cap draws more than the budget, and says so.
    expect(Math.max(...sheetPages.map((p) => p.data.lines.length))).toBeGreaterThan(20);
    expect(r.limits.join(' ')).toMatch(
      /a drawing set holds at most 40 pages: 1 page past the cap draws more than the 20-line budget, within the template's limits \(PID-1001: line L1 \(more \d+\)\)/,
    );
  });

  it('10 tees with 300 deadlegs each: valid, counted', () => {
    const r = traceCircuit(C, [header(10, 300)]);
    atCap(r);
    expect(onNoPage(r).n).toBeGreaterThan(1500);
    const sheetPage = pagesOf(r)[1]! as unknown as { data: { description: string } };
    expect(sheetPage.data.description).toMatch(
      /chains of this sheet are on no page \(see limits\)/,
    );
    expect(sheetPage.data.description).not.toMatch(/every deadleg and valve/);
    expect((r.pid as { description: string }).description).toMatch(
      /the sheet pages draw every other line but \d+ chains on no page \(see limits\)/,
    );
  });

  it('a set past the cap still draws: every page renders static', () => {
    const r = traceCircuit(C, [header(2, 3000)]);
    const d = render('pid', r.pid, estimateMeasurer);
    expect(d.ok).toBe(true);
    if (d.ok) expect(checkStaticSvg(d.svg)).toEqual([]);
  });

  it('3000 deadlegs on one sheet split in well under 3 seconds', () => {
    // Splitting was super-linear (about 20 s here); now near linear (well
    // under half a second on a laptop). The bound is generous on purpose.
    const ss = [header(2, 3000)];
    const t = performance.now();
    traceCircuit(C, ss);
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it('8000 separate runs trace in well under 3 seconds', () => {
    // The walk grouped each run by a pass over the whole sheet, and the
    // drawing found each next start the same way (about 13 s here); now
    // near linear (under a fifth of a second on a laptop). Generous bound.
    const t = performance.now();
    traceCircuit(C, [runs(8000)]);
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it('a branchy sheet of about 17000 chains traces in well under 10 seconds', () => {
    // Each end's line numbers came from a scan of every chain of its run at
    // every step back, and each end found its chain the same way (about 25 s
    // here, cubic); now near linear (under 2 seconds on a laptop). Generous.
    const t = performance.now();
    const r = traceCircuit(C, [tree(90, 10, 20)]);
    expect(performance.now() - t).toBeLessThan(10_000);
    expect(r.sheets[0]!.runs.reduce((n, run) => n + run.chains.length, 0)).toBeGreaterThan(15_000);
  }, 60_000);
});

type Linked = {
  id: string;
  data: {
    description: string;
    lines: { id: string; more?: { link?: string; focus?: string } }[];
    offpage: { text?: string; link?: string; focus?: string }[];
  };
};
/** Every detail page is reached by a +N marker on a page that draws its
 *  line, and its SEE connectors lead to a page that draws the line (or say
 *  no other page does). */
const reachable = (r: ReturnType<typeof traceCircuit>) => {
  const pages = (r.pid as unknown as { pages: Linked[] }).pages;
  const at = new Map(pages.map((p) => [p.id, p]));
  const bad: string[] = [];
  for (const p of pages.filter((x) => /^Detail of/.test(x.data.description))) {
    const line = p.data.lines[0]!.id;
    const draws = (k: string | undefined) =>
      !!at.get(k ?? '')?.data.lines.some((l) => l.id === line);
    const inbound = pages.filter((q) =>
      q.data.lines.some((l) => l.more?.link === p.id && l.id === line),
    );
    const only = /drawn only here/.test(p.data.description);
    if (!inbound.length && !only) bad.push(`${p.id}: no marker leads here`);
    for (const o of p.data.offpage) {
      if (/^SEE /.test(o.text ?? '') && (!draws(o.link) || o.focus !== line))
        bad.push(`${p.id}: ${o.text} leads to ${o.link}, which does not draw ${line}`);
      if (o.text === 'ON NO OTHER PAGE' && !only) bad.push(`${p.id}: ON NO OTHER PAGE, not said`);
    }
  }
  return bad;
};

describe('every detail page is reached from the page that draws its line', () => {
  it('30 branches of 3 stretches, 3 deadlegs a tee: no detail page lost', () => {
    const r = traceCircuit(C, [tree(30, 3, 3)]);
    const v = validate('pid', r.pid);
    expect(v.ok ? [] : v.errors).toEqual([]);
    const pages = pagesOf(r) as unknown as Linked[];
    expect(pages.filter((p) => /^Detail of/.test(p.data.description)).length).toBeGreaterThan(30);
    expect(reachable(r)).toEqual([]);
  });

  it('past the cap too: a SEE connector names a page that draws the line', () => {
    for (const [b, s, d] of [
      [25, 2, 2],
      [40, 4, 2],
      [22, 6, 8],
      [30, 6, 8],
    ] as const) {
      const r = traceCircuit(C, [tree(b, s, d)]);
      const v = validate('pid', r.pid);
      expect(v.ok ? [] : v.errors).toEqual([]);
      expect(reachable(r), `tree ${b}x${s}x${d}`).toEqual([]);
    }
  });
});

describe('a circuit that fits one page', () => {
  it('is one plain drawing, no set around it', () => {
    const r = traceCircuit(C, [header(3, 2)]);
    const pid = r.pid as Record<string, unknown>;
    expect(pid.pages).toBeUndefined();
    expect(pid).toMatchObject({ template: 'pid', title: `Circuit ${C}` });
    expect((pid.lines as unknown[]).length).toBe(5);
    const v = validate('pid', pid);
    expect(v.ok ? [] : v.errors).toEqual([]);
    const d = render('pid', pid, estimateMeasurer);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.pages).toBeUndefined();
    expect(d.svg).not.toMatch(/PAGE 1 OF 1/i);
  });

  it('a sheet page says only the guesses drawn on it', () => {
    // Two sheets joined only by a guessed link (no continuation labels),
    // and a third on its own: only the pages that draw a guessed connector
    // say "sheet links".
    const one = sheetOne();
    one.texts = one.texts.filter((t) => !t.text.startsWith('CONT'));
    const two = sheetTwo();
    two.texts = [];
    const r = traceCircuit(C, [one, two, header(3, 1, 't3', 'PID-3003')]);
    const v = validate('pid', r.pid);
    expect(v.ok ? [] : v.errors).toEqual([]);
    const pages = pagesOf(r) as unknown as {
      id: string;
      data: { description: string; offpage: { text?: string }[] };
    }[];
    const seen = new Set<boolean>();
    for (const p of pages) {
      const guessed = p.data.offpage.some((o) => /GUESS/.test(o.text ?? ''));
      seen.add(guessed);
      expect(/sheet links/.test(p.data.description), p.id).toBe(guessed);
    }
    // Both kinds of page are in the set, so the check says something.
    expect([...seen].sort()).toEqual([false, true]);
  });
});
