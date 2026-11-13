/**
 * The sheet of a drawing (sheetOf) and what starts off with the frame, on
 * made-up drawings only: a process flow sheet on numbered layers with a
 * stream table under its border (the parser's own rows for the drawing of
 * server/parser/cad/tests/label_fixtures.py), a sheet whose border is one
 * block, and drawings that draw no sheet.
 */
import { describe, expect, it } from 'vitest';
import fixtures from './label-fixtures.json';
import {
  buildRedraw,
  frameLayers,
  sheetOf,
  type RedrawPlacement,
  type RedrawRows,
  type RedrawShape,
  type RedrawSymbol,
  type RedrawText,
} from './build';

const OPTS = { title: 't', source: 's' };

type ShapeRow = {
  kind: string;
  layer: string;
  path: string;
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
};
type TextRow = { text: string; layer: string; x: number; y: number; ax: number; ay: number };
const DRAWINGS = fixtures as unknown as Record<string, { texts: TextRow[]; shapes?: ShapeRow[] }>;
const PFD = DRAWINGS.numbered_pfd!;

/** A registry shape as the Shapes tab and the row reader hand it on. */
const asShape = (h: ShapeRow, i: number): RedrawShape => ({
  layer: h.layer,
  handle: `H${i}`,
  path: h.path,
  minX: h.minx,
  minY: h.miny,
  maxX: h.maxx,
  maxY: h.maxy,
  ...(h.kind === 'SOLID' || h.kind === 'TRACE' ? { fill: true } : {}),
});

const rowsOf = (over: Partial<RedrawRows>): RedrawRows => ({
  symbols: [],
  placements: [],
  segments: [],
  texts: [],
  inserts: [],
  shapes: [],
  ...over,
});

const line = (
  layer: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  n = 0,
): RedrawShape => ({
  layer,
  handle: `${layer}-${x1}-${y1}-${x2}-${y2}-${n}`,
  path: `M${x1} ${y1}L${x2} ${y2}`,
  minX: Math.min(x1, x2),
  minY: Math.min(y1, y2),
  maxX: Math.max(x1, x2),
  maxY: Math.max(y1, y2),
});
const text = (t: Partial<RedrawText> & { text: string; x: number; y: number }): RedrawText => ({
  layer: 'TEXT',
  height: 2.5,
  rotation: 0,
  width: null,
  anchorX: t.x,
  anchorY: t.y,
  align: 'left',
  ...t,
});

/** The class list of each `<text>`, by its text. */
const textClasses = (html: string): Record<string, string[]> =>
  Object.fromEntries(
    [...html.matchAll(/<text class="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [
      m[2]!,
      m[1]!.split(' '),
    ]),
  );

describe('a process flow sheet on numbered layers, its stream table under the border', () => {
  const rows = rowsOf({
    shapes: PFD.shapes!.map(asShape),
    texts: PFD.texts.map((t) => text({ ...t, anchorX: t.ax, anchorY: t.ay })),
  });

  it('finds the sheet: the border, though its bottom line is in two pieces', () => {
    expect(sheetOf(rows)).toEqual({ x0: 0, y0: 0, x1: 420, y1: 297, handle: null });
  });

  it('takes the border layer for frame, measured on the sheet', () => {
    // The table under the border makes the line work 362 high, so the
    // border spans 82% of it: measured on all the line work (the rule
    // before the sheet) no layer was frame.
    expect([...frameLayers(rows)]).toEqual(['Level 56']);
    expect([...frameLayers(rows, null)]).toEqual([]);
  });

  it('starts the border layer and the table off, and opens on the sheet', () => {
    const got = buildRedraw(rows, OPTS);
    expect(got.sheet).toEqual([0, 0, 420, 297]);
    const byName = Object.fromEntries(got.layers.map((l, i) => [l.name, { ...l, i }]));
    expect(byName['Level 56']).toMatchObject({ off: true, frame: true });
    expect(byName['Level 33']).toMatchObject({ off: false, frame: false });
    // The table's 9 lines and 8 texts are outside the sheet, and the
    // border's 5 lines are on its edge: frame items, one class.
    expect(got.counts.frame_items).toBe(22);
    expect(got.html).toContain('<style id="fs">.fr{display:none}</style>');
    expect(got.html).toMatch(new RegExp(`<path class="L${byName['Level 33']!.i} fr" d="`));
    // The title block's box is inside the sheet, on the border's layer: it
    // goes off with that layer, in the layer's own path.
    expect(got.html).toMatch(new RegExp(`<path class="L${byName['Level 56']!.i}" d="`));
    const classes = textClasses(got.html);
    expect(classes['STREAM No']).toContain('fr');
    expect(classes['1250']).toContain('fr');
    expect(classes['C-101']).not.toContain('fr');
    // Not solved: a title text on its own level, inside the sheet, stays on.
    expect(classes['PROCESS FLOW DIAGRAM']).not.toContain('fr');
    expect(byName['Level 59']).toMatchObject({ off: false, frame: false });
    // The view is the sheet and 2% of its long side around it; the whole
    // area (the answer's window) still holds the table.
    expect(got.window).toEqual([0, -65, 420, 297]);
    expect(got.html).toContain('<svg id="d" viewBox="-8.4 -370.4 436.8 313.8"');
  });

  it('frame on: nothing starts off, the switch is set, the view is the whole area', () => {
    const got = buildRedraw(rows, { ...OPTS, frame: 'on' });
    expect(got.html).toContain('<style id="fs"></style>');
    expect(got.html).toContain('<input type="checkbox" id="showFrame" checked> Frame');
    expect(got.layers.find((l) => l.name === 'Level 56')).toMatchObject({ off: false });
    expect(got.html).toContain('<svg id="d" viewBox="-8.4 -370.4 436.8 378.8"');
    // The same items carry the class: the switch hides them again.
    expect(got.counts.frame_items).toBe(22);
  });
});

describe('a sheet whose border is one block', () => {
  // The border block: 420 x 297, its base point at its bottom left. A valve:
  // 8 x 4 about its base point.
  const frame: RedrawSymbol = {
    key: 'FRAME',
    svg: '<svg viewBox="0 0 420 297"><path d="M0 0L420 0L420 297L0 297Z"/></svg>',
    x0: 0,
    y0: 0,
    width: 420,
    height: 297,
  };
  const valve: RedrawSymbol = {
    key: 'VALVE',
    svg: '<svg viewBox="0 0 8 4"><path d="M0 0L8 4L8 0L0 4Z"/></svg>',
    x0: -4,
    y0: -2,
    width: 8,
    height: 4,
  };
  const place = (key: string, x: number, y: number, handle: string): RedrawPlacement => ({
    key,
    x,
    y,
    rotation: 0,
    xscale: 1,
    yscale: 1,
    layer: '0',
    handle,
  });
  const rows = rowsOf({
    symbols: [frame, valve],
    placements: [place('FRAME', 1000, 2000, 'F1'), place('VALVE', 1200, 2100, 'V1')],
    shapes: [
      line('0', 1050, 2100, 1196, 2100),
      line('0', 1204, 2100, 1350, 2100),
      line('0', 1350, 2100, 1350, 2250),
      // A line parked beside the sheet.
      line('0', 1500, 2100, 1550, 2100),
    ],
    texts: [
      text({ text: 'UNIT 1', x: 1300, y: 2020, block: 'F1' }),
      text({ text: 'HV-1', x: 1196, y: 2095, block: 'V1' }),
      text({ text: '2"-P-1001', x: 1100, y: 2102 }),
      text({ text: 'parked note', x: 1600, y: 2100 }),
    ],
  });

  it('finds the sheet: the block that holds the rest', () => {
    expect(sheetOf(rows)).toEqual({ x0: 1000, y0: 2000, x1: 1420, y1: 2297, handle: 'F1' });
  });

  it('starts the block, its title texts and what is outside it off; no layer is frame', () => {
    const got = buildRedraw(rows, OPTS);
    expect(got.layers).toEqual([
      { name: '0', off: false, frame: false },
      { name: 'TEXT', off: false, frame: false },
    ]);
    const uses = [...got.html.matchAll(/<use class="([^"]*)" href="#(s\d)"/g)].map((m) => m[1]);
    expect(uses).toEqual(['L0 fr', 'L0']);
    const classes = textClasses(got.html);
    expect(classes['UNIT 1']).toContain('fr');
    expect(classes['parked note']).toContain('fr');
    expect(classes['HV-1']).not.toContain('fr');
    expect(classes['2&quot;-P-1001']).not.toContain('fr');
    // The block, its title text, the parked line and the parked note.
    expect(got.counts.frame_items).toBe(4);
    expect(got.html).toMatch(/<path class="L0 fr" d="M500 100L550 100"\/>/);
    expect(got.html).toContain('<input type="checkbox" id="showFrame"> Frame');
  });

  it('a window keeps its own view', () => {
    const got = buildRedraw(rows, { ...OPTS, window: [1100, 2050, 1300, 2150] });
    expect(got.html).toContain('<svg id="d" viewBox="-4 -104 208 108"');
  });
});

describe('a drawing that draws no sheet', () => {
  const box = (layer: string, x0: number, y0: number, x1: number, y1: number) => [
    line(layer, x0, y0, x1, y0),
    line(layer, x1, y0, x1, y1),
    line(layer, x1, y1, x0, y1),
    line(layer, x0, y1, x0, y0),
  ];
  const pipes = (n: number, x0: number, y: number, dx: number) =>
    Array.from({ length: n }, (_, i) => line('PIPE', x0 + i * dx, y, x0 + i * dx + dx / 2, y, i));

  it('no rectangle: no sheet, no frame item, no switch', () => {
    const rows = rowsOf({ shapes: pipes(6, 0, 10, 20) });
    expect(sheetOf(rows)).toBeNull();
    const got = buildRedraw(rows, OPTS);
    expect(got.sheet).toBeNull();
    expect(got.counts.frame_items).toBe(0);
    expect(got.html).not.toContain('showFrame"');
    expect(got.html).toContain('<style id="fs"></style>');
  });

  it('a box a pipe crosses is not a sheet (the box around a package)', () => {
    const rows = rowsOf({
      shapes: [
        ...box('PACKAGE', 0, 0, 100, 60),
        ...pipes(8, 10, 30, 10),
        // From inside the box to well outside it.
        line('PIPE', 50, 20, 180, 20),
        ...pipes(3, 120, 40, 20),
      ],
    });
    expect(sheetOf(rows)).toBeNull();
  });

  it('a box that holds less than half of the rest is not a sheet (a legend)', () => {
    const rows = rowsOf({
      shapes: [
        ...box('LEGEND', 300, 0, 400, 60),
        ...pipes(3, 310, 30, 20),
        ...pipes(12, 0, 30, 20),
      ],
    });
    expect(sheetOf(rows)).toBeNull();
  });

  it('a closed polyline is a border as four lines are, and is itself a frame item', () => {
    const rows = rowsOf({
      shapes: [
        {
          layer: 'B',
          handle: 'B1',
          path: 'M0 0L420 0L420 297L0 297L0 0',
          minX: 0,
          minY: 0,
          maxX: 420,
          maxY: 297,
        },
        ...pipes(5, 20, 100, 60),
      ],
    });
    expect(sheetOf(rows)).toEqual({ x0: 0, y0: 0, x1: 420, y1: 297, handle: null });
    expect(buildRedraw(rows, OPTS).counts.frame_items).toBe(1);
  });

  it('reads Segments when a database has no Shapes tab', () => {
    const seg = (h: RedrawShape) => ({
      layer: h.layer,
      x1: h.minX,
      y1: h.minY,
      x2: h.maxX,
      y2: h.maxY,
    });
    const rows = rowsOf({
      shapes: null,
      segments: [...box('B', 0, 0, 420, 297), ...pipes(5, 20, 100, 60)].map(seg),
    });
    expect(sheetOf(rows)).toEqual({ x0: 0, y0: 0, x1: 420, y1: 297, handle: null });
  });
});

describe('line work that is not a line: a SOLID, a TRACE and a LEADER', () => {
  const rows = rowsOf({ shapes: DRAWINGS.line_work!.shapes!.map(asShape) });
  const got = buildRedraw(rows, OPTS);

  it('fills the arrow head and the bar, and draws the leader as its line', () => {
    expect(got.counts.shapes).toBe(4);
    expect(got.layers.map((l) => l.name)).toEqual(['NOTES', 'PIPE']);
    // The area's corner is 0, 10 (the bar's lower edge).
    expect(got.window).toEqual([0, 10, 100, 53]);
    // The pipe: an outline path. The arrow head (a triangle) and the bar
    // (its outline goes round it): the layer's filled path.
    expect(got.html).toContain('<path class="L1" d="M0 40L90 40"/>');
    expect(got.html).toContain(
      '<path class="L1 sf" d="M100 40L90 43L90 37L100 40M10 0L30 0L30 2L10 2L10 0"/>',
    );
    expect(got.html).toContain('<path class="L0" d="M60 10L50 30L45 40"/>');
    expect(got.html).toContain('#lines path.sf { fill: #555; }');
    expect(got.html).toContain('#lines path { fill: none;');
  });

  it('a bar is no sheet: it holds nothing of the rest', () => {
    expect(sheetOf(rows)).toBeNull();
  });
});
