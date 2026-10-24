import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCanvas,
  checkStaticSvg,
  estimateMeasurer,
  readCanvasData,
  render,
  replaceCanvasData,
  validate,
} from './index.ts';
import { el } from './runtime/svg.ts';
import { tagLettersProblem } from './templates/pid/schema.ts';
import { FIRST_LETTERS } from './templates/pid/profile.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = (name: string) =>
  JSON.parse(readFileSync(path.join(ROOT, 'samples', name), 'utf8')) as Record<string, unknown>;
const SAMPLES = readdirSync(path.join(ROOT, 'samples')).filter((f) => f.endsWith('.json'));

/** Text with the SVG namespace (a name, never fetched) taken out. */
const noNs = (s: string) => s.replaceAll('http://www.w3.org/2000/svg', '');

const errorsOf = (template: string, data: unknown): string[] => {
  const r = validate(template, data);
  return r.ok ? [] : r.errors;
};

const minimalFlow = () => ({
  template: 'flow',
  title: 'Two steps',
  description: 'One step leads to the next.',
  nodes: [
    { id: 'a', label: 'First' },
    { id: 'b', label: 'Second' },
  ],
  edges: [{ from: 'a', to: 'b' }],
});

const minimalPid = () => ({
  template: 'pid',
  title: 'Pump',
  description: 'A drum feeds a pump.',
  equipment: [
    { id: 'V-1', type: 'vertical-vessel' },
    { id: 'P-1', type: 'centrifugal-pump' },
  ],
  lines: [{ number: '2"-P-0001-CS150', from: 'V-1', to: 'P-1' }],
  instruments: [{ tag: 'LT-1', on: 'V-1' }],
});

describe('flow validation', () => {
  it('accepts minimal data', () => {
    expect(errorsOf('flow', minimalFlow())).toEqual([]);
  });

  it('requires a title and at least one node', () => {
    const errs = errorsOf('flow', { nodes: [] });
    expect(errs.some((e) => e.startsWith('title: required'))).toBe(true);
    expect(errs.some((e) => e.startsWith('nodes: at least one node'))).toBe(true);
  });

  it('names an unknown field and suggests the right one', () => {
    const d = minimalFlow();
    (d.nodes[0] as Record<string, unknown>).lable = 'oops';
    const errs = errorsOf('flow', d);
    expect(
      errs.some(
        (e) => e.includes("nodes[0]: unknown field 'lable'") && e.includes("did you mean 'label'"),
      ),
    ).toBe(true);
  });

  it('points at a dangling edge end with a suggestion', () => {
    const d = minimalFlow();
    d.edges = [{ from: 'a', to: 'bb' }];
    expect(errorsOf('flow', d)).toContain("edges[0].to: no node with id 'bb' (did you mean 'b'?).");
  });

  it('refuses self loops, duplicate ids, bad enums and group loops', () => {
    const d = {
      ...minimalFlow(),
      nodes: [
        { id: 'a', label: 'First', kind: 'focul' },
        { id: 'a', label: 'Again' },
      ],
      edges: [{ from: 'a', to: 'a' }],
      groups: [
        { id: 'g1', label: 'One', parent: 'g2' },
        { id: 'g2', label: 'Two', parent: 'g1' },
      ],
    };
    const errs = errorsOf('flow', d).join('\n');
    expect(errs).toMatch(/edges\[0\]: an edge from 'a' to itself/);
    expect(errs).toMatch(/nodes\[1\]\.id: id 'a' is already used/);
    expect(errs).toMatch(/nodes\[0\]\.kind: 'focul' is not one of .*did you mean 'focal'/);
    expect(errs).toMatch(/form a loop/);
  });

  it('warns, not errors, over the complexity budget', () => {
    const d = minimalFlow();
    d.nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` }));
    d.edges = [];
    const r = validate('flow', d);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.startsWith('budget: 12 nodes'))).toBe(true);
  });

  it('refuses an unknown template', () => {
    const r = render('chart', {}, estimateMeasurer);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors[0]).toMatch(/not a template/);
  });
});

describe('pid validation', () => {
  it('accepts minimal data', () => {
    expect(errorsOf('pid', minimalPid())).toEqual([]);
  });

  it('reads ISA-5.1 tag letters', () => {
    expect(tagLettersProblem('FIC', FIRST_LETTERS)).toBeNull();
    expect(tagLettersProblem('PSV', FIRST_LETTERS)).toBeNull();
    expect(tagLettersProblem('CIF', FIRST_LETTERS)).toMatch(
      /first letter 'C'|not a function letter/,
    );
    const d = minimalPid();
    d.instruments = [{ tag: 'NXQ-1', on: 'V-1' }];
    expect(errorsOf('pid', d).join('\n')).toMatch(/instruments\[0\]\.tag: 'NXQ-1' does not read/);
  });

  it('checks line numbers against the site profile', () => {
    const d = {
      ...minimalPid(),
      profile: {
        lineNumber: {
          pattern: '^[0-9]+"-[A-Z]+-[0-9]{4}-A1A$',
          example: '2"-P-0001-A1A',
          enforce: 'error',
        },
      },
    };
    const errs = errorsOf('pid', d).join('\n');
    expect(errs).toMatch(
      /lines\[0\]\.number: '2"-P-0001-CS150' does not match the site's line number format \(for example 2"-P-0001-A1A\)/,
    );
    // The default profile only warns.
    const r = validate('pid', {
      ...minimalPid(),
      lines: [{ number: 'L1', from: 'V-1', to: 'P-1' }],
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/does not match the site's line number format/);
  });

  it('suggests equipment types and refuses markup in a custom symbol', () => {
    const d = {
      ...minimalPid(),
      equipment: [
        { id: 'V-1', type: 'vertical-vesel' },
        { id: 'P-1', type: 'centrifugal-pump' },
      ],
      profile: {
        customSymbols: {
          'centrifugal-pump': {
            w: 40,
            h: 40,
            paths: [{ d: 'M0 0L10 10"/><script>alert(1)</script>' }],
          },
        },
      },
    };
    const errs = errorsOf('pid', d).join('\n');
    expect(errs).toMatch(
      /equipment\[0\]\.type: 'vertical-vesel' is not one of .*did you mean 'vertical-vessel'/,
    );
    expect(errs).toMatch(/is not SVG path data/);
  });

  it('keeps a line in one circuit and signals on known tags', () => {
    const d = {
      ...minimalPid(),
      instruments: [
        { tag: 'LT-1', on: 'V-1' },
        { tag: 'LIC-1', location: 'control-room' },
      ],
      signals: [{ from: 'LT-1', to: 'LIC-2' }],
      circuits: [
        { id: 'A', lines: ['2"-P-0001-CS150'] },
        { id: 'B', lines: ['2"-P-0001-CS150'] },
      ],
    };
    const errs = errorsOf('pid', d).join('\n');
    expect(errs).toMatch(
      /signals\[0\]\.to: no instrument or tagged valve 'LIC-2' \(did you mean 'LIC-1'\?\)/,
    );
    expect(errs).toMatch(/already in circuit 'A'/);
  });
});

describe('rendering and the static export', () => {
  it.each(SAMPLES)('renders %s to a static SVG', (file) => {
    const data = sample(file);
    const r = render(String(data.template), data, estimateMeasurer);
    expect(r.ok, r.ok ? '' : r.errors.join('\n')).toBe(true);
    if (!r.ok) return;
    expect(checkStaticSvg(r.svg)).toEqual([]);
    expect(r.width).toBeGreaterThan(0);
    expect(noNs(r.svg)).not.toMatch(/<script|<foreignObject|\son[a-z]+=|https?:\/\//i);
  });

  it('the self-check names what a busy sheet gets wrong (the final audit, D6)', () => {
    const r = render('pid', sample('pid-column-site-profile.json'), estimateMeasurer);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.warnings.join('\n');
    expect(w).toMatch(/circuit 'C-08' box takes in/);
    expect(w).toMatch(/runs through the label of/);
    expect(w).toMatch(/budget: \d+ line crossings/);
    expect(w).toMatch(/budget: \d+ kinds of line/);
    expect(w).toMatch(/size: the drawing is \d+ px wide/);
    // The clean sample stays clean of these.
    const clean = render('pid', sample('pid-feed-drum.json'), estimateMeasurer);
    expect(clean.ok && clean.warnings.filter((x) => /budget|size|runs through/.test(x))).toEqual(
      [],
    );
  });

  it('escapes hostile text from the data', () => {
    const d = minimalFlow();
    d.nodes[0]!.label = '<script>alert(1)</script>';
    (d.nodes[1] as Record<string, unknown>).sublabel = '" onload="alert(1)';
    d.title = 'x</title><script>alert(2)</script>';
    const r = render('flow', d, estimateMeasurer);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(checkStaticSvg(r.svg)).toEqual([]);
    expect(r.svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is deterministic', () => {
    const data = sample('pid-feed-drum.json');
    const a = render('pid', data, estimateMeasurer);
    const b = render('pid', data, estimateMeasurer);
    expect(a.ok && b.ok && a.svg === b.svg).toBe(true);
  });

  it('the committed sample exports are static', () => {
    const out = path.join(ROOT, 'samples/out');
    const svgs = readdirSync(out).filter((f) => f.endsWith('.svg'));
    expect(svgs.length).toBe(SAMPLES.length);
    for (const f of svgs)
      expect(checkStaticSvg(readFileSync(path.join(out, f), 'utf8')), f).toEqual([]);
  });
});

describe('checkStaticSvg', () => {
  const ok = render('flow', minimalFlow(), estimateMeasurer);
  const base = ok.ok ? ok.svg : '';
  const inject = (markup: string) => base.replace('</svg>', `${markup}</svg>`);

  it('passes a rendered drawing', () => {
    expect(checkStaticSvg(base)).toEqual([]);
  });

  it.each([
    ['<script>alert(1)</script>', /forbidden element <script>/],
    ['<rect onload="x()"/>', /event handler/],
    ['<image href="https://example.com/a.png"/>', /forbidden element <image>|external reference/],
    ['<path fill="url(https://example.com/x)"/>', /external reference url/],
    ['<foreignObject></foreignObject>', /forbidden element <foreignObject>/],
    ['<style>@import "x.css";</style>', /forbidden element <style>|@import/],
    ['<animate attributeName="x"/>', /forbidden element <animate>/],
    ['<a href="javascript:x"></a>', /javascript/],
    ['<text font-family="Inter">x</text>', /generic family/],
    ['<rect title=">" onmouseover="x()">', /event handler/],
  ])('catches %s', (markup, problem) => {
    expect(checkStaticSvg(inject(markup)).join('\n')).toMatch(problem);
  });

  it("a '>' in a quoted value does not hide the attributes after it", () => {
    const p = checkStaticSvg(inject('<rect title=">" onmouseover="x()"></rect>')).join('\n');
    expect(p).toMatch(/event handler attribute 'onmouseover='/);
    expect(p).toMatch(/raw '<' or '>'/);
    expect(checkStaticSvg(inject('<rect title="a &gt; b"/>'))).toEqual([]);
  });

  it('needs the title and desc first', () => {
    expect(
      checkStaticSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="1" height="1" role="img" aria-labelledby="t"></svg>',
      ).join('\n'),
    ).toMatch(/<title>/);
  });

  it('the builder refuses scripts and handlers', () => {
    expect(() => el('script')).toThrow();
    expect(() => el('rect', { onclick: 'x' })).toThrow();
  });
});

describe('canvas', () => {
  const runtime = 'window.__mounted=true;';

  it('carries the canvas head and the data block', () => {
    const html = buildCanvas({ template: 'flow', data: minimalFlow(), runtime });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>Two steps</title>');
    expect(html).toContain('<meta name="description" content="One step leads to the next.">');
    expect(html).toContain('<meta name="canvas:size" content="fill">');
    expect(html).toContain('<meta name="diagram:template" content="flow@1">');
    expect(readCanvasData(html)).toMatchObject({
      template: 'flow',
      version: 1,
      title: 'Two steps',
    });
    // Offline: no URL anywhere in the page.
    expect(noNs(html)).not.toMatch(/https?:\/\//);
  });

  it('keeps hostile data inside its block', () => {
    const d = minimalFlow();
    d.nodes[0]!.label = '</script><script>alert(1)</script>';
    const html = buildCanvas({ template: 'flow', data: d, runtime });
    expect(html.match(/<script/g)!.length).toBe(2);
    expect(readCanvasData(html).nodes).toEqual(d.nodes);
  });

  it('replaces the data and keeps the head in step', () => {
    const html = buildCanvas({ template: 'flow', data: minimalFlow(), runtime });
    const next = replaceCanvasData(html, { ...minimalFlow(), title: 'Three steps' });
    expect(next).toContain('<title>Three steps</title>');
    expect(readCanvasData(next).title).toBe('Three steps');
    expect(next).toContain(runtime);
  });

  it('a title with replacement patterns is kept as text', () => {
    const html = buildCanvas({ template: 'flow', data: minimalFlow(), runtime });
    const next = replaceCanvasData(html, {
      ...minimalFlow(),
      title: "Cost $& and $' check",
      description: 'Saves $` too',
    });
    expect(next).toContain("<title>Cost $&amp; and $' check</title>");
    expect(next).toContain('content="Saves $` too"');
  });

  it('import mode loads the runtime by name', () => {
    const html = buildCanvas({ template: 'pid', data: minimalPid(), mode: 'import' });
    expect(html).toContain("import { mount } from '@mantle/diagram-templates/browser'");
  });

  it('the committed templates are canvases under the 1 MB limit', () => {
    for (const name of ['flow', 'pid']) {
      const html = readFileSync(path.join(ROOT, 'templates', `${name}.canvas.html`), 'utf8');
      expect(Buffer.byteLength(html)).toBeLessThan(1_000_000);
      expect(readCanvasData(html).template).toBe(name);
      expect(noNs(html)).not.toMatch(/https?:\/\//);
    }
  });
});
