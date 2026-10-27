/**
 * The Present tools (builtins-presents.ts). What is pinned:
 *
 *  - a save that would not load (a CDN import, an outside URL) is refused
 *    with every problem, and nothing is written;
 *  - `edits` apply only when each `find` names one place; a stale `if_rev`
 *    is a conflict that names the current rev;
 *  - template data is validated before anything is built or saved, and a
 *    template canvas imports the runtime by name (import mode);
 *  - a save is drawn: the picture goes to the MODEL (`modelImages`), never
 *    into `output`, and becomes the poster at the rev it shows; without a
 *    renderer the save still lands and says nobody looked;
 *  - the export writes the template's static SVG (any other canvas a PNG)
 *    and hands back the embed line; with no folder named it goes through
 *    the export gateway (saveExport), stamped with the canvas, and
 *    `overwrite` asks it to replace this canvas's earlier export;
 *  - the delete answers both arms.
 *
 * The content and file layers are stubbed; the template package is real.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCanvas,
  CURRENT_STYLE,
  estimateMeasurer,
  readCanvasData,
  render,
  ROLE_COLOURS,
  SET_NAV_HEIGHT,
  validate,
} from '@mantle/diagram-templates';

const h = vi.hoisted(() => ({
  getPresent: vi.fn(),
  createPresent: vi.fn(),
  savePresentSource: vi.fn(),
  deletePresent: vi.fn(),
  setPresentPoster: vi.fn(async () => true),
  upsertFile: vi.fn(),
  saveExport: vi.fn(),
  listPresents: vi.fn(async () => [] as unknown[]),
  listPresentRevisions: vi.fn(async () => null as unknown),
  getPresentRevisionSource: vi.fn(async () => null as string | null),
  listFiles: vi.fn(async () => [] as { id: string; filename: string }[]),
  fileData: null as Record<string, unknown> | null,
}));

vi.mock('@mantle/content/presents', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content/presents')>();
  return {
    readCanvas: real.readCanvas,
    getPresent: h.getPresent,
    createPresent: h.createPresent,
    savePresentSource: h.savePresentSource,
    deletePresent: h.deletePresent,
    setPresentPoster: h.setPresentPoster,
    updatePresent: vi.fn(),
    listPresents: h.listPresents,
    listPresentRevisions: h.listPresentRevisions,
    getPresentRevisionSource: h.getPresentRevisionSource,
  };
});
vi.mock('@mantle/content', () => ({ nodeUrl: (id: string) => `/n/${id}` }));
vi.mock('@mantle/content/tree', () => ({ guardNewFileIn: vi.fn(async () => undefined) }));
vi.mock('@mantle/files', () => ({
  ensureFolderPath: vi.fn(async ({ path }: { path: string }) => path),
  upsertFile: h.upsertFile,
  saveExport: h.saveExport,
  listFiles: h.listFiles,
  sanitizeFilename: (n: string) => n.toLowerCase(),
}));
vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  // exportClash reads the existing file's data: one row, from the stand-in.
  const q = {
    select: () => q,
    from: () => q,
    where: () => q,
    limit: async () => (h.fileData ? [{ data: h.fileData }] : []),
  };
  return { ...real, db: q };
});
vi.mock('@mantle/app-build', () => ({
  CANVAS_MODULE_SPECIFIERS: ['d3', 'echarts', '@mantle/diagram-templates/browser'],
  buildCanvasCss: vi.fn(async () => ''),
}));

import { PRESENT_TOOLS, DIAGRAM_RENDER_TOOLS } from './builtins-presents';
import { registerCanvasRenderer, type CanvasRenderRequest } from './canvas-render-bridge';
import type { ToolHandlerContext } from './types';

const tool = (slug: string) =>
  [...PRESENT_TOOLS, ...DIAGRAM_RENDER_TOOLS].find((t) => t.slug === slug)!;
const ctx: ToolHandlerContext = { ownerId: 'anchor', surface: { kind: 'web' } };
const ID = '11111111-1111-4111-8111-111111111111';
const PNG = Buffer.from('png-bytes');

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '../../diagram-templates/samples');
const FLOW = JSON.parse(readFileSync(join(SAMPLES, 'flow-ingest.json'), 'utf8')) as Record<
  string,
  unknown
>;

const CANVAS = `<!doctype html>
<html><head><title>Pumps</title><meta name="canvas:size" content="1600x900" /></head>
<body><h1 class="text-2xl">Pump P-1 feeds the drum</h1></body></html>`;

function detail(source: string, rev = 1) {
  return {
    id: ID,
    title: 'Pumps',
    icon: null,
    tags: [],
    description: null,
    summary: null,
    meta: { size: { w: 1600, h: 900 }, theme: 'follow', libs: [], scripts: [], posterAt: null },
    rev,
    hasPoster: false,
    createdAt: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    source,
  };
}

const renders: CanvasRenderRequest[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  renders.length = 0;
  registerCanvasRenderer(null);
  h.createPresent.mockImplementation(async (_o: string, i: { source: string }) => detail(i.source));
  h.savePresentSource.mockImplementation(
    async (_o: string, _id: string, i: { source: string }) => ({
      ok: true,
      present: detail(i.source, 2),
    }),
  );
});

function withRenderer(svg?: string) {
  registerCanvasRenderer(async (req) => {
    renders.push(req);
    return {
      ok: true,
      png: PNG,
      mime: 'image/png' as const,
      width: 1600,
      height: 900,
      consoleErrors: [],
      blocked: [],
      ...(req.exportSvg
        ? { diagram: { ok: true, errors: [], warnings: [], stats: {}, ...(svg ? { svg } : {}) } }
        : {}),
    };
  });
}

describe('present_create', () => {
  it('refuses a canvas that would not load, listing every problem, and writes nothing', async () => {
    const source = CANVAS.replace(
      '</body>',
      `<script type="module">import x from 'https://cdn.example.org/x.js';</script><img src="https://example.org/a.png"></body>`,
    );
    const out = await tool('present_create').handler({ source }, ctx);
    expect(out.ok).toBe(false);
    const error = (out as { error: string }).error;
    expect(error).toContain('cdn.example.org');
    expect(error).toContain('example.org/a.png');
    expect(h.createPresent).not.toHaveBeenCalled();
  });

  it('saves without a renderer and says nobody looked', async () => {
    const out = await tool('present_create').handler({ source: CANVAS }, ctx);
    expect(out.ok).toBe(true);
    const output = (out as { output: { render: { rendered: boolean } } }).output;
    expect(output.render.rendered).toBe(false);
    expect('modelImages' in out).toBe(false);
  });

  it('draws the save, hands the picture to the model and keeps it as the poster', async () => {
    withRenderer();
    const out = await tool('present_create').handler({ source: CANVAS }, ctx);
    expect(out.ok).toBe(true);
    const ok = out as { output: Record<string, unknown>; modelImages?: { base64: string }[] };
    expect(ok.modelImages?.[0]?.base64).toBe(PNG.toString('base64'));
    expect(JSON.stringify(ok.output)).not.toContain(PNG.toString('base64'));
    expect(h.setPresentPoster).toHaveBeenCalledWith('anchor', ID, PNG, 1);
  });

  it('validates template data before building anything', async () => {
    const out = await tool('present_create').handler(
      { template: 'flow', data: { title: 'x', nodes: 'not a list' } },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(h.createPresent).not.toHaveBeenCalled();
  });

  it('builds a template canvas that imports the runtime by name', async () => {
    const out = await tool('present_create').handler({ template: 'flow', data: FLOW }, ctx);
    expect(out.ok).toBe(true);
    const source = (h.createPresent.mock.calls[0]![1] as { source: string }).source;
    expect(source).toContain('<meta name="diagram:template" content="flow@');
    expect(source).toContain("from '@mantle/diagram-templates/browser'");
  });

  it('takes source or a template, not both', async () => {
    const out = await tool('present_create').handler(
      { source: CANVAS, template: 'flow', data: FLOW },
      ctx,
    );
    expect(out.ok).toBe(false);
  });
});

describe('present_update', () => {
  it('applies an edit that names one place', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    const out = await tool('present_update').handler(
      { id: ID, edits: [{ find: 'P-1 feeds', replace: 'P-2 feeds' }], look: false },
      ctx,
    );
    expect(out.ok).toBe(true);
    const saved = h.savePresentSource.mock.calls[0]![2] as { source: string };
    expect(saved.source).toContain('Pump P-2 feeds the drum');
  });

  it('refuses an edit whose find is missing or not unique', async () => {
    h.getPresent.mockResolvedValue(detail(`${CANVAS}<!-- Pump --><!-- Pump -->`));
    const missing = await tool('present_update').handler(
      { id: ID, edits: [{ find: 'P-9', replace: 'x' }] },
      ctx,
    );
    expect((missing as { error: string }).error).toContain('not in the canvas');
    const twice = await tool('present_update').handler(
      { id: ID, edits: [{ find: '<!-- Pump -->', replace: '' }] },
      ctx,
    );
    expect((twice as { error: string }).error).toContain('more than once');
    expect(h.savePresentSource).not.toHaveBeenCalled();
  });

  it('a stale if_rev is a conflict that names the current rev', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS, 4));
    h.savePresentSource.mockResolvedValue({ ok: false, conflict: true, rev: 5 });
    const out = await tool('present_update').handler(
      { id: ID, source: CANVAS.replace('Pumps', 'Pumps 2'), if_rev: 4 },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain('rev 5');
  });

  it('takes one way to change the source', async () => {
    const out = await tool('present_update').handler(
      { id: ID, source: CANVAS, edits: [{ find: 'a', replace: 'b' }] },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(h.getPresent).not.toHaveBeenCalled();
  });

  it('data on a canvas that is no template is refused', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    const out = await tool('present_update').handler({ id: ID, data: FLOW }, ctx);
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain('not a diagram template');
  });
});

describe('present_export', () => {
  it("writes a template canvas's static SVG and returns the embed", async () => {
    const created = await tool('present_create').handler(
      { template: 'flow', data: FLOW, look: false },
      ctx,
    );
    expect(created.ok).toBe(true);
    const source = (h.createPresent.mock.calls[0]![1] as { source: string }).source;
    h.getPresent.mockResolvedValue(detail(source));
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10" role="img" aria-labelledby="t"><title id="t">x</title><desc>A box.</desc><rect width="10" height="10"/></svg>';
    withRenderer(svg);
    h.saveExport.mockResolvedValue({
      file: { id: 'f1', filename: 'ingest.svg', parentPath: 'files' },
      autoFiled: false,
      landedIn: { id: 'w1', name: 'your private workspace (only you)' },
    });
    const out = await tool('present_export').handler({ id: ID, filename: 'ingest.svg' }, ctx);
    expect(out.ok).toBe(true);
    expect(renders[0]!.exportSvg).toBe(true);
    const file = h.saveExport.mock.calls[0]![0] as {
      filename: string;
      bytes: Buffer;
      data: unknown;
      replaceEarlier: boolean;
    };
    expect(file.filename).toBe('ingest.svg');
    expect(file.bytes.toString('utf8')).toBe(svg);
    expect(file.data).toEqual({ exportOf: ID });
    expect(file.replaceEarlier).toBe(false);
    expect(h.upsertFile).not.toHaveBeenCalled();
    const output = (out as { output: Record<string, unknown> }).output;
    expect(output.embed).toBe('![Pumps](media:f1)');
    expect(output.parent_path).toBe('files');
    expect(output.landedIn).toEqual({ id: 'w1', name: 'your private workspace (only you)' });
    // The export never stamps the poster: it may run for a reader.
    expect(h.setPresentPoster).not.toHaveBeenCalled();
  });

  it("draws a template export from the checked data, not the stored source's script", async () => {
    await tool('present_create').handler({ template: 'flow', data: FLOW, look: false }, ctx);
    const stored = (h.createPresent.mock.calls[0]![1] as { source: string }).source;
    // An editor replaced the runtime import with a script of their own.
    const tampered = stored.replace(
      /<script type="module">[\s\S]*?<\/script>/,
      '<script>window.diagram={ready:Promise.resolve({ok:true}),exportSvg:()=>"<svg/>"}</script>',
    );
    h.getPresent.mockResolvedValue(detail(tampered));
    withRenderer('<svg/>');
    await tool('present_export').handler({ id: ID }, ctx);
    const drawn = renders[0]!.canvas.source;
    expect(drawn).not.toContain('window.diagram={');
    expect(drawn).toContain("from '@mantle/diagram-templates/browser'");
  });

  it('refuses an SVG with a namespace prefix or an encoded character', async () => {
    const created = await tool('present_create').handler(
      { template: 'flow', data: FLOW, look: false },
      ctx,
    );
    expect(created.ok).toBe(true);
    const source = (h.createPresent.mock.calls[0]![1] as { source: string }).source;
    h.getPresent.mockResolvedValue(detail(source));
    const base =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10" role="img" aria-labelledby="t"><title id="t">x</title><desc>A box.</desc>';
    for (const bad of [
      `${base}<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script></svg>`,
      `${base}<a href="#x"><text>javascript&#58;x</text></a></svg>`,
    ]) {
      withRenderer(bad);
      const out = await tool('present_export').handler({ id: ID }, ctx);
      expect(out.ok, bad).toBe(false);
    }
    expect(h.upsertFile).not.toHaveBeenCalled();
    expect(h.saveExport).not.toHaveBeenCalled();
  });

  it('with no folder named, overwrite asks the gateway to replace the earlier export', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    withRenderer();
    h.saveExport.mockResolvedValue({
      file: { id: 'f3', filename: 'pumps.png', parentPath: 'files.auto_filed.exports.2026_10' },
      autoFiled: true,
      landedIn: null,
    });
    const out = await tool('present_export').handler(
      { id: ID, filename: 'pumps.png', overwrite: true },
      ctx,
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(h.saveExport.mock.calls[0]![0]).toMatchObject({
      filename: 'pumps.png',
      data: { exportOf: ID },
      replaceEarlier: true,
    });
    expect((out as { output: Record<string, unknown> }).output.landedIn).toBeUndefined();
  });

  it('a name clash in a named folder asks for overwrite instead of replacing the file', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    withRenderer();
    const { ConflictError } = await import('@mantle/std');
    h.upsertFile.mockRejectedValue(new ConflictError('exists'));
    const out = await tool('present_export').handler(
      { id: ID, filename: 'pumps.png', parent_path: 'files.diagrams' },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain('overwrite: true');
    expect((h.upsertFile.mock.calls[0]![0] as { overwrite: boolean }).overwrite).toBe(false);
  });

  it('exports any other canvas as a PNG at twice the pixels', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    withRenderer();
    h.saveExport.mockResolvedValue({
      file: { id: 'f2', filename: 'pumps.png', parentPath: 'files' },
      autoFiled: false,
      landedIn: null,
    });
    const out = await tool('present_export').handler({ id: ID }, ctx);
    expect(out.ok).toBe(true);
    expect(renders[0]!.scale).toBe(2);
    expect((h.saveExport.mock.calls[0]![0] as { filename: string }).filename).toBe('pumps.png');
  });

  it('exports nothing without a renderer', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    const out = await tool('present_export').handler({ id: ID }, ctx);
    expect(out.ok).toBe(false);
    expect(h.upsertFile).not.toHaveBeenCalled();
    expect(h.saveExport).not.toHaveBeenCalled();
  });
});

describe('a pid drawing set', () => {
  const SET = JSON.parse(readFileSync(join(SAMPLES, '../test/pid-set.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  it('saves as one canvas and exports every page stacked, links printed as page references', async () => {
    const created = await tool('present_create').handler(
      { template: 'pid', data: SET, look: false },
      ctx,
    );
    expect(created.ok).toBe(true);
    const source = (h.createPresent.mock.calls[0]![1] as { source: string }).source;
    h.getPresent.mockResolvedValue(detail(source));
    // What the canvas's exportSvg() answers: the set stacked (browser.ts).
    const drawn = render('pid', SET, estimateMeasurer);
    expect(drawn.ok).toBe(true);
    if (!drawn.ok) return;
    withRenderer(drawn.svg);
    h.saveExport.mockResolvedValue({
      file: { id: 'f1', filename: 'circuit.svg', parentPath: 'files' },
      autoFiled: false,
      landedIn: null,
    });
    const out = await tool('present_export').handler({ id: ID, filename: 'circuit.svg' }, ctx);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const file = h.saveExport.mock.calls[0]![0] as { bytes: Buffer };
    const svg = file.bytes.toString('utf8');
    expect(svg.match(/<svg x="0" y=/g)).toHaveLength(3);
    expect(svg).toContain('SEE PAGE 2: PID-1001');
    // The window is sized for one page under the page buttons, not the stack.
    expect(renders[0]!.height).toBeLessThan(drawn.height);
  });

  it('sizes the window for one row of page buttons, however many pages', async () => {
    // 40 pages: the bar is one row that scrolls sideways (browser.ts), so the
    // window is the tallest page and the bar, as for three pages.
    const many = structuredClone(SET) as { pages: { id: string; title: string }[] };
    const extra = many.pages[1]!;
    for (let i = many.pages.length; i < 40; i++)
      many.pages.push({ ...structuredClone(extra), id: `copy-${i}`, title: `PID-${2000 + i}` });
    const v = validate('pid', many);
    expect(v.ok ? [] : v.errors).toEqual([]);
    withRenderer();
    for (const data of [SET, many]) {
      const out = await tool('present_create').handler({ template: 'pid', data }, ctx);
      expect(out.ok, JSON.stringify(out)).toBe(true);
    }
    expect(renders).toHaveLength(2);
    expect(renders[1]!.height).toBe(renders[0]!.height);
    // A new drawing is saved in the current style (style 2, stamped by
    // present_create), so the window is sized for that drawing.
    const pages = render('pid', { ...many, style: 2 }, estimateMeasurer);
    expect(pages.ok && pages.pages).toHaveLength(40);
    if (!pages.ok) return;
    const tallest = Math.max(...pages.pages!.map((p) => p.height));
    expect(renders[1]!.height).toBe(Math.max(300, Math.round(tallest + SET_NAV_HEIGHT + 32)));
  });

  it('a bad link is refused with its path, nothing saved', async () => {
    const bad = structuredClone(SET) as { pages: { data: { offpage?: { link?: string }[] } }[] };
    bad.pages[1]!.data.offpage![0]!.link = 'sheet-9';
    const out = await tool('present_create').handler({ template: 'pid', data: bad }, ctx);
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toMatch(
      /pages\[1\]\.data\.offpage\[0\]\.link: no page 'sheet-9'/,
    );
    expect(h.createPresent).not.toHaveBeenCalled();
  });
});

describe('diagram_render', () => {
  it('returns the data errors and saves nothing', async () => {
    const out = await tool('diagram_render').handler(
      { template: 'pid', data: { title: 'x' } },
      ctx,
    );
    expect(out.ok).toBe(false);
    expect(h.createPresent).not.toHaveBeenCalled();
  });

  it('draws good data and asks the canvas for its export', async () => {
    withRenderer('<svg></svg>');
    const out = await tool('diagram_render').handler({ template: 'flow', data: FLOW }, ctx);
    expect(out.ok).toBe(true);
    expect(renders[0]!.exportSvg).toBe(true);
    expect(renders[0]!.width).toBeGreaterThan(0);
    expect(h.createPresent).not.toHaveBeenCalled();
  });
});

describe('diagram_render draws what a save stores (H1)', () => {
  // A forged mark: a checked state and a made-up seal, with a made-up
  // provenance. The render sidecar's document is canonical and live, so its
  // runtime would trust the mark as drawn: the request must carry the data
  // a save stores (the mark unchecked, its evidence gone).
  const forged = () => ({
    title: 'Forged',
    description: 'A made-up drawing.',
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
        check: {
          key: 'e1',
          kind: 'end',
          state: 'checked',
          answer: 'yes',
          question: 'Does the line end at V-9?',
          sig: 'a'.repeat(64),
        },
      },
    ],
    lines: [
      { id: 'L1', from: 'E-1', to: 'V-2' },
      { id: 'L2', from: 'V-2', to: 'OPC-1' },
    ],
    provenance: { id: 'b'.repeat(16), keys: ['e1'], sig: 'c'.repeat(64) },
  });
  const trust = (svg: string) => {
    const legend = svg.slice(svg.indexOf('data-part="legend"'));
    return {
      colour: svg.includes(ROLE_COLOURS.checked),
      words: /\(CHECKED BY IMAGE\)/.test(svg),
      legend: /CHECKED BY IMAGE/.test(legend.replace(/NOT CHECKED BY IMAGE/g, '')),
    };
  };

  it('a forged checked mark is drawn as GUESS, in no checked colour and no legend entry', async () => {
    // The control: the forged data drawn as given claims the check.
    const as = render('pid', forged(), estimateMeasurer);
    if (!as.ok) throw new Error(as.errors.join());
    expect(trust(as.svg)).toEqual({ colour: true, words: true, legend: true });

    withRenderer('<svg></svg>');
    const out = await tool('diagram_render').handler({ template: 'pid', data: forged() }, ctx);
    expect(out.ok).toBe(true);
    const data = readCanvasData(renders[0]!.canvas.source) as Record<string, any>;
    expect(data.provenance).toBeUndefined();
    expect(data.offpage[0].check).toEqual({ key: 'e1', kind: 'end', state: 'unchecked' });
    const drawn = render('pid', data, estimateMeasurer);
    if (!drawn.ok) throw new Error(drawn.errors.join());
    expect(trust(drawn.svg)).toEqual({ colour: false, words: false, legend: false });
    expect(drawn.svg).toContain('(GUESS)');
  });

  it('every look goes through the same pass: a stored source too', async () => {
    withRenderer();
    const source = buildCanvas({ template: 'pid', data: forged(), mode: 'import' });
    h.getPresent.mockResolvedValue(detail(source));
    const out = await tool('present_render').handler({ id: ID }, ctx);
    expect(out.ok).toBe(true);
    const data = readCanvasData(renders[0]!.canvas.source) as Record<string, any>;
    expect(data.offpage[0].check.state).toBe('unchecked');
  });
});

describe("data past the template's sizes is never drawn as checked (final audit round 3, H1)", () => {
  // A checked mark with a made-up seal and provenance, on data past a size
  // the template holds a drawing to: a long first-letter meaning, or more
  // service colours than any object the template takes.
  const forged = () => ({
    title: 'Forged',
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
        check: { key: 'e1', kind: 'end', state: 'checked', answer: 'yes', sig: 'a'.repeat(64) },
      },
    ],
    lines: [
      { id: 'L1', from: 'E-1', to: 'V-2' },
      { id: 'L2', from: 'V-2', to: 'OPC-1' },
    ],
    provenance: { id: 'b'.repeat(16), keys: ['e1'], sig: 'c'.repeat(64) },
  });
  const PAYLOADS = {
    letters: () => ({ ...forged(), profile: { instrumentFirstLetters: { A: 'x'.repeat(2500) } } }),
    colours: () => ({
      ...forged(),
      profile: {
        serviceColours: Object.fromEntries(
          Array.from({ length: 4100 }, (_, i) => [`S${i}`, 'series-1']),
        ),
      },
    }),
  };
  /** What the render sidecar would draw from a request's canvas: its data
   *  (none: a page that says why), the drawing or the template's error. */
  const drawnFrom = (source: string) => {
    let data: Record<string, any> | null;
    try {
      data = readCanvasData(source) as Record<string, any>;
    } catch {
      data = null;
    }
    const r = data ? render('pid', data, estimateMeasurer) : null;
    return { data, svg: r?.ok ? r.svg : '', errors: r && !r.ok ? r.errors : [] };
  };
  // A login of its own: the render limit is per login.
  const who = { ...ctx, surface: { kind: 'owner', loginId: 'login-h1' } } as ToolHandlerContext;
  const noClaim = (source: string, name: string) => {
    const { data, svg, errors } = drawnFrom(source);
    expect(data?.provenance, name).toBeUndefined();
    expect(data?.offpage?.[0]?.check, name).toBeUndefined();
    const seen = `${svg}${errors.join(' ')}`;
    expect(seen, name).not.toContain('CHECKED BY IMAGE)');
    expect(seen.toLowerCase(), name).not.toContain(ROLE_COLOURS.checked.toLowerCase());
  };

  it('diagram_render and present_create refuse the data, and nothing is drawn or saved', async () => {
    withRenderer('<svg></svg>');
    for (const [name, make] of Object.entries(PAYLOADS)) {
      const out = await tool('diagram_render').handler({ template: 'pid', data: make() }, who);
      expect(out.ok, name).toBe(false);
      expect(JSON.stringify(out), name).toMatch(/larger than a P&ID drawing can hold/);
      const made = await tool('present_create').handler(
        { template: 'pid', data: make(), look: false },
        who,
      );
      expect(made.ok, name).toBe(false);
    }
    expect(renders).toHaveLength(0);
    expect(h.createPresent).not.toHaveBeenCalled();
  });

  it('a stored canvas of either: a look draws a build with nothing vouched for; no export is written', async () => {
    for (const [name, make] of Object.entries(PAYLOADS)) {
      const stored = buildCanvas({ template: 'pid', data: make(), mode: 'import' });
      h.getPresent.mockResolvedValue(detail(stored));
      renders.length = 0;
      withRenderer('<svg></svg>');
      const looked = await tool('present_render').handler({ id: ID }, who);
      expect(looked.ok, name).toBe(true);
      expect(renders.length, name).toBe(1);
      expect(renders[0]!.canvas.source, name).not.toBe(stored);
      noClaim(renders[0]!.canvas.source, name);
      // The template draws only its error from it.
      expect(drawnFrom(renders[0]!.canvas.source).errors.join(' '), name).toMatch(
        /larger than a P&ID drawing can hold/,
      );
      const exported = await tool('present_export').handler({ id: ID }, who);
      expect(exported.ok, name).toBe(false);
      expect(JSON.stringify(exported), name).toMatch(/larger than a P&ID drawing can hold/);
      expect(renders.length, name).toBe(1);
      expect(h.saveExport).not.toHaveBeenCalled();
    }
  });

  it('the poster of a save is drawn from what the save stores (within the sizes)', async () => {
    withRenderer();
    const out = await tool('present_create').handler({ template: 'pid', data: forged() }, who);
    expect(out.ok).toBe(true);
    expect(renders).toHaveLength(1);
    const { data, svg } = drawnFrom(renders[0]!.canvas.source);
    expect(data?.provenance).toBeUndefined();
    expect(data?.offpage[0].check).toEqual({ key: 'e1', kind: 'end', state: 'unchecked' });
    expect(svg).not.toContain('CHECKED BY IMAGE)');
    expect(svg.toLowerCase()).not.toContain(ROLE_COLOURS.checked.toLowerCase());
  });
});

describe('diagram_render says the style it drew', () => {
  const PID = JSON.parse(readFileSync(join(SAMPLES, 'pid-feed-drum.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  it('the current edition, and how to preview an older canvas, when the data names none', async () => {
    withRenderer('<svg></svg>');
    const out = await tool('diagram_render').handler({ template: 'pid', data: PID }, ctx);
    expect(out.ok).toBe(true);
    const o = (out as { output: Record<string, unknown> }).output;
    expect(o.style).toBe(CURRENT_STYLE);
    expect(o.style_note).toMatch(/keeps the style it was saved with/);
  });

  it("the data's own style, without the note", async () => {
    withRenderer('<svg></svg>');
    const out = await tool('diagram_render').handler(
      { template: 'pid', data: { ...PID, style: 1 } },
      ctx,
    );
    const o = (out as { output: Record<string, unknown> }).output;
    expect(o.style).toBe(1);
    expect(o.style_note).toBeUndefined();
  });

  it('a flow drawing has no style edition', async () => {
    withRenderer('<svg></svg>');
    const out = await tool('diagram_render').handler({ template: 'flow', data: FLOW }, ctx);
    expect((out as { output: Record<string, unknown> }).output.style).toBeUndefined();
  });
});

describe('present_delete', () => {
  it('deletes a canvas it finds', async () => {
    h.deletePresent.mockResolvedValue(true);
    const out = await tool('present_delete').handler({ id: ID }, ctx);
    expect(out).toEqual({ ok: true, output: { id: ID } });
  });

  it('answers not found, with the lookup, for one it does not', async () => {
    h.deletePresent.mockResolvedValue(false);
    const out = await tool('present_delete').handler({ id: ID }, ctx);
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain('present_list');
  });
});

describe('the render limit per caller', () => {
  it('one picture at a time and at most twenty in five minutes, per login', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    const who = { ...ctx, surface: { kind: 'owner', loginId: 'login-a' } } as ToolHandlerContext;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    registerCanvasRenderer(async () => {
      await gate;
      return {
        ok: true,
        png: PNG,
        mime: 'image/png',
        width: 1,
        height: 1,
        consoleErrors: [],
        blocked: [],
      };
    });
    const first = tool('present_render').handler({ id: ID }, who);
    const second = await tool('present_render').handler({ id: ID }, who);
    expect(JSON.stringify(second)).toContain('still being drawn');
    // Another login is not held up.
    const other = { ...ctx, surface: { kind: 'owner', loginId: 'login-b' } } as ToolHandlerContext;
    const theirs = tool('present_render').handler({ id: ID }, other);
    release();
    expect(JSON.stringify(await first)).toContain('"rendered":true');
    expect(JSON.stringify(await theirs)).toContain('"rendered":true');
    for (let i = 0; i < 19; i++) await tool('present_render').handler({ id: ID }, who);
    const over = await tool('present_render').handler({ id: ID }, who);
    expect(JSON.stringify(over)).toContain('20 pictures in 5 minutes');
  });
});

describe('the reads and the restore', () => {
  it('present_list lists compact rows; present_get gives the source, or a template canvas its data', async () => {
    h.listPresents.mockResolvedValueOnce([detail(CANVAS)]);
    const list = await tool('present_list').handler({ query: 'pump' }, ctx);
    expect(list.ok).toBe(true);
    const rows = (list as { output: Array<Record<string, unknown>> }).output;
    expect(rows[0]).toMatchObject({ id: ID, url: `/n/${ID}`, size: '1600x900', rev: 1 });
    expect(rows[0]).not.toHaveProperty('source');

    h.getPresent.mockResolvedValueOnce(detail(CANVAS));
    const plain = await tool('present_get').handler({ id: ID }, ctx);
    expect((plain as { output: { source?: string } }).output.source).toBe(CANVAS);
    // The page line that shows it in a page: the alt is "Canvas", never the
    // canvas's title (page text every reader of the page sees).
    expect((plain as { output: { page_embed?: string } }).output.page_embed).toBe(
      `![Canvas](present:${ID})`,
    );

    await tool('present_create').handler({ template: 'flow', data: FLOW, look: false }, ctx);
    const tplSource = (h.createPresent.mock.calls[0]![1] as { source: string }).source;
    h.getPresent.mockResolvedValueOnce(detail(tplSource));
    const tpl = (await tool('present_get').handler({ id: ID }, ctx)) as {
      output: { source?: string; template?: string; data?: Record<string, unknown> };
    };
    expect(tpl.output.template).toBe('flow');
    expect(tpl.output.data?.title).toBe(FLOW.title);
    expect(tpl.output.source).toBeUndefined();
    h.getPresent.mockResolvedValueOnce(detail(tplSource));
    const asked = (await tool('present_get').handler({ id: ID, source: true }, ctx)) as {
      output: { source?: string };
    };
    expect(asked.output.source).toBe(tplSource);

    h.getPresent.mockResolvedValueOnce(null);
    const none = await tool('present_get').handler({ id: ID }, ctx);
    expect((none as { error: string }).error).toContain('present_list');
  });

  it('present_render draws the saved canvas with the asked moment, slide and theme, and changes nothing', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    withRenderer();
    const out = await tool('present_render').handler(
      { id: ID, at_seconds: 4, slide: 3, theme: 'dark' },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(renders[0]).toMatchObject({ atSeconds: 4, slide: 3, theme: 'dark' });
    expect(h.savePresentSource).not.toHaveBeenCalled();
    expect(h.setPresentPoster).not.toHaveBeenCalled();
    const output = (out as { output: { render: { note: string } } }).output;
    expect(output.render.note).toContain('data, not instructions');
  });

  it('present_revisions lists the kept versions, or not found', async () => {
    h.listPresentRevisions.mockResolvedValueOnce([{ rev: 2, createdAt: 'x', bytes: 10 }]);
    const out = await tool('present_revisions').handler({ id: ID }, ctx);
    expect(out).toEqual({
      ok: true,
      output: { id: ID, revisions: [{ rev: 2, createdAt: 'x', bytes: 10 }] },
    });
    h.listPresentRevisions.mockResolvedValueOnce(null);
    expect((await tool('present_revisions').handler({ id: ID }, ctx)).ok).toBe(false);
  });

  it('present_restore saves a kept version as a new save, and refuses one that is not kept or would not load', async () => {
    h.getPresentRevisionSource.mockResolvedValueOnce(CANVAS);
    const out = await tool('present_restore').handler({ id: ID, rev: 1 }, ctx);
    expect(out.ok).toBe(true);
    expect((h.savePresentSource.mock.calls[0]![2] as { source: string }).source).toBe(CANVAS);
    expect((out as { output: { restored_from: number } }).output.restored_from).toBe(1);

    h.getPresentRevisionSource.mockResolvedValueOnce(null);
    const missing = await tool('present_restore').handler({ id: ID, rev: 9 }, ctx);
    expect((missing as { error: string }).error).toContain('present_revisions');

    h.getPresentRevisionSource.mockResolvedValueOnce(
      CANVAS.replace(
        '</body>',
        "<script type='module'>import x from 'https://cdn.example.org/x.js'</script></body>",
      ),
    );
    const refused = await tool('present_restore').handler({ id: ID, rev: 2 }, ctx);
    expect(refused.ok).toBe(false);
    expect(h.savePresentSource).toHaveBeenCalledTimes(1);
  });

  it('present_export in a named folder replaces only an earlier export of the same canvas', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    withRenderer();
    h.listFiles.mockResolvedValue([{ id: 'f9', filename: 'pumps.png' }]);
    h.fileData = { exportOf: 'another-canvas' };
    const named = { id: ID, filename: 'pumps.png', overwrite: true, parent_path: 'files.diagrams' };
    const refused = await tool('present_export').handler(named, ctx);
    expect((refused as { error: string }).error).toContain('not an export of this canvas');
    expect(h.upsertFile).not.toHaveBeenCalled();
    h.fileData = { exportOf: ID };
    h.upsertFile.mockResolvedValue({ id: 'f9', filename: 'pumps.png' });
    const ok = await tool('present_export').handler(named, ctx);
    expect(ok.ok).toBe(true);
    expect(h.upsertFile.mock.calls[0]![0]).toMatchObject({
      overwrite: true,
      data: { exportOf: ID },
    });
    expect('modelImages' in ok).toBe(false);
    h.fileData = null;
    h.listFiles.mockResolvedValue([]);
  });
});
