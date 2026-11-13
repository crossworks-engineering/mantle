/**
 * The redraw builder on made-up drawings only (no client drawing in the repo):
 * the placement check of the hand test (each placed symbol against an insert
 * box worked out by hand: turned, mirrored, scaled), the frame guess, the
 * text sizes, escaping, and the window that fits a size cap.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRedraw,
  esc,
  frameLayers,
  gapSizes,
  placementCheck,
  sanitizeSymbolSvg,
  windowThatFits,
  type RedrawPlacement,
  type RedrawRows,
  type RedrawSymbol,
} from './build';

/** A 4 x 1 block (x 0..4, y 0..1), drawn as an SVG of 400 x 100. Its SVG
 *  top-left (0, 0) is the block point (0, 1); its bottom-right (400, 100)
 *  the block point (4, 0). */
const SYMBOL: RedrawSymbol = {
  key: 'K1',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><path d="M0 0L400 100"/></svg>',
  x0: 0,
  y0: 0,
  width: 4,
  height: 1,
};

const place = (p: Partial<RedrawPlacement> & { x: number; y: number }): RedrawPlacement => ({
  key: 'K1',
  rotation: 0,
  xscale: 1,
  yscale: 1,
  layer: 'VALVES',
  handle: `H${p.x}_${p.y}`,
  ...p,
});

/** Five placements and the insert box of each, worked out by hand. */
const CASES: { name: string; p: RedrawPlacement; box: [number, number, number, number] }[] = [
  { name: 'plain', p: place({ x: 10, y: 20 }), box: [10, 20, 14, 21] },
  // Turned 90: (x, y) goes to (-y, x).
  { name: 'turned', p: place({ x: 30, y: 5, rotation: 90 }), box: [29, 5, 30, 9] },
  { name: 'mirrored', p: place({ x: 50, y: 0, xscale: -1 }), box: [46, 0, 50, 1] },
  { name: 'scaled', p: place({ x: 0, y: -50, xscale: 2, yscale: 3 }), box: [0, -50, 8, -47] },
  // Mirrored in y, then turned 180: (x, -y) then (-x, y).
  {
    name: 'turned and mirrored',
    p: place({ x: 70, y: 70, rotation: 180, yscale: -1 }),
    box: [66, 70, 70, 71],
  },
];

const rowsOf = (over: Partial<RedrawRows> = {}): RedrawRows => ({
  shapes: null,
  symbols: [SYMBOL],
  placements: CASES.map((c) => c.p),
  segments: [],
  texts: [],
  inserts: CASES.map((c) => ({
    handle: c.p.handle,
    minX: c.box[0],
    minY: c.box[1],
    maxX: c.box[2],
    maxY: c.box[3],
  })),
  ...over,
});

const OPTS = { title: 'Test sheet', source: 'made-up.dxf' };

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/** An SVG transform list as one matrix (translate, rotate, scale only). */
function matrixOf(t: string): M {
  let m: M = [1, 0, 0, 1, 0, 0];
  for (const [, fn, args] of t.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const n = args!
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (fn === 'translate') m = mul(m, [1, 0, 0, 1, n[0]!, n[1] ?? 0]);
    else if (fn === 'scale') m = mul(m, [n[0]!, 0, 0, n[1] ?? n[0]!, 0, 0]);
    else if (fn === 'rotate') {
      const a = (n[0]! * Math.PI) / 180;
      m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]);
    } else throw new Error(`unexpected ${fn}`);
  }
  return m;
}
const apply = (m: M, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/** Where each `<use>` puts its symbol, in drawing units: the four SVG corners
 *  through the use's transform, then back from the canvas's local corner. */
function placedBoxes(html: string, origin: [number, number]) {
  const out: { box: [number, number, number, number]; topLeft: [number, number] }[] = [];
  for (const u of html.matchAll(
    /<use [^>]*width="([^"]+)" height="([^"]+)" transform="([^"]+)"/g,
  )) {
    const w = Number(u[1]);
    const h = Number(u[2]);
    const m = matrixOf(u[3]!);
    const pts = [apply(m, 0, 0), apply(m, w, 0), apply(m, 0, h), apply(m, w, h)].map(
      ([x, y]) => [x + origin[0], y + origin[1]] as [number, number],
    );
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    out.push({
      box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      topLeft: pts[0]!,
    });
  }
  return out;
}

describe('placements: the hand test check', () => {
  const window = [-100, -100, 100, 100] as const;
  const built = buildRedraw(rowsOf(), { ...OPTS, window });
  const placed = placedBoxes(built.html, [window[0], window[1]]);

  it('draws one use per placement and one symbol', () => {
    expect(placed).toHaveLength(CASES.length);
    expect(built.counts).toMatchObject({ symbols: 1, placements: 5, placements_without_symbol: 0 });
  });

  for (const [i, c] of CASES.entries()) {
    it(`places the ${c.name} symbol on its insert box`, () => {
      const got = placed[i]!.box;
      for (let k = 0; k < 4; k += 1) expect(got[k]).toBeCloseTo(c.box[k]!, 6);
    });
  }

  it('puts the SVG top-left on the block point (0, 1), turned with the placement', () => {
    // plain: (10, 21); turned 90: (30 - 1, 5 + 0); mirrored: (50 - 0, 1);
    // scaled: (0, -50 + 3); turned 180 and mirrored in y: (70, 71).
    const want: [number, number][] = [
      [10, 21],
      [29, 5],
      [50, 1],
      [0, -47],
      [70, 71],
    ];
    for (const [i, w] of want.entries()) {
      expect(placed[i]!.topLeft[0]).toBeCloseTo(w[0], 6);
      expect(placed[i]!.topLeft[1]).toBeCloseTo(w[1], 6);
    }
  });

  it('placementCheck passes every one against the insert boxes', () => {
    expect(placementCheck(rowsOf())).toMatchObject({ compared: 5, inside: 5, pointBoxes: 0 });
    expect(placementCheck(rowsOf()).iouMedian).toBeCloseTo(1, 6);
  });

  it('placementCheck fails a symbol placed off its box, and counts a point box apart', () => {
    const rows = rowsOf();
    rows.inserts[0] = { ...rows.inserts[0]!, minX: 100, maxX: 104 };
    rows.inserts[1] = { ...rows.inserts[1]!, minX: 30, maxX: 30, minY: 5, maxY: 5 };
    expect(placementCheck(rows)).toMatchObject({ compared: 5, inside: 3, pointBoxes: 1 });
  });

  it('counts a placement whose symbol has no drawing, and draws nothing for it', () => {
    const rows = rowsOf({
      symbols: [SYMBOL, { ...SYMBOL, key: 'LABEL', svg: null }],
      placements: [...rowsOf().placements, place({ x: 5, y: 5, key: 'LABEL' })],
    });
    const got = buildRedraw(rows, OPTS);
    expect(got.counts).toMatchObject({ placements: 5, placements_without_symbol: 1 });
  });
});

describe('sizes in their own units', () => {
  it('a small symbol and text on a very wide drawing keep their size', () => {
    const got = buildRedraw(
      rowsOf({
        symbols: [{ ...SYMBOL, x0: -0.2, y0: -0.175, width: 0.4, height: 0.35 }],
        placements: [place({ x: 150_000, y: 10, xscale: 0.4, yscale: 2.5 })],
        segments: [{ layer: 'PIPE', x1: 0, y1: 0, x2: 300_000, y2: 0 }],
        texts: [{ text: 'T', layer: 'T', x: 5, y: 5, height: 0.3, rotation: 12.5, width: null }],
        inserts: [],
      }),
      OPTS,
    );
    expect(got.html).toContain('width="0.4" height="0.35"');
    expect(got.html).toContain('scale(0.4 2.5) translate(-0.2 0.175)');
    expect(got.html).toContain('font-size="0.42"');
    expect(got.html).toMatch(/rotate\(-12\.5 /);
  });
});

describe('the frame guess', () => {
  const rect = (layer: string, x0: number, y0: number, x1: number, y1: number) => [
    { layer, x1: x0, y1: y0, x2: x1, y2: y0 },
    { layer, x1: x1, y1: y0, x2: x1, y2: y1 },
    { layer, x1: x1, y1: y1, x2: x0, y2: y1 },
    { layer, x1: x0, y1: y1, x2: x0, y2: y0 },
  ];
  const segments = [
    ...rect('BORDER', 0, 0, 1000, 700),
    // Spans the width only: not a frame.
    { layer: 'PIPE', x1: 0, y1: 300, x2: 1000, y2: 300 },
    // Spans both ways, but holds a placement: not a frame.
    ...rect('VALVES', 5, 5, 995, 695),
    // Spans both ways with short lines only: not a frame.
    ...Array.from({ length: 20 }, (_, i) => ({
      layer: 'GRID',
      x1: i * 50,
      y1: i * 35,
      x2: i * 50 + 50,
      y2: i * 35 + 35,
    })),
  ];
  const rows = rowsOf({
    segments,
    placements: [place({ x: 500, y: 350 })],
    inserts: [],
  });

  it('takes only the border layer', () => {
    expect([...frameLayers(rows)]).toEqual(['BORDER']);
  });

  it('reads the Shapes boxes when the network gave up (no Segments)', () => {
    const asShapes = rowsOf({
      segments: [],
      placements: [place({ x: 500, y: 350 })],
      inserts: [],
      shapes: segments.map((g, i) => ({
        layer: g.layer,
        handle: `S${i}`,
        path: `M${g.x1} ${g.y1}L${g.x2} ${g.y2}`,
        minX: Math.min(g.x1, g.x2),
        minY: Math.min(g.y1, g.y2),
        maxX: Math.max(g.x1, g.x2),
        maxY: Math.max(g.y1, g.y2),
      })),
    });
    expect([...frameLayers(asShapes)]).toEqual(['BORDER']);
  });

  it('starts it off by default, on with frame on, and hides named layers', () => {
    const off = buildRedraw(rows, { ...OPTS, hideLayers: ['PIPE', 'NO SUCH'] });
    const byName = Object.fromEntries(off.layers.map((l) => [l.name, l]));
    expect(byName.BORDER).toMatchObject({ off: true, frame: true });
    expect(byName.PIPE).toMatchObject({ off: true, frame: false });
    expect(byName.VALVES).toMatchObject({ off: false });
    expect(off.unknownLayers).toEqual(['NO SUCH']);
    const i = off.layers.findIndex((l) => l.name === 'BORDER');
    expect(off.html).toContain(`.L${i}{display:none}`);

    const on = buildRedraw(rows, { ...OPTS, frame: 'on' });
    expect(on.layers.find((l) => l.name === 'BORDER')).toMatchObject({ off: false, frame: true });
    expect(on.html).not.toContain(`.L${i}{display:none}`);
  });

  it('a window keeps only what meets it', () => {
    const got = buildRedraw(rows, { ...OPTS, window: [900, 600, 1100, 800] });
    // The border's top and right sides, VALVES' top and right, and the last
    // three GRID lines (the 18th ends at x 900, on the window's edge).
    expect(got.counts.lines).toBe(7);
    expect(got.counts.placements).toBe(0);
    expect(got.window).toEqual([900, 600, 1100, 800]);
  });
});

describe('texts', () => {
  it('sizes a text by its Height and turns it by its Rotation', () => {
    const got = buildRedraw(
      rowsOf({
        texts: [
          { text: 'P-101', layer: 'T', x: 1, y: 2, height: 2.5, rotation: 90, width: null },
          { text: 'NOTE', layer: 'T', x: 5, y: 5, height: 1, rotation: 0, width: 40 },
        ],
      }),
      { ...OPTS, window: [0, 0, 10, 10] },
    );
    expect(got.html).toMatch(
      /<text class="L\d+" x="1" y="-2" font-size="3.5" transform="rotate\(-90 1 -2\)">P-101<\/text>/,
    );
    // An MTEXT (it has a width) is set from its top-left corner.
    expect(got.html).toMatch(/<text class="L\d+ m" x="5" y="-5" font-size="1.4">NOTE<\/text>/);
    expect(got.counts).toMatchObject({ texts: 2, texts_with_height: 2 });
  });

  it('guesses a size from the gaps when the row has no Height', () => {
    const column = Array.from({ length: 10 }, (_, i) => ({
      text: `L${i}`,
      layer: 'T',
      x: 0,
      y: i * 5,
      height: null,
      rotation: null,
      width: null,
    }));
    const sizes = gapSizes(column, 1000, 1000);
    // 0.6 of the median gap (5) is the usual size; 0.65 of 5 is above it.
    for (const s of sizes) expect(s).toBeCloseTo(3, 6);
    const lone = gapSizes([column[0]!], 300, 300);
    expect(lone[0]).toBeCloseTo(1, 6);
    const got = buildRedraw(rowsOf({ texts: column }), OPTS);
    expect(got.counts.texts_with_height).toBe(0);
  });

  it('stays quick when thousands of texts sit at one point', () => {
    const stacked = Array.from({ length: 20_000 }, () => ({
      text: 'x',
      layer: 'T',
      x: 5,
      y: 5,
      height: null,
      rotation: null,
      width: null,
    }));
    const t0 = performance.now();
    const sizes = gapSizes(stacked, 100, 100);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(sizes[0]).toBeCloseTo(100 / 300, 6);
  });

  it('keeps the gap guess quick on a full Texts tab', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => ({
      text: 'x',
      layer: 'T',
      x: (i % 200) * 10,
      y: Math.floor(i / 200) * 3,
      height: null,
      rotation: null,
      width: null,
    }));
    const t0 = performance.now();
    gapSizes(many, 2000, 300);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('escaping', () => {
  const evil = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
  const svg =
    '<svg viewBox="0 0 10 10"><style>*{background:url(javascript:alert(3))}</style>' +
    '<script>alert(4)</script><g onload="alert(5)" transform="translate(1 1)">' +
    '<path d="M0 0L10 10" onclick="alert(6)" style="x" class="C1"/>' +
    '<a href="javascript:alert(7)"><circle cx="5" cy="5" r="2"/></a>' +
    '<foreignObject><div>hi</div></foreignObject>' +
    '<rect x="0" y="0" width="1" height="1" transform="url(#x)"/>' +
    '<line x1="0" y1="0" x2="1" y2="1" d="&quot;onmouseover=alert(8)"/></svg>';

  it('rebuilds a symbol from its shapes and geometry only', () => {
    const clean = sanitizeSymbolSvg(svg)!;
    expect(clean.viewBox).toBe('0 0 10 10');
    expect(clean.inner).toBe(
      '<g transform="translate(1 1)"><path d="M0 0L10 10"/><circle cx="5" cy="5" r="2"/>' +
        '<rect x="0" y="0" width="1" height="1"/><line x1="0" y1="0" x2="1" y2="1"/></g>',
    );
    // A `<` and a long name with no `>` cost one pass.
    const t2 = performance.now();
    expect(sanitizeSymbolSvg(`<svg viewBox="0 0 1 1"><${'a'.repeat(200_000)}</svg>`)!.inner).toBe(
      '',
    );
    expect(performance.now() - t2).toBeLessThan(500);
    // Many `<` with no `>` cost one pass.
    const t1 = performance.now();
    expect(sanitizeSymbolSvg(`<svg viewBox="0 0 1 1">${'<a'.repeat(128_000)}</svg>`)!.inner).toBe(
      '',
    );
    expect(performance.now() - t1).toBeLessThan(500);
    // A long run with no `=` inside one tag costs one pass.
    const run = `<svg viewBox="0 0 1 1"><path ${'a'.repeat(200_000)} d="M0 0"/></svg>`;
    const t0 = performance.now();
    expect(sanitizeSymbolSvg(run)!.inner).toBe('<path d="M0 0"/>');
    expect(performance.now() - t0).toBeLessThan(500);
    expect(sanitizeSymbolSvg('<svg viewBox="0 0 0 5"><path d="M0 0"/></svg>')).toBeNull();
    expect(sanitizeSymbolSvg('<svg><path d="M0 0"/></svg>')).toBeNull();
  });

  it('no text, layer name, title or file name can add markup or script', () => {
    const got = buildRedraw(
      rowsOf({
        symbols: [{ ...SYMBOL, svg }],
        placements: [place({ x: 1, y: 1, layer: evil })],
        segments: [{ layer: evil, x1: 0, y1: 0, x2: 5, y2: 5 }],
        texts: [{ text: evil, layer: evil, x: 1, y: 1, height: 1, rotation: 0, width: null }],
        inserts: [],
      }),
      { title: evil, source: evil },
    );
    // One script element: the canvas's own.
    expect(got.html.match(/<script/gi)).toHaveLength(1);
    // The evil string is there only as escaped text.
    expect(got.html).toContain(esc(evil));
    const markup = got.html.replaceAll(esc(evil), '');
    expect(markup).not.toMatch(/<img|onerror|onload|onclick|javascript:|foreignObject|<style>\*/i);
    expect(esc(`a&<>"'\u0000b`)).toBe('a&amp;&lt;&gt;&quot;&#39; b');
  });
});

describe('a block drawn in place at site coordinates', () => {
  it('keeps its box corner exact, millions of units from its base point', () => {
    const got = buildRedraw(
      rowsOf({
        symbols: [{ ...SYMBOL, x0: 5_400_012.25, y0: 3_100_007.5, width: 4, height: 1 }],
        placements: [place({ x: 0, y: 0 })],
        inserts: [],
      }),
      OPTS,
    );
    expect(got.html).toContain('translate(5400012.25 3100008.5) scale(1 -1)');
  });

  it('writes its turn and scales as stored: at 6 digits the far corner would move by units', () => {
    // Site coordinates of about -706,000 and 1,600,000, a turn and a scale
    // that are not round numbers.
    const p = place({ x: 12.5, y: 7.25, rotation: 12.3457, xscale: 1.000001, yscale: -0.999999 });
    const symbol = { ...SYMBOL, x0: -706_000.5, y0: 1_600_000.25, width: 4, height: 1 };
    const got = buildRedraw(rowsOf({ symbols: [symbol], placements: [p], inserts: [] }), OPTS);
    expect(got.html).toContain(
      'rotate(12.3457) scale(1.000001 -0.999999) translate(-706000.5 1600001.25) scale(1 -1)',
    );
    // The block point (x0, y0) lands where the placement's own numbers put
    // it, to a hundredth of a unit.
    const a = (12.3457 * Math.PI) / 180;
    const sx = -706_000.5 * 1.000001;
    const sy = 1_600_000.25 * -0.999999;
    const want = [
      12.5 + sx * Math.cos(a) - sy * Math.sin(a),
      7.25 + sx * Math.sin(a) + sy * Math.cos(a),
    ];
    const m =
      /rotate\(([-\d.]+)\) scale\(([-\d.]+) ([-\d.]+)\) translate\(([-\d.]+) ([-\d.]+)\)/.exec(
        got.html,
      )!;
    const [r, kx, ky, tx, ty] = m.slice(1).map(Number) as [number, number, number, number, number];
    // The corner in the symbol's frame is (tx, ty - height): the SVG's bottom left.
    const b = (r * Math.PI) / 180;
    const px = tx * kx;
    const py = (ty - 1) * ky;
    const at = [
      12.5 + px * Math.cos(b) - py * Math.sin(b),
      7.25 + px * Math.sin(b) + py * Math.cos(b),
    ];
    expect(Math.hypot(at[0]! - want[0]!, at[1]! - want[1]!)).toBeLessThan(0.01);
  });
});

describe('shapes: the curves the network leaves out', () => {
  const circle =
    'M12 10C12 11.1046 11.1046 12 10 12C8.8954 12 8 11.1046 8 10C8 8.8954 8.8954 8 10 8C11.1046 8 12 8.8954 12 10';
  const rows = rowsOf({
    placements: [],
    inserts: [],
    segments: [
      { layer: 'PIPE', x1: 0, y1: 0, x2: 20, y2: 0, handle: 'L1' },
      // A polyline's chord: its entity has a Shapes row, so it is drawn from there.
      { layer: 'PIPE', x1: 20, y1: 0, x2: 20, y2: 20, handle: 'P1' },
      // An arc the Shapes caps left out: still drawn, as its chord.
      { layer: 'PIPE', x1: 0, y1: 20, x2: 5, y2: 25, handle: 'A1' },
    ],
    shapes: [
      { layer: 'EQUIP', handle: 'C1', path: circle, minX: 8, minY: 8, maxX: 12, maxY: 12 },
      { layer: 'PIPE', handle: 'P1', path: 'M20 0L20 20', minX: 20, minY: 0, maxX: 20, maxY: 20 },
      // Not a path the parser writes: never drawn.
      {
        layer: 'EQUIP',
        handle: 'X1',
        path: 'M0 0" onload="x',
        minX: 0,
        minY: 0,
        maxX: 1,
        maxY: 1,
      },
    ],
  });

  it('draws a segment unless its entity has a Shapes row, and every shape, from the corner', () => {
    const got = buildRedraw(rows, { ...OPTS, window: [-10, -10, 30, 30] });
    expect(got.counts).toMatchObject({ lines: 2, shapes: 2 });
    // Written from the window's corner (-10, -10), as every other number.
    expect(got.html).toContain(
      'M22 20C22 21.1046 21.1046 22 20 22C18.8954 22 18 21.1046 18 20C18 18.8954 18.8954 18 20 18C21.1046 18 22 18.8954 22 20',
    );
    expect(got.html).toContain('M30 10L30 30');
    // One path a layer: segments and shapes of PIPE in one.
    expect(got.html.match(/<path class="L\d+" d="/g)).toHaveLength(2);
    expect(got.html).not.toContain('onload');
    expect(got.layers.find((l) => l.name === 'EQUIP')).toBeDefined();
  });

  it('far from the origin, a shape is written as small numbers', () => {
    const far = rowsOf({
      placements: [],
      inserts: [],
      segments: [{ layer: 'PIPE', x1: 5_400_000, y1: 0, x2: 5_400_010, y2: 0, handle: 'L1' }],
      shapes: [
        {
          layer: 'PIPE',
          handle: 'C1',
          path: 'M5400002 1L5400003 2',
          minX: 5_400_002,
          minY: 1,
          maxX: 5_400_003,
          maxY: 2,
        },
      ],
    });
    expect(buildRedraw(far, OPTS).html).toContain('M2 1L3 2');
  });

  it('a window keeps a shape whose box meets it', () => {
    const got = buildRedraw(rows, { ...OPTS, window: [11, 11, 15, 15] });
    expect(got.counts.shapes).toBe(1);
  });

  it('a database with no Shapes tab draws every segment, as before', () => {
    const got = buildRedraw({ ...rows, shapes: null }, OPTS);
    expect(got.counts).toMatchObject({ lines: 3, shapes: 0 });
  });
});

describe('the canvas look and handling (owner fixes, 2026-11-12)', () => {
  const html = buildRedraw(rowsOf(), OPTS).html;

  it('the controls set their own dark text and light ground, never inherited', () => {
    expect(html).toContain(':root { color-scheme: light; }');
    expect(html).toContain(
      '#bar, #layers, #foot, #bar *, #layers *, #foot * { color: #111 !important; }',
    );
    expect(html).toMatch(
      /#bar input, #layers input \{[^}]*accent-color: #1f5fd6;[^}]*appearance: auto;/,
    );
    expect(html).toMatch(/#bar \{[^}]*background: #f4f4f5; border: 1px solid #999;/);
    expect(html).toMatch(/#layers \{[^}]*background: #f4f4f5; border: 1px solid #999;/);
  });

  it('symbols are styled in defs (a use copy takes its style there), lines with round caps', () => {
    expect(html).toMatch(
      /defs symbol \* \{[^}]*stroke-width: 1\.5px !important; stroke-linecap: round;[^}]*vector-effect: non-scaling-stroke;/,
    );
    expect(html).toMatch(/#lines path \{[^}]*stroke-linecap: round;/);
  });

  it('a symbol also carries no fill and its stroke as attributes, for a renderer without the style', () => {
    expect(html).toMatch(
      /<symbol id="s0" [^>]*fill="none" stroke="#1f5fd6" stroke-linecap="round" stroke-linejoin="round">/,
    );
  });

  it('drops the clear ground ezdxf lays under a symbol', () => {
    const clean = sanitizeSymbolSvg(
      '<svg viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" fill="#000" fill-opacity="0.0"/><path d="M0 0L10 10"/></svg>',
    )!;
    expect(clean.inner).toBe('<path d="M0 0L10 10"/>');
  });

  it('drag moves the picture and sets the viewBox once; zoom once a frame; one scale both ways', () => {
    expect(html).toContain(
      "svg.style.transform = 'translate(' + drag.dx + 'px,' + drag.dy + 'px)';",
    );
    expect(html).toContain("svg.addEventListener('pointercancel', end);");
    expect(html).toContain('requestAnimationFrame(');
    expect(html).toContain('return Math.max(vb[2] / r.width, vb[3] / r.height);');
    expect(html).toMatch(/svg#d \{[^}]*touch-action: none;/);
    // pointermove never touches the viewBox.
    const move = html.slice(html.indexOf("'pointermove'"), html.indexOf('const end'));
    expect(move).not.toContain('set()');
  });
});

describe('the size cap', () => {
  const dense = rowsOf({
    segments: Array.from({ length: 4000 }, (_, i) => ({
      layer: 'PIPE',
      x1: (i % 100) * 10,
      y1: Math.floor(i / 100) * 10,
      x2: (i % 100) * 10 + 7,
      y2: Math.floor(i / 100) * 10 + 3,
    })),
  });

  it('names a window that fits, built to check', () => {
    const whole = buildRedraw(dense, OPTS);
    const cap = Math.floor(whole.bytes / 3);
    expect(whole.bytes).toBeGreaterThan(cap);
    const w = windowThatFits(dense, OPTS, whole, cap)!;
    expect(w).not.toBeNull();
    expect(buildRedraw(dense, { ...OPTS, window: w }).bytes).toBeLessThanOrEqual(cap);
  });

  it('says none fits when even a small window is over', () => {
    const whole = buildRedraw(dense, OPTS);
    expect(windowThatFits(dense, OPTS, whole, 100)).toBeNull();
  });
});
