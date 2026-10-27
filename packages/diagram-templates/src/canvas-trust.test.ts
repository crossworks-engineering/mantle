/**
 * Audit round 5 of the image check marks (DWG bones phase 6): the trust
 * words in the real SVG the live view, the export and a page export draw;
 * trust decided from the data's own `template`, never the head's meta; a
 * typed claim on an element with no mark reads GUESS; the tag scan a save
 * runs is linear; a mark copied with its element holds on neither copy.
 * Synthetic data only.
 */
import { createHmac } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  assetsBlockCount,
  buildCanvas,
  CanvasShapeError,
  canvasTemplate,
  claimsPidTemplate,
  dataBlockCount,
  honestImageChecks,
  isPidData,
  provenanceSealBody,
  readCanvasData,
  signImageChecks,
  withHonestImageChecks,
  withoutMarkWords,
} from './index.ts';
import { mount, type DiagramApi } from './browser.ts';

type Obj = Record<string, any>;

/** A drawing whose three marks say three different things: a checked
 *  connector, a line whose join the image said no to, and a line whose
 *  valve the image corrected. */
const marked = (): Obj => ({
  title: 'Trust words',
  description: 'Made-up marks.',
  style: 2,
  equipment: [
    { id: 'E-1', type: 'shell-tube-exchanger' },
    { id: 'V-2', type: 'vertical-vessel' },
  ],
  offpage: [
    {
      id: 'OPC-1',
      direction: 'out',
      sheet: 'V-9',
      text: 'NEAR V-9',
      check: { key: 'e1', kind: 'end', state: 'checked', answer: 'yes' },
    },
  ],
  lines: [
    {
      id: 'L1',
      from: 'E-1',
      to: 'V-2',
      note: 'JOINS',
      checks: [{ key: 'j1', kind: 'join', state: 'contradicted', answer: 'no' }],
    },
    {
      id: 'L2',
      from: 'V-2',
      to: 'OPC-1',
      note: 'VALVE TYPE',
      inline: [
        {
          type: 'orifice',
          tag: 'FE-1',
          check: { key: 'v1', kind: 'valve', state: 'corrected', answer: 'no', alt: 'orifice' },
        },
      ],
    },
  ],
});

/** Each label drawn with its trust word: the label's text, then the word
 *  in the template's own tspan. */
const worded = (svg: string) =>
  [...svg.matchAll(/>([^<>]*)<tspan data-part="mark-word"[^>]*>([^<]*)<\/tspan>/g)]
    .map((m) => `${m[1]}${m[2]}`)
    .sort();
const WORDS = [
  'JOINS (GUESS, IMAGE: NO)',
  'NEAR V-9 (CHECKED BY IMAGE)',
  'VALVE TYPE (FROM IMAGE)',
];

/** Mount a canvas in jsdom, its runtime's script left inert in its place. */
async function mounted(html: string): Promise<{ api: DiagramApi; doc: Document }> {
  // jsdom runs no script (no runScripts): the runtime's import stays as
  // buildCanvas wrote it, which the runtime reads as the canonical layout.
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  const win = dom.window;
  (win.SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = function (
    this: Element,
  ) {
    return { x: 0, y: 0, width: (this.textContent ?? '').length * 6, height: 10 } as DOMRect;
  };
  const g = globalThis as { window?: unknown };
  const had = g.window;
  g.window = win;
  try {
    const api = mount(win.document);
    await api.ready;
    return { api, doc: win.document };
  } finally {
    g.window = had;
  }
}
const canvas = (data: unknown) => buildCanvas({ template: 'pid', data, mode: 'import' });
const live = (doc: Document) => doc.getElementById('diagram')!.innerHTML;

describe("the real SVG draws each mark's words (H1)", () => {
  it('one drawing: the live view, exportSvg and exportPageSvg', async () => {
    const { api, doc } = await mounted(canvas(marked()));
    for (const svg of [live(doc), api.exportSvg(), api.exportPageSvg()]) {
      expect(worded(svg)).toEqual(WORDS);
      // The inline item's tag carries no word: its mark is the line's note's.
      expect(svg).toMatch(/>FE-1</);
    }
  });

  it('a set: each page live and exported, and the stacked export', async () => {
    const second = marked();
    second.lines[0].checks = [{ key: 'j1', kind: 'join', state: 'checked', answer: 'yes' }];
    const set = {
      title: 'Trust set',
      description: 'Two made-up pages.',
      style: 2,
      pages: [
        { id: 'a', title: 'A', data: marked() },
        { id: 'b', title: 'B', data: second },
      ],
    };
    const { api, doc } = await mounted(canvas(set));
    const b = [
      'JOINS (CHECKED BY IMAGE)',
      'NEAR V-9 (CHECKED BY IMAGE)',
      'VALVE TYPE (FROM IMAGE)',
    ];
    expect(worded(live(doc))).toEqual(WORDS);
    expect(worded(api.exportPageSvg('a'))).toEqual(WORDS);
    expect(api.show('b')).toBe(true);
    expect(worded(live(doc))).toEqual(b);
    expect(worded(api.exportPageSvg('b'))).toEqual(b);
    expect(worded(api.exportSvg())).toEqual([...WORDS, ...b].sort());
  });
});

describe('trust from the data, never the meta (M1)', () => {
  const noTemplate = (html: string) =>
    html.replace(/"template": "pid",\n\s*/, '').replace(/"version": 1,\n\s*/, '');

  it('the data block decides: isPidData, canvasTemplate, and the save claims it', () => {
    const html = canvas(marked());
    expect(isPidData(readCanvasData(html))).toBe(true);
    expect(canvasTemplate(html)?.template).toBe('pid');
    expect(isPidData({ template: 'PID' })).toBe(false);
    expect(isPidData(null)).toBe(false);
    // The data names pid, the meta another template: a pid canvas.
    const flowMeta = html.replace('content="pid@', 'content="flow@');
    expect(claimsPidTemplate(flowMeta)).toBe(true);
    expect(() => withHonestImageChecks(flowMeta, () => true)).toThrow(CanvasShapeError);
  });

  it('a canvas whose data names no template draws every mark unchecked, whatever its meta', async () => {
    const html = noTemplate(canvas(marked()));
    expect(readCanvasData(html).template).toBeUndefined();
    expect(canvasTemplate(html)).toBeNull();
    const { api, doc } = await mounted(html);
    // The meta still picks what to draw.
    expect(api.template).toBe('pid');
    for (const svg of [live(doc), api.exportSvg()]) {
      expect(svg).not.toContain('CHECKED BY IMAGE)');
      expect(svg).not.toContain('FROM IMAGE');
      expect(worded(svg)).toContain('NEAR V-9 (GUESS)');
    }
  });

  it('a meta written with named references claims the template, and a save refuses it', async () => {
    const named = noTemplate(canvas(marked())).replace(
      '<meta name="diagram:template" content="pid@1">',
      '<meta name="diagram&colon;template" content="pid&commat;1">',
    );
    expect(named).toContain('diagram&colon;template');
    expect(claimsPidTemplate(named)).toBe(true);
    expect(claimsPidTemplate(named.replace('&commat;', '&#64;'))).toBe(true);
    expect(() => withHonestImageChecks(named, () => true)).toThrow(CanvasShapeError);
    // Were it stored anyway, the runtime would vouch for nothing in it.
    const { doc } = await mounted(named);
    expect(live(doc)).not.toContain('CHECKED BY IMAGE)');
  });

  it('the canvas as buildCanvas writes it, its data naming pid, draws the marks as stored', async () => {
    const { doc } = await mounted(canvas(marked()));
    expect(worded(live(doc))).toEqual(WORDS);
  });
});

describe('a typed claim on an element with no mark reads GUESS (M2)', () => {
  const plain = (text: string, note: string): Obj => ({
    title: 'Before the marks',
    equipment: [{ id: 'V-2', type: 'vertical-vessel' }],
    offpage: [{ id: 'OPC-1', direction: 'out', sheet: 'V-9', text }],
    lines: [{ id: 'L1', from: 'V-2', to: 'OPC-1', note }],
  });
  it.each([
    ['NEAR V-9 (CHECKED BY IMAGE)', 'NEAR V-9 (GUESS)'],
    ['AT V-9 (FROM IMAGE)', 'AT V-9 (GUESS)'],
    ['NEAR V-9 (GUESS, IMAGE: NO)', 'NEAR V-9 (GUESS)'],
    ['NEAR V-9 (checked  by\nimage)', 'NEAR V-9 (GUESS)'],
    ['NEAR V-9 (CHECKED BY (GUESS) IMAGE)', 'NEAR V-9 (GUESS)'],
    ['NEAR V-9 (GUESS) (CHECKED BY IMAGE)', 'NEAR V-9 (GUESS)'],
    ['NEAR V-9 (GUESS)', 'NEAR V-9 (GUESS)'],
    ['NEAR V-9', 'NEAR V-9'],
  ])('%j becomes %j, and stays so', (typed, want) => {
    const out = withoutMarkWords(plain(typed, typed));
    expect(out.offpage[0].text).toBe(want);
    expect(out.lines[0].note).toBe(want);
    expect(withoutMarkWords(out)).toBe(out);
  });

  it("a marked element keeps no typed word: the view draws the mark's", () => {
    const d = marked();
    d.offpage[0].text = 'NEAR V-9 (FROM IMAGE)';
    expect(withoutMarkWords(d).offpage[0].text).toBe('NEAR V-9');
  });
});

describe('the tag scan a save runs is linear (M3)', () => {
  const SIZE = 1_100_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  /** Every reader of the scan, once, on a fresh string (no cached scan). */
  const timed = (unit: string) => {
    const html = `${fill(unit)}${Math.random()}`;
    const t = performance.now();
    claimsPidTemplate(html);
    dataBlockCount(html);
    dataBlockCount(html, { loose: false });
    assetsBlockCount(html);
    return { ms: performance.now() - t, html };
  };

  it('1.1 MB of "<a" is read well under 200 ms', () => {
    timed('<a b>');
    expect(timed('<a').ms).toBeLessThan(200);
  });

  it.each(['<a x="', "<a x='", '<a x=', '<a\t', '<a id ', '<a x="1"y', '<a"""'])(
    '1.1 MB of %j is read in linear time',
    (unit) => {
      expect(timed(unit).ms).toBeLessThan(1000);
    },
  );

  it('ids too costly to read count as the block: a slow document is refused, never misread', () => {
    const { html, ms } = timed('<a/id=&<a/id=&');
    expect(ms).toBeLessThan(1000);
    expect(dataBlockCount(html).any).toBeGreaterThan(1);
    expect(dataBlockCount(html, { loose: false }).any).toBeGreaterThan(1);
  });

  it('the scan still reads every form of the id a browser reads', () => {
    const page = (tag: string) =>
      `${tag}<script type="application/json" id="diagram-data">{}</script>`;
    expect(dataBlockCount(page('<p id="x">')).any).toBe(1);
    expect(dataBlockCount(page('<p/ID=diagram&#45;data>')).any).toBe(2);
    expect(dataBlockCount(page("<p title='<i id=diagram-data>'>")).any).toBe(2);
    expect(dataBlockCount(page('<p a="1"id="diagram-data">')).any).toBe(2);
  });
});

describe('a mark copied with its element holds on neither copy (LOW)', () => {
  const seal = (body: string) => createHmac('sha256', 'test-key').update(body).digest('hex');
  const holds = (body: string, sig: string) => seal(body) === sig;
  const PROV = '0123456789abcdef';
  const traced = (lineId: string | null = 'L1'): Obj => {
    const d: Obj = {
      title: 'Traced',
      equipment: [{ id: 'V-2', type: 'vertical-vessel' }],
      offpage: [
        {
          id: 'OPC-1',
          direction: 'out',
          sheet: 'V-9',
          text: 'NEAR V-9',
          check: { key: 'e1', kind: 'end', state: 'checked', answer: 'yes' },
        },
      ],
      lines: [
        {
          ...(lineId ? { id: lineId } : {}),
          from: 'V-2',
          to: 'OPC-1',
          checks: [{ key: 'j1', kind: 'join', state: 'checked', answer: 'yes' }],
        },
      ],
    };
    const keys = ['e1', 'j1'];
    return {
      ...signImageChecks(d, PROV, seal),
      provenance: { id: PROV, keys, sig: seal(provenanceSealBody({ id: PROV, keys }, d)) },
    };
  };
  const states = (d: Obj) => [
    ...d.offpage.map((o: Obj) => o.check.state),
    ...d.lines.flatMap((l: Obj) => l.checks.map((c: Obj) => c.state)),
  ];

  it('the traced drawing holds; a line or a connector copied, or a line without its id, does not', () => {
    const d = traced();
    expect(honestImageChecks(d, holds)).toBe(d);
    // A copied line is one more line ending at the connector too: its
    // check covered the lines that end there (H3), so it goes as well.
    const twoLines = { ...d, lines: [d.lines[0], { ...d.lines[0] }] };
    expect(states(honestImageChecks(twoLines, holds))).toEqual([
      'unchecked',
      'unchecked',
      'unchecked',
    ]);
    const twoEnds = { ...d, offpage: [d.offpage[0], { ...d.offpage[0] }] };
    expect(states(honestImageChecks(twoEnds, holds))).toEqual([
      'unchecked',
      'unchecked',
      'checked',
    ]);
    // Sealed with no id: the site names no element alone.
    expect(states(honestImageChecks(traced(null), holds))).toEqual(['checked', 'unchecked']);
  });
});

describe('the runtime trusts marks only under its own import, on the live document (M2)', () => {
  /** Mount `html` in the runtime's window: its own document (live), one
   *  parsed from a string, or another window's document. */
  async function mountOn(html: string, how: 'live' | 'parsed' | 'other frame'): Promise<string> {
    const windowOf = () => {
      const w = new JSDOM(html, { pretendToBeVisual: true }).window;
      (w.SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = function (
        this: Element,
      ) {
        return { x: 0, y: 0, width: (this.textContent ?? '').length * 6, height: 10 } as DOMRect;
      };
      return w;
    };
    const win = windowOf();
    const doc =
      how === 'parsed'
        ? new win.DOMParser().parseFromString(html, 'text/html')
        : how === 'other frame'
          ? windowOf().document
          : win.document;
    const g = globalThis as { window?: unknown };
    const had = g.window;
    g.window = win;
    try {
      const api = mount(doc);
      await api.ready;
      return doc.getElementById('diagram')!.innerHTML;
    } finally {
      g.window = had;
    }
  }

  it('the import buildCanvas writes, on the live document: the marks as stored', async () => {
    expect(worded(await mountOn(canvas(marked()), 'live'))).toEqual(WORDS);
  });

  it('a document parsed from a string, or another frame’s: every mark unchecked', async () => {
    for (const how of ['parsed', 'other frame'] as const) {
      const svg = await mountOn(canvas(marked()), how);
      expect(worded(svg), how).not.toEqual(WORDS);
      expect(svg, how).not.toContain('CHECKED BY IMAGE)');
      expect(svg, how).not.toContain('FROM IMAGE)');
    }
  });

  it('an inline runtime, or the import with anything changed: every mark unchecked', async () => {
    const html = canvas(marked());
    const inline = buildCanvas({ template: 'pid', data: marked(), runtime: 'mount()' });
    const variants = [
      inline,
      html.replace('mount();</script>', 'mount(); </script>'),
      html.replace('<script type="module">', '<script type="module" src="/x.js">'),
      html.replace('<script type="module">', '<script type="module" async>'),
    ];
    for (const v of variants) {
      expect(v).not.toBe(html);
      const svg = await mountOn(v, 'live');
      expect(svg).not.toContain('CHECKED BY IMAGE)');
      expect(svg).not.toContain('FROM IMAGE)');
    }
  });
});
