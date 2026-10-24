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
 *    and hands back the embed line;
 *  - the delete answers both arms.
 *
 * The content and file layers are stubbed; the template package is real.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getPresent: vi.fn(),
  createPresent: vi.fn(),
  savePresentSource: vi.fn(),
  deletePresent: vi.fn(),
  setPresentPoster: vi.fn(async () => true),
  upsertFile: vi.fn(),
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
    listPresents: vi.fn(async () => []),
    listPresentRevisions: vi.fn(async () => []),
    getPresentRevisionSource: vi.fn(async () => null),
  };
});
vi.mock('@mantle/content', () => ({ nodeUrl: (id: string) => `/n/${id}` }));
vi.mock('@mantle/content/tree', () => ({ guardNewFileIn: vi.fn(async () => undefined) }));
vi.mock('@mantle/files', () => ({
  ensureFolderPath: vi.fn(async ({ path }: { path: string }) => path),
  upsertFile: h.upsertFile,
}));
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
    h.upsertFile.mockResolvedValue({ id: 'f1', filename: 'ingest.svg' });
    const out = await tool('present_export').handler({ id: ID, filename: 'ingest.svg' }, ctx);
    expect(out.ok).toBe(true);
    expect(renders[0]!.exportSvg).toBe(true);
    const file = h.upsertFile.mock.calls[0]![0] as { filename: string; bytes: Buffer };
    expect(file.filename).toBe('ingest.svg');
    expect(file.bytes.toString('utf8')).toBe(svg);
    expect((out as { output: { embed: string } }).output.embed).toBe('![Pumps](media:f1)');
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
  });

  it('a name clash asks for overwrite instead of replacing the file', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    withRenderer();
    const { ConflictError } = await import('@mantle/std');
    h.upsertFile.mockRejectedValue(new ConflictError('exists'));
    const out = await tool('present_export').handler({ id: ID, filename: 'pumps.png' }, ctx);
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain('overwrite: true');
    expect((h.upsertFile.mock.calls[0]![0] as { overwrite: boolean }).overwrite).toBe(false);
  });

  it('exports any other canvas as a PNG at twice the pixels', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    withRenderer();
    h.upsertFile.mockResolvedValue({ id: 'f2', filename: 'pumps.png' });
    const out = await tool('present_export').handler({ id: ID }, ctx);
    expect(out.ok).toBe(true);
    expect(renders[0]!.scale).toBe(2);
    expect((h.upsertFile.mock.calls[0]![0] as { filename: string }).filename).toBe('pumps.png');
  });

  it('exports nothing without a renderer', async () => {
    h.getPresent.mockResolvedValue(detail(CANVAS));
    const out = await tool('present_export').handler({ id: ID }, ctx);
    expect(out.ok).toBe(false);
    expect(h.upsertFile).not.toHaveBeenCalled();
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
