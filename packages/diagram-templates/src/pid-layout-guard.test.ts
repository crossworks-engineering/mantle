/**
 * Data that passes the `pid` check must also draw. These shapes once threw
 * inside the layout: a bypass from tee to tee on one parent line whose two
 * tees landed on one point (a pipe of no length, so its valve or its line
 * number had no run to sit on), a connector reached through a tee that was
 * placed on the tee itself, and several pipes between the same two pieces. And a set draws every page it can: a page whose layout fails is
 * an error panel, named in `failed` and the warnings, and the rest still
 * draw. All tags and sheets here are made up.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkStaticSvg, estimateMeasurer, render, validate, type Measurer } from './index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
type Obj = Record<string, any>;

const draw = (data: unknown, m: Measurer = estimateMeasurer) => {
  const v = validate('pid', data);
  expect(v.ok ? '' : v.errors.join('\n')).toBe('');
  const r = render('pid', data, m);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  expect(checkStaticSvg(r.svg)).toEqual([]);
  return r;
};

function linePoints(svg: string, id: string): { x: number; y: number }[] {
  const g = new RegExp(`<g data-line="${id}"><path d="([^"]+)"`).exec(svg);
  if (!g) throw new Error(`no line ${id}`);
  const pts: { x: number; y: number }[] = [];
  for (const m of g[1]!.matchAll(/(?:[ML]|A\S+ \S+ 0 0 [01] )(-?[\d.]+) (-?[\d.]+)/g))
    pts.push({ x: Number(m[1]), y: Number(m[2]) });
  return pts;
}
const lengthOf = (pts: { x: number; y: number }[]) =>
  pts.slice(1).reduce((s, b, i) => s + Math.abs(b.x - pts[i]!.x) + Math.abs(b.y - pts[i]!.y), 0);

const opc = (id: string, direction: 'in' | 'out') => ({ id, direction, sheet: 'PID-1001' });

describe('pid data that passes the check also draws', () => {
  it('a bypass from tee to tee on one line, with a valve, beside another branch', () => {
    const d = {
      title: 'Bypass on one line',
      equipment: [],
      offpage: [opc('OPC-10', 'in')],
      lines: [
        { id: 'L85', from: 'OPC-10', end: 'open', inline: [{ type: 'gate' }] },
        { id: 'L86', from: 'T-1', end: 'open' },
        { id: 'L87', from: 'T-2', to: 'T-3', inline: [{ type: 'gate' }] },
      ],
      tees: [
        { id: 'T-1', on: 'L85', at: 0.5 },
        { id: 'T-2', on: 'L85', at: 0.5 },
        { id: 'T-3', on: 'L85', at: 0.5 },
      ],
    };
    const r = draw(d);
    expect(lengthOf(linePoints(r.svg, 'L87'))).toBeGreaterThan(0);
    // Both gates are drawn: the parent's and the bypass's.
    expect(r.svg.match(/data-inline="gate"/g)).toHaveLength(2);
    expect(r.warnings.join('\n')).not.toMatch(/has no length/);
  });

  it('a branch off a bypass whose tees once landed on one point', () => {
    const d = {
      title: 'Branch off a bypass',
      equipment: [],
      offpage: [opc('OPC-10', 'in')],
      lines: [
        { id: 'L57', from: 'OPC-10', end: 'open' },
        { id: 'L60', from: 'T-6', end: 'open', inline: [{ type: 'gate' }] },
        { id: 'L61', from: 'T-7', to: 'T-8' },
        { id: 'L62', from: 'T-9', end: 'open' },
      ],
      tees: [
        { id: 'T-6', on: 'L57', at: 0.5 },
        { id: 'T-7', on: 'L60', at: 0.5 },
        { id: 'T-8', on: 'L60', at: 0.5 },
        { id: 'T-9', on: 'L61', at: 0.5 },
      ],
    };
    const r = draw(d);
    expect(lengthOf(linePoints(r.svg, 'L61'))).toBeGreaterThan(0);
  });

  it('a connector reached through a tee is never put on the tee', () => {
    const d = {
      title: 'Connector off a tee',
      equipment: [],
      offpage: [
        opc('OPC-1', 'in'),
        opc('OPC-2', 'in'),
        opc('OPC-11', 'in'),
        opc('OPC-12', 'out'),
        opc('OPC-13', 'out'),
      ],
      lines: [
        { id: 'L1', from: 'OPC-1', end: 'open' },
        { id: 'L3', from: 'OPC-2', end: 'open' },
        { id: 'L12', from: 'OPC-11', to: 'OPC-12', inline: [{ type: 'gate' }, { type: 'gate' }] },
        { id: 'L13', from: 'T-2', to: 'OPC-13' },
      ],
      tees: [{ id: 'T-2', on: 'L12' }],
    };
    const r = draw(d);
    expect(lengthOf(linePoints(r.svg, 'L13'))).toBeGreaterThan(0);
  });

  it('a traced sheet with three bypasses on one short line', () => {
    const d = JSON.parse(readFileSync(path.join(ROOT, 'test/pid-tee-bypass.json'), 'utf8')) as Obj;
    const r = draw(d);
    for (const l of d.lines as Obj[])
      expect(lengthOf(linePoints(r.svg, String(l.id))), String(l.id)).toBeGreaterThan(0);
  });

  it('a line of no length that carries a line number', () => {
    // Found by fuzzing: L6 runs tee to tee and its two tees land on one
    // point, so it has no run for its number until it gets one of no length.
    const d = {
      title: 'Numbered line of no length',
      equipment: [],
      offpage: [opc('OPC-0', 'in'), opc('OPC-1', 'out'), opc('OPC-2', 'out')],
      lines: [
        {
          id: 'L0',
          from: 'OPC-0',
          end: 'cap',
          inline: [{ type: 'check' }, { type: 'globe' }, { type: 'check' }, { type: 'gate' }],
        },
        { id: 'L1', from: 'T-0', to: 'OPC-1' },
        { id: 'L2', from: 'T-1', end: 'cap', number: '2"-P-424' },
        { id: 'L3', from: 'T-2', to: 'OPC-2', inline: [{ type: 'blind' }, { type: 'control' }] },
        { id: 'L4', from: 'T-3', end: 'open' },
        { id: 'L5', from: 'T-4', to: 'T-5' },
        { id: 'L6', from: 'T-6', to: 'T-7', number: '2"-P-997' },
      ],
      tees: [
        { id: 'T-0', on: 'L0', at: 0 },
        { id: 'T-1', on: 'L1', at: 0.1 },
        { id: 'T-2', on: 'L2', at: 0.5 },
        { id: 'T-3', on: 'L0' },
        { id: 'T-4', on: 'L0' },
        { id: 'T-5', on: 'L3', near: 'from' },
        { id: 'T-6', on: 'L0' },
        { id: 'T-7', on: 'L5', near: 'to' },
      ],
    };
    const r = draw(d);
    expect(r.svg).toContain('2"-P-997'.replace('"', '&quot;'));
  });

  it('several lines between the same two pieces of equipment', () => {
    // Three pipes from E-0 to E-2 once made the column layout fail ("Not
    // possible to find intersection inside of the rectangle").
    const eq = (id: string, type: string) => ({ id, type });
    const d = {
      title: 'Parallel lines',
      equipment: [eq('E-0', 'vertical-vessel'), eq('E-1', 'vertical-vessel'), eq('E-2', 'filter')],
      offpage: [
        opc('OPC-0', 'in'),
        opc('OPC-1', 'out'),
        opc('OPC-2', 'in'),
        opc('OPC-3', 'out'),
        opc('OPC-5', 'out'),
      ],
      lines: [
        { id: 'L0', from: 'OPC-0', to: 'OPC-1' },
        { id: 'L1', from: 'T-0', to: 'E-1' },
        { id: 'L3', from: 'OPC-2', to: 'E-0' },
        { id: 'L4', from: 'T-2', to: 'OPC-3' },
        { id: 'L6', from: 'E-2', to: 'OPC-5' },
        { id: 'L7', from: 'T-3', end: 'open' },
        { id: 'L10', from: 'T-7', to: 'T-8' },
        { id: 'L12', from: 'T-10', to: 'E-2' },
        { id: 'L36', from: 'E-0', to: 'E-2' },
        { id: 'L46', from: 'E-0', to: 'E-2' },
        { id: 'L49', from: 'E-0', to: 'E-2' },
      ],
      tees: [
        { id: 'T-0', on: 'L0' },
        { id: 'T-2', on: 'L1', at: 0.9 },
        { id: 'T-3', on: 'L6', at: 0.1 },
        { id: 'T-7', on: 'L4', at: 0.63 },
        { id: 'T-8', on: 'L7' },
        { id: 'T-10', on: 'L3', at: 0.1 },
      ],
    };
    const r = draw(d);
    for (const id of ['L36', 'L46', 'L49'])
      expect(lengthOf(linePoints(r.svg, id)), id).toBeGreaterThan(0);
  });
});

describe('a set draws every page it can', () => {
  const page = (id: string, title: string) => ({
    id,
    data: {
      title,
      equipment: [{ id: 'V-1', type: 'vertical-vessel' }],
      offpage: [opc('IN', 'in')],
      lines: [{ id: 'L1', from: 'IN', to: 'V-1' }],
    },
  });
  const data = {
    title: 'Three pages',
    description: 'A set with a page whose layout fails.',
    pages: [page('one', 'First'), page('two', 'Breaks here'), page('three', 'Third')],
  };
  // A layout bug stood in by a measurer that throws on one page's title.
  const failing: Measurer = (text, font) => {
    if (text.includes('Breaks here')) throw new Error('measured a bad label');
    return estimateMeasurer(text, font);
  };

  it('a page whose layout throws is an error panel; the others draw', () => {
    const r = draw(data, failing);
    expect(r.pages?.map((p) => p.id)).toEqual(['one', 'two', 'three']);
    expect(r.failed).toEqual([
      { page: 'two', path: 'pages[1].data', error: 'measured a bad label' },
    ]);
    expect(r.warnings).toContainEqual(
      expect.stringMatching(
        /^pages\[1\]\.data: page 'two' could not be drawn \(measured a bad label\)/,
      ),
    );
    const broken = r.pages![1]!;
    expect(broken.svg).toContain('data-error="layout"');
    expect(broken.svg).toContain('Page 2 could not be drawn.');
    expect(broken.svg).toContain('Breaks here');
    expect(checkStaticSvg(broken.svg)).toEqual([]);
    for (const i of [0, 2]) expect(r.pages![i]!.svg).toContain('data-line="L1"');
    // The stacked export holds every page, the panel in its place.
    expect(r.svg).toContain('PAGE 2 OF 3: BREAKS HERE');
    expect(r.svg).toContain('data-error="layout"');
  });

  it('a set that draws has no failed pages', () => {
    const r = draw(data);
    expect(r.failed).toBeUndefined();
    expect(r.svg).not.toContain('data-error');
  });
});
