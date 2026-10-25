/**
 * Tees and branches on the `pid` template: a line that leaves another line
 * mid-run (a branch), one that stops short (a stub, a cap, a dead leg), and
 * one that ends at a bubble. All tags here are made up.
 */
import { describe, expect, it } from 'vitest';
import { checkStaticSvg, estimateMeasurer, render, validate } from './index.ts';
import { validatePid } from './templates/pid/schema.ts';

type Data = Record<string, unknown> & { lines: Record<string, unknown>[] };

const sheet = (): Data => ({
  template: 'pid',
  title: 'Header with branches',
  description:
    'A drum feeds two pumps from one suction header, with a drain, a dead leg and a gauge.',
  equipment: [
    { id: 'V-10', type: 'vertical-vessel' },
    { id: 'P-10A', type: 'centrifugal-pump' },
    { id: 'P-10B', type: 'centrifugal-pump' },
  ],
  offpage: [
    { id: 'IN', direction: 'in', sheet: '1' },
    { id: 'OUT', direction: 'out', sheet: '3' },
    { id: 'SLOP', direction: 'out', sheet: '8' },
  ],
  lines: [
    { id: 'FEED', from: 'IN', to: 'V-10', inline: [{ type: 'gate' }] },
    { id: 'SUCT', from: 'V-10', to: 'P-10A', inline: [{ type: 'gate' }] },
    { id: 'SUCT-B', from: 'T-1', to: 'P-10B', inline: [{ type: 'gate', closed: true }] },
    { id: 'DISCH', from: 'P-10A', to: 'OUT', inline: [{ type: 'check' }] },
    { id: 'DISCH-B', from: 'P-10B', to: 'T-2', inline: [{ type: 'check' }] },
    { id: 'DRAIN', from: 'T-3', end: 'open', inline: [{ type: 'gate', closed: true }] },
    { id: 'DL-1', from: 'T-4', deadleg: true },
    { id: 'GAUGE', from: 'T-5', to: 'PI-12' },
    { id: 'TO-SLOP', from: 'T-6', to: 'SLOP', weight: 'secondary' },
  ],
  tees: [
    { id: 'T-1', on: 'SUCT' },
    { id: 'T-2', on: 'DISCH' },
    { id: 'T-3', on: 'SUCT', near: 'from' },
    { id: 'T-4', on: 'FEED' },
    { id: 'T-5', on: 'DISCH' },
    { id: 'T-6', on: 'DISCH', near: 'to' },
  ],
  instruments: [{ tag: 'LT-11', on: 'V-10' }, { tag: 'PI-12' }],
});

const errorsOf = (data: unknown): string => {
  const r = validate('pid', data);
  return r.ok ? '' : r.errors.join('\n');
};

const draw = (data: unknown) => {
  const r = render('pid', data, estimateMeasurer);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r;
};

/** The corner points of a line's drawn pipe (hops and gaps stay on it). */
function linePoints(svg: string, id: string): { x: number; y: number }[] {
  const g = new RegExp(`<g data-line="${id}"><path d="([^"]+)"`).exec(svg);
  if (!g) throw new Error(`no line ${id}`);
  const pts: { x: number; y: number }[] = [];
  for (const m of g[1]!.matchAll(/(?:[ML]|A\S+ \S+ 0 0 [01] )(-?[\d.]+) (-?[\d.]+)/g))
    pts.push({ x: Number(m[1]), y: Number(m[2]) });
  return pts;
}
function teePoint(svg: string, id: string): { x: number; y: number } {
  const m = new RegExp(
    `<circle cx="(-?[\\d.]+)" cy="(-?[\\d.]+)" r="3.5"[^>]*data-tee="${id}"`,
  ).exec(svg);
  if (!m) throw new Error(`no tee ${id}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}
const onPolyline = (p: { x: number; y: number }, pts: { x: number; y: number }[]) =>
  pts.slice(1).some((b, i) => {
    const a = pts[i]!;
    return a.y === b.y
      ? p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
      : a.x === b.x && p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
  });

describe('pid tees: validation', () => {
  it('accepts tees, branches, stubs, dead legs and a bubble at a branch end', () => {
    const r = validatePid(sheet());
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (!r.ok) return;
    const byId = new Map(r.data.lines.map((l) => [l.id, l]));
    expect(byId.get('DRAIN')).toMatchObject({ from: 'T-3', end: 'open' });
    expect(byId.get('DRAIN')!.to).toBeUndefined();
    // A dead leg with nowhere to go ends in a cap.
    expect(byId.get('DL-1')).toMatchObject({ deadleg: true, end: 'cap' });
    expect(r.data.tees).toHaveLength(6);
    // A bubble at the end of a branch is connected: no floating warning.
    expect(r.warnings.join('\n')).not.toMatch(/PI-12.*connected to nothing/);
  });

  it('names a missing tee on a branch, with a suggestion', () => {
    const d = sheet();
    d.lines[2]!.from = 'T-9';
    expect(errorsOf(d)).toMatch(
      /lines\[2\]\.from: no equipment, off-page connector or tee 'T-9' \(did you mean 'T-[0-9]'\?\)/,
    );
  });

  it('names a missing parent line on a tee, with a suggestion', () => {
    const d = sheet();
    (d.tees as Record<string, unknown>[])[0]!.on = 'SUTC';
    const e = errorsOf(d);
    expect(e).toMatch(
      /tees\[0\]\.on: no line 'SUTC' \(did you mean 'SUCT'\?\)\. A tee sits on a line/,
    );
  });

  it('refuses a branch that sits on itself', () => {
    const d = sheet();
    d.lines.push({ id: 'LOOP', from: 'T-7', to: 'P-10B' });
    (d.tees as Record<string, unknown>[]).push({ id: 'T-7', on: 'LOOP' });
    expect(errorsOf(d)).toMatch(
      /tees\[6\]\.on: tee 'T-7' sits on line 'LOOP', which itself starts or ends at 'T-7'/,
    );
    // Two tees, each on the other's branch.
    const e = sheet();
    e.lines.push({ id: 'A', from: 'T-8', end: 'open' }, { id: 'B', from: 'T-9', end: 'open' });
    (e.tees as Record<string, unknown>[]).push({ id: 'T-8', on: 'B' }, { id: 'T-9', on: 'A' });
    expect(errorsOf(e)).toMatch(/tee 'T-8' sits on line 'B', which itself starts or ends at 'T-8'/);
  });

  it('explains end, toward, ports and bubble ends that do not fit', () => {
    const d = sheet();
    d.lines[5]!.to = 'P-10B'; // DRAIN: end and to
    d.lines[2]!.toward = 'up'; // SUCT-B goes to a pump: routed
    d.lines[2]!.fromPort = 'top'; // from a tee
    d.lines[7]!.end = 'never';
    const e = errorsOf(d);
    expect(e).toMatch(/lines\[5\]\.end: a line with 'end' stops short and has no 'to'/);
    expect(e).toMatch(/lines\[2\]\.toward: only for a line that stops/);
    expect(e).toMatch(/lines\[2\]\.fromPort: 'T-1' is a tee/);
    expect(e).toMatch(/lines\[7\]\.end: 'never' is not one of/);
    const f = sheet();
    (f.instruments as Record<string, unknown>[])[1]!.on = 'V-10';
    expect(errorsOf(f)).toMatch(/lines\[7\]\.to: instrument 'PI-12' also has 'on'/);
    const g = sheet();
    delete g.lines[6]!.deadleg; // DL-1 now has no to and no end
    expect(errorsOf(g)).toMatch(/lines\[6\]\.to: required/);
  });

  it('warns about a tee nothing branches from', () => {
    const d = sheet();
    (d.tees as Record<string, unknown>[]).push({ id: 'T-0', on: 'FEED' });
    const r = validate('pid', d);
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/tees\[6\]: tee 'T-0' has no branch/);
  });
});

describe('pid tees: drawing', () => {
  const r = draw(sheet());

  it('is a static, deterministic drawing', () => {
    expect(checkStaticSvg(r.svg)).toEqual([]);
    expect(draw(sheet()).svg).toBe(r.svg);
  });

  it('keeps every tee on its parent line, and every branch starts or ends at its tee', () => {
    const d = sheet();
    for (const t of d.tees as { id: string; on: string }[]) {
      const at = teePoint(r.svg, t.id);
      expect(onPolyline(at, linePoints(r.svg, t.on)), `${t.id} on ${t.on}`).toBe(true);
      for (const l of d.lines.filter((x) => x.from === t.id || x.to === t.id)) {
        const pts = linePoints(r.svg, String(l.id));
        const end = l.from === t.id ? pts[0]! : pts[pts.length - 1]!;
        expect(end, `${String(l.id)} at ${t.id}`).toEqual(at);
      }
    }
    expect(r.warnings.join('\n')).not.toMatch(/is off its line/);
  });

  it('routes branches clear of equipment, valves and labels', () => {
    const ids = ['SUCT-B', 'DISCH-B', 'DRAIN', 'DL-1', 'GAUGE', 'TO-SLOP'];
    const bad = r.warnings.filter((w) => ids.some((id) => w.includes(`line '${id}'`)));
    expect(bad).toEqual([]);
  });

  it('draws a stub open, a dead leg capped with DL, and no arrowhead at a tee or a bubble', () => {
    const group = (id: string) => new RegExp(`<g data-line="${id}">(.*?)</g>`).exec(r.svg)![1]!;
    // An open stub is one plain path: no arrowhead, no cap.
    expect(group('DRAIN').match(/<path/g)).toHaveLength(1);
    expect(group('DL-1')).toContain('data-part="cap"');
    expect(group('GAUGE').match(/<path/g)).toHaveLength(1);
    expect(group('DISCH-B').match(/<path/g)).toHaveLength(1);
    // A branch into equipment or a connector keeps its arrowhead.
    expect(group('SUCT-B')).toMatch(/Z"/);
    expect(group('TO-SLOP')).toMatch(/Z"/);
    expect(r.svg).toMatch(/>DL<\/text>/);
    // The site profile may dash dead legs.
    const dashed = draw({ ...sheet(), profile: { symbols: { deadleg: 'dashed' } } });
    expect(
      new RegExp('<g data-line="DL-1"><path [^>]*stroke-dasharray="8,4"').test(dashed.svg),
    ).toBe(true);
    expect(r.svg).not.toContain('stroke-dasharray="8,4"');
  });

  it('says so when a stub is asked to leave along its parent line', () => {
    const d = sheet();
    d.lines[6]!.toward = 'left'; // DL-1 is on the horizontal FEED run
    const w = draw(d).warnings.join('\n');
    expect(w).toMatch(/line 'DL-1' cannot leave tee 'T-4' left, along its parent line/);
  });

  it('puts a bubble at the end of its branch', () => {
    const pts = linePoints(r.svg, 'GAUGE');
    const tip = pts[pts.length - 1]!;
    const bubble = /<circle cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="20"[^>]*>(?:(?!<\/g>).)*?>PI</.exec(
      r.svg,
    );
    expect(bubble).toBeTruthy();
    const c = { x: Number(bubble![1]), y: Number(bubble![2]) };
    expect(Math.abs(c.x - tip.x) + Math.abs(c.y - tip.y)).toBe(20);
  });

  it('draws a bypass between two tees on one line, and a branch off a branch', () => {
    const d: Data = {
      template: 'pid',
      title: 'Bypass',
      description: 'A control valve with a bypass and a vent off the bypass.',
      equipment: [
        { id: 'V-20', type: 'horizontal-drum' },
        { id: 'E-21', type: 'shell-tube-exchanger' },
      ],
      lines: [
        {
          id: 'MAIN',
          from: 'V-20',
          to: 'E-21',
          inline: [{ type: 'gate' }, { type: 'control', tag: 'FV-21' }, { type: 'gate' }],
        },
        { id: 'BYP', from: 'T-A', to: 'T-B', inline: [{ type: 'globe', closed: true }] },
        { id: 'VENT', from: 'T-C', end: 'cap', toward: 'down' },
      ],
      tees: [
        { id: 'T-A', on: 'MAIN', near: 'from' },
        { id: 'T-B', on: 'MAIN', near: 'to' },
        { id: 'T-C', on: 'BYP' },
      ],
    };
    const b = draw(d);
    expect(checkStaticSvg(b.svg)).toEqual([]);
    expect(onPolyline(teePoint(b.svg, 'T-C'), linePoints(b.svg, 'BYP'))).toBe(true);
    for (const t of ['T-A', 'T-B'])
      expect(onPolyline(teePoint(b.svg, t), linePoints(b.svg, 'MAIN'))).toBe(true);
    // The vent leaves the bypass downward, as asked.
    const vent = linePoints(b.svg, 'VENT');
    expect(vent[1]!.y).toBeGreaterThan(vent[0]!.y);
    expect(b.warnings.filter((w) => /line '(BYP|VENT)'/.test(w))).toEqual([]);
  });
});

describe('a line note and the legend names (traced circuits)', () => {
  it('a note is drawn beside its line; the legend takes the names given', () => {
    const d = sheet();
    d.lines[1] = { ...d.lines[1]!, note: 'INFERRED JOIN (GUESS)' };
    const b = draw({
      ...d,
      legendNames: { main: 'Main process line', secondary: 'Process branch' },
    });
    expect(b.svg).toContain('INFERRED JOIN (GUESS)');
    expect(b.svg).toMatch(/Process branch/i);
    expect(b.svg).not.toMatch(/Utility line/i);
    expect(checkStaticSvg(b.svg)).toEqual([]);
  });

  it('without them the legend is as before', () => {
    expect(draw(sheet()).svg).toMatch(/Utility line/i);
  });

  it('legendNames takes only main and secondary', () => {
    expect(errorsOf({ ...sheet(), legendNames: { branch: 'x' } })).toMatch(/legendNames/);
    expect(errorsOf({ ...sheet(), legendNames: 'x' })).toMatch(/legendNames: must be/);
  });
});
