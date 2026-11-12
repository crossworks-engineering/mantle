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
