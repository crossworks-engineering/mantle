/**
 * Where the redraw sets each text, on made-up drawings only: the rows of
 * label-fixtures.json are what the parser's registry gives for the drawings
 * of server/parser/cad/tests/label_fixtures.py (every TEXT justification,
 * every MTEXT attachment point, attributes on turned, scaled and mirrored
 * inserts, a small PFD and a small P&ID), each with the point, side, turn
 * and lines a person works out on paper. The parser's test holds the rows to
 * those; this one holds the canvas to them.
 */
import { describe, expect, it } from 'vitest';
import fixtures from './label-fixtures.json';
import { buildRedraw, type RedrawRows, type RedrawText } from './build';

type Row = {
  text: string;
  layer: string;
  x: number;
  y: number;
  height: number | null;
  rotation: number | null;
  width: number | null;
  ax: number | null;
  ay: number | null;
  align: string | null;
  lines: string | null;
  gap: number | null;
  underline: boolean;
  length?: number;
};
type Want = {
  text: string;
  ax: number;
  ay: number;
  align: 'left' | 'center' | 'right';
  rotation: number;
  lines: string | null;
  gap: number | null;
  underline: boolean;
};
const DRAWINGS = fixtures as unknown as Record<string, { texts: Row[]; want: Want[] }>;

/** A registry row as the Texts tab and the row reader hand it on. */
const asText = (r: Row): RedrawText => ({
  text: r.text,
  layer: r.layer,
  x: r.x,
  y: r.y,
  height: r.height,
  rotation: r.rotation,
  width: r.width,
  anchorX: r.ax,
  anchorY: r.ay,
  align: r.align,
  lines: r.lines,
  lineGap: r.gap,
  underline: r.underline,
  length: r.length ?? null,
});

const rowsOf = (texts: RedrawText[]): RedrawRows => ({
  symbols: [],
  placements: [],
  segments: [],
  inserts: [],
  shapes: null,
  texts,
});
const OPTS = { title: 't', source: 's' };

type Drawn = {
  classes: string[];
  x: number;
  y: number;
  size: number;
  turn: number;
  lines: { text: string; dy: number }[];
};

const unesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** The canvas's texts, in row order, read back from its markup. */
function drawnTexts(html: string): Drawn[] {
  const words = html.slice(html.indexOf('<g id="words">'), html.indexOf('</svg>'));
  const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return [...words.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((m) => {
    const tag = m[1]!;
    const spans = [...m[2]!.matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/g)];
    const turn = /rotate\(([-0-9.e]+) /.exec(attr(tag, 'transform') ?? '');
    return {
      classes: (attr(tag, 'class') ?? '').split(' '),
      x: Number(attr(tag, 'x')),
      y: Number(attr(tag, 'y')),
      size: Number(attr(tag, 'font-size')),
      turn: turn ? -Number(turn[1]) : 0,
      lines: spans.length
        ? spans.map((s) => ({ text: unesc(s[2]!), dy: Number(attr(s[1]!, 'dy') ?? 0) }))
        : [{ text: unesc(m[2]!), dy: 0 }],
    };
  });
}

describe('labels: every made-up drawing is set as worked out on paper', () => {
  for (const [name, drawing] of Object.entries(DRAWINGS)) {
    it(`${name}: each text from its own point, side, turn and lines`, () => {
      const got = buildRedraw(rowsOf(drawing.texts.map(asText)), OPTS);
      const drawn = drawnTexts(got.html);
      expect(drawn).toHaveLength(drawing.want.length);
      const [x0, y0] = got.window;
      drawing.want.forEach((w, i) => {
        const d = drawn[i]!;
        const row = drawing.texts[i]!;
        const where = `${name} / ${w.text}`;
        // The point: canvas x from the area's corner, canvas y down.
        expect(d.x, where).toBeCloseTo(w.ax - x0, 2);
        expect(d.y, where).toBeCloseTo(-(w.ay - y0), 2);
        // The side, as a class of the canvas's own style sheet.
        expect(d.classes.includes('c'), where).toBe(w.align === 'center');
        expect(d.classes.includes('r'), where).toBe(w.align === 'right');
        // Never the old top-left hang: an anchored text sits on its baseline.
        expect(d.classes.includes('m'), where).toBe(false);
        expect(d.classes.includes('u'), where).toBe(w.underline);
        expect((((d.turn - w.rotation) % 360) + 360) % 360, where).toBeCloseTo(0, 1);
        expect(d.size, where).toBeCloseTo(row.height! * 1.4, 3);
        // The lines: an empty one is a gap, so the next steps twice.
        const lines = (w.lines ?? w.text).split('\n');
        expect(
          d.lines.map((l) => l.text),
          where,
        ).toEqual(lines.filter(Boolean));
        if (w.lines) {
          let down = 0;
          let k = 0;
          lines.forEach((line, n) => {
            if (!line) return;
            down += d.lines[k]!.dy;
            expect(down, `${where} line ${n}`).toBeCloseTo(n * w.gap!, 3);
            k += 1;
          });
        }
      });
    });
  }
});

describe('labels: the canvas markup', () => {
  const text = (over: Partial<RedrawText>): RedrawText => ({
    text: 'T',
    layer: 'A',
    x: 0,
    y: 0,
    height: 2,
    rotation: 0,
    width: null,
    ...over,
  });
  // A line fixes the area's corner at 0, 0, so the numbers below are plain.
  const withLine = (texts: RedrawText[]): RedrawRows => ({
    ...rowsOf(texts),
    segments: [{ layer: 'A', x1: 0, y1: 0, x2: 100, y2: 100 }],
  });

  it('sets a centred, a right and a left text from the anchor, on the baseline', () => {
    const got = buildRedraw(
      withLine([
        text({ text: 'mid', x: 40, y: 10, anchorX: 50, anchorY: 10, align: 'center' }),
        text({ text: 'end', x: 40, y: 20, anchorX: 60, anchorY: 20, align: 'right' }),
        text({ text: 'start', x: 40, y: 30, anchorX: 40, anchorY: 30, align: 'left' }),
      ]),
      OPTS,
    );
    expect(got.html).toContain('<text class="L0 c" x="50" y="-10" font-size="2.8">mid</text>');
    expect(got.html).toContain('<text class="L0 r" x="60" y="-20" font-size="2.8">end</text>');
    expect(got.html).toContain('<text class="L0" x="40" y="-30" font-size="2.8">start</text>');
    expect(got.html).toContain('#words text.c { text-anchor: middle; }');
    expect(got.html).toContain('#words text.r { text-anchor: end; }');
  });

  it('writes an MTEXT line by line, each from the same x, a line gap apart', () => {
    const got = buildRedraw(
      withLine([
        text({
          text: 'a b c',
          width: 0,
          anchorX: 10,
          anchorY: 50,
          align: 'center',
          lines: 'a\n\nb <c>',
          lineGap: 4,
          rotation: 90,
        }),
      ]),
      OPTS,
    );
    expect(got.html).toContain(
      '<text class="L0 c" x="10" y="-50" font-size="2.8" transform="rotate(-90 10 -50)">' +
        '<tspan x="10">a</tspan><tspan x="10" dy="8">b &lt;c&gt;</tspan></text>',
    );
  });

  it('uses the usual line gap when the row has none', () => {
    const got = buildRedraw(
      withLine([text({ anchorX: 10, anchorY: 50, align: 'left', lines: 'a\nb', height: 3 })]),
      OPTS,
    );
    expect(got.html).toContain('<tspan x="10">a</tspan><tspan x="10" dy="5">b</tspan>');
  });

  it('a one-line text is as long as the drawing has it', () => {
    const got = buildRedraw(
      withLine([
        text({ text: 'ABC', anchorX: 5, anchorY: 5, align: 'right', length: 30 }),
        // More than one line, no anchor, or no length: as the font sets it.
        text({ text: 'A B', anchorX: 5, anchorY: 9, lines: 'A\nB', lineGap: 2, length: 30 }),
        text({ text: 'old', length: 30 }),
        text({ text: 'none', anchorX: 5, anchorY: 1 }),
      ]),
      OPTS,
    );
    expect(got.html.match(/textLength=/g)).toHaveLength(1);
    expect(got.html).toMatch(
      /<text class="L\d+ r" x="[\d.]+" y="-?[\d.]+" font-size="[\d.]+" textLength="30" lengthAdjust="spacingAndGlyphs">ABC</,
    );
  });

  it('underlines a text the drawing underlines', () => {
    const got = buildRedraw(
      withLine([text({ text: 'E-1', anchorX: 5, anchorY: 5, align: 'center', underline: true })]),
      OPTS,
    );
    expect(got.html).toContain('<text class="L0 c u" x="5" y="-5" font-size="2.8">E-1</text>');
    expect(got.html).toContain('#words text.u { text-decoration: underline; }');
  });

  it('a row from before the anchors is set from X, Y as it was (an MTEXT from its top left)', () => {
    const got = buildRedraw(
      withLine([text({ text: 'old', x: 7, y: 9 }), text({ text: 'box', x: 1, y: 2, width: 30 })]),
      OPTS,
    );
    expect(got.html).toContain('<text class="L0" x="7" y="-9" font-size="2.8">old</text>');
    expect(got.html).toContain('<text class="L0 m" x="1" y="-2" font-size="2.8">box</text>');
  });

  it('a window keeps a text by its anchor', () => {
    const rows = withLine([
      text({ text: 'in', x: 5, y: 5, anchorX: 55, anchorY: 55, align: 'center' }),
      text({ text: 'out', x: 55, y: 55, anchorX: 5, anchorY: 5, align: 'center' }),
    ]);
    const got = buildRedraw(rows, { ...OPTS, window: [50, 50, 60, 60] });
    expect(got.html).toContain('>in</text>');
    expect(got.html).not.toContain('>out</text>');
  });

  it('sets the label font to Arial and its metric twins, so a length is the same on every desk', () => {
    const got = buildRedraw(withLine([text({})]), OPTS);
    expect(got.html).toContain('font-family: Arial, Helvetica, "Liberation Sans", sans-serif');
  });
});
