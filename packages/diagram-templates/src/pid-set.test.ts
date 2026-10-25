/**
 * A `pid` drawing set: pages, links between them, "more here" markers and
 * the stacked export. All tags and sheets here are made up.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCanvas,
  checkStaticSvg,
  estimateMeasurer,
  readCanvasData,
  render,
  validate,
} from './index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
type Obj = Record<string, any>;
const set = (): Obj =>
  JSON.parse(readFileSync(path.join(ROOT, 'test/pid-set.json'), 'utf8')) as Obj;
const errorsOf = (data: unknown): string => {
  const r = validate('pid', data);
  return r.ok ? '' : r.errors.join('\n');
};
const draw = (data: unknown) => {
  const r = render('pid', data, estimateMeasurer);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r;
};

describe('a pid drawing set', () => {
  it('checks clean and draws every page', () => {
    expect(errorsOf(set())).toBe('');
    const r = draw(set());
    expect(r.pages?.map((p) => [p.id, p.title])).toEqual([
      ['overview', 'Overview'],
      ['sheet-1', 'PID-1001'],
      ['sheet-2', 'PID-1002'],
    ]);
    expect(r.stats.pages).toBe(3);
  });

  it('prints every link as a page reference, and marks it for the canvas to follow', () => {
    const r = draw(set());
    const [overview, one, two] = r.pages!;
    // The marker on the overview: its text, the page it goes to, the element.
    expect(overview!.svg).toMatch(
      /<g data-more="L1" data-link="sheet-1" data-focus="L1-1">.*\+3 DEADLEGS.*SEE PAGE 2: PID-1001/,
    );
    // Sheet connectors jump to the neighbour sheet's page.
    expect(one!.svg).toContain('data-offpage="OPC-1" data-link="sheet-2" data-focus="L1-2"');
    expect(one!.svg).toContain('SEE PAGE 3: PID-1002');
    expect(two!.svg).toContain('data-offpage="OPC-1" data-link="sheet-1" data-focus="L1-1"');
    expect(two!.svg).toContain('SEE PAGE 2: PID-1001');
    // A guess stays marked on every page it is drawn on.
    expect(overview!.svg).toContain('INFERRED JOIN (GUESS)');
    expect(two!.svg).toContain('INFERRED JOIN (GUESS)');
  });

  it('exports all pages stacked as one static SVG with unique ids', () => {
    const r = draw(set());
    expect(checkStaticSvg(r.svg)).toEqual([]);
    for (const p of r.pages!) expect(checkStaticSvg(p.svg), p.id).toEqual([]);
    // Each page once, under its header, in order.
    const heads = [...r.svg.matchAll(/>(PAGE \d+ OF 3: [^<]+)</g)].map((m) => m[1]);
    expect(heads).toEqual([
      'PAGE 1 OF 3: OVERVIEW',
      'PAGE 2 OF 3: PID-1001',
      'PAGE 3 OF 3: PID-1002',
    ]);
    expect(r.svg.match(/<svg x="0" y="[\d.]+"/g)).toHaveLength(3);
    const ids = [...r.svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.svg).not.toMatch(/<a[\s>]|href=|<script/i);
    // The static copy still says where every link goes.
    expect(r.svg).toContain('SEE PAGE 3: PID-1002');
  });

  it('pins the set output', () => {
    const r = draw(set());
    expect({
      svg: hash(r.svg),
      pages: r.pages!.map((p) => hash(p.svg)),
      warnings: hash(JSON.stringify(r.warnings)),
    }).toMatchInlineSnapshot(`
      {
        "pages": [
          "9bce45eff2797539cd395486",
          "d1680f21bcd69a3e1dd688dc",
          "aedc9bace8b18fb6faed7b10",
        ],
        "svg": "0b66ca6a6c72106baaa96b0f",
        "warnings": "0cd8b9c585556e2e253a47a2",
      }
    `);
  });

  it('round-trips through a canvas', () => {
    const html = buildCanvas({ template: 'pid', data: set(), mode: 'import' });
    expect(readCanvasData(html).pages).toHaveLength(3);
    expect(html).toContain('<title>Circuit 10000-001-01</title>');
  });

  it('gives the set profile to every page and says a problem in it once', () => {
    const d = set();
    d.profile = {
      lineNumber: { pattern: '^[0-9]+"-[A-Z]+-[0-9]{4}-[A-Z][0-9]$', enforce: 'error' },
    };
    expect(errorsOf(d)).toBe('');
    d.profile = { lineNumber: { pattern: '(' } };
    expect(
      errorsOf(d)
        .split('\n')
        .filter((e) => /not a valid regular/.test(e)),
    ).toEqual(['profile.lineNumber.pattern: not a valid regular expression.']);
  });
});

describe('set checks', () => {
  it('a link to a page that is not there, with a suggestion', () => {
    const d = set();
    d.pages[0].data.lines[0].more.link = 'sheet-l';
    expect(errorsOf(d)).toMatch(
      /pages\[0\]\.data\.lines\[0\]\.more\.link: no page 'sheet-l' \(did you mean 'sheet-1'\?\)/,
    );
  });

  it('a focus that names nothing on the target page', () => {
    const d = set();
    d.pages[1].data.offpage[0].focus = 'L9';
    expect(errorsOf(d)).toMatch(
      /pages\[1\]\.data\.offpage\[0\]\.focus: page 'sheet-2' has no line, equipment, connector or tee 'L9'/,
    );
  });

  it('a link to its own page needs a focus', () => {
    const d = set();
    d.pages[1].data.offpage[0].link = 'sheet-1';
    delete d.pages[1].data.offpage[0].focus;
    expect(errorsOf(d)).toMatch(/links to its own page; give 'focus'/);
  });

  it('a link outside a set has nowhere to go', () => {
    const page = set().pages[1].data;
    expect(errorsOf(page)).toMatch(
      /offpage\[0\]\.link: 'sheet-2' is another page, and this drawing has no pages/,
    );
  });

  it('a drawing field on the set itself, duplicate page ids, an empty set', () => {
    const d = set();
    d.lines = [];
    d.pages[2].id = 'sheet-1';
    const e = errorsOf(d);
    expect(e).toMatch(/lines: a set holds its drawings in pages\[\]\.data/);
    expect(e).toMatch(/pages\[2\]\.id: page id 'sheet-1' is already used by pages\[1\]/);
    expect(errorsOf({ title: 'x', pages: [] })).toMatch(/pages: at least one page/);
  });

  it('a page problem names its page', () => {
    const d = set();
    d.pages[2].data.lines[0].to = 'V-2O1';
    expect(errorsOf(d)).toMatch(
      /pages\[2\]\.data\.lines\[0\]\.to: no .* 'V-2O1' \(did you mean 'V-201'\?\)/,
    );
  });
});

describe('a "more here" marker on a single drawing', () => {
  it('draws without a link, and only changes the drawing that has one', () => {
    const page = set().pages[0].data;
    delete page.lines[0].more.link;
    delete page.lines[0].more.focus;
    const r = draw(page);
    expect(r.svg).toContain('<g data-more="L1">');
    expect(r.svg).toContain('+3 DEADLEGS');
    expect(r.svg).not.toContain('data-link');
    expect(r.pages).toBeUndefined();
    delete page.lines[0].more;
    expect(draw(page).svg).not.toContain('data-more');
  });
});
