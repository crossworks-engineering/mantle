/**
 * DWG bones phase 6, "same check for every author": a traced P&ID saved
 * through Claude over MCP and one saved by an internal agent (Draftsman,
 * Presenter) are told the same steps and get the same count of guesses no
 * image has checked, from the same code: circuit_trace's `image_check`,
 * and present_create / present_update's, counted from the drawing's own
 * marks whatever `checks` the author passed. Nothing here spends: the
 * count is reported, circuit_verify is never called.
 *
 * The drawing tables and the canvas store are stubbed; the trace, the
 * template package and the tools are real. Synthetic sheets only.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sheets: [] as unknown[],
  createPresent: vi.fn(),
  getPresent: vi.fn(),
  savePresentSource: vi.fn(),
  getPresentRevisionSource: vi.fn(async () => null as string | null),
}));

vi.mock('./circuit-trace/read', async (importOriginal) => {
  const real = await importOriginal<typeof import('./circuit-trace/read')>();
  return {
    ...real,
    dwgTables: vi.fn(async () => ({
      tables: h.sheets.map((_, i) => ({ id: `t${i}`, title: `t${i}` })),
      more: false,
    })),
    readSheet: vi.fn(async (_o: string, t: { id: string }) => ({
      kind: 'sheet',
      sheet: h.sheets[Number(t.id.slice(1))],
    })),
  };
});
vi.mock('@mantle/content/presents', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/content/presents')>();
  // The store is stubbed; what every save runs on the source first (the
  // content layer's honestCanvasSource) is the real one.
  const { honestCanvasSource } = await import('@mantle/content/drawing-seal');
  return {
    readCanvas: real.readCanvas,
    getPresent: h.getPresent,
    createPresent: (o: string, i: { source?: string }) =>
      h.createPresent(o, { ...i, ...(i.source ? { source: honestCanvasSource(i.source) } : {}) }),
    savePresentSource: (o: string, id: string, i: { source: string }) =>
      h.savePresentSource(o, id, { ...i, source: honestCanvasSource(i.source) }),
    deletePresent: vi.fn(),
    setPresentPoster: vi.fn(async () => true),
    updatePresent: vi.fn(),
    listPresents: vi.fn(async () => []),
    listPresentRevisions: vi.fn(async () => null),
    getPresentRevisionSource: h.getPresentRevisionSource,
  };
});
vi.mock('@mantle/app-build', () => ({
  CANVAS_MODULE_SPECIFIERS: ['d3', 'echarts', '@mantle/diagram-templates/browser'],
  buildCanvasCss: vi.fn(async () => ''),
}));
vi.mock('./builtins-diagrams', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./builtins-diagrams')>()),
  readProfileJson: vi.fn(async () => null),
}));

import { buildCanvas, imageCheckSummary, readCanvasData } from '@mantle/diagram-templates';
import { circuitTraceHandler, CIRCUIT_TOOLS } from './builtins-circuits';
import { PRESENT_TOOLS } from './builtins-presents';
import { registerCanvasRenderer } from './canvas-render-bridge';
import { questionsFor, sealFieldsOf, type StoredCheck } from './circuit-trace/check';
import { sealOf } from './circuit-trace/check-seal';
import { CIRCUIT, readingSheets } from './circuit-trace/fixtures';
import { traceCircuit } from './circuit-trace/walk';
import { CIRCUIT_DRAWING_STEPS, VERIFY_ONCE } from './circuit-trace/workflow';
import type { ToolHandlerContext } from './types';

const tool = (slug: string) => PRESENT_TOOLS.find((t) => t.slug === slug)!;
const ID = '22222222-2222-4222-8222-222222222222';
/** The two kinds of author: an internal agent's chat turn, and Claude over
 *  a login's MCP connection. */
const AUTHORS: Record<string, ToolHandlerContext> = {
  agent: { ownerId: 'anchor', surface: { kind: 'web' } },
  mcp: {
    ownerId: 'anchor',
    surface: { kind: 'owner', via: 'mcp', mcp: { via: 'oauth', write: true } },
  },
};

const detail = (source: string, rev = 1) => ({
  id: ID,
  title: 'Circuit',
  icon: null,
  tags: [],
  description: null,
  summary: null,
  meta: { size: { w: 1600, h: 900 }, theme: 'follow', libs: [], scripts: [], posterAt: null },
  rev,
  hasPoster: false,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  source,
});

beforeAll(() => {
  process.env.MANTLE_MASTER_KEY ??= 'circuit-verify-test-key';
});
beforeEach(() => {
  vi.clearAllMocks();
  registerCanvasRenderer(null);
  h.createPresent.mockImplementation(async (_o: string, i: { source: string }) => detail(i.source));
  h.savePresentSource.mockImplementation(
    async (_o: string, _id: string, i: { source: string }) => ({
      ok: true,
      present: detail(i.source, 2),
    }),
  );
});

/** The sheets with one guess answered (a sealed no on the main-line start
 *  that names a break), so the count holds an answered guess too. */
function sheetsWithOneCheck() {
  const sheets = readingSheets();
  const r = traceCircuit(CIRCUIT, sheets);
  const q = questionsFor(r.sheets, r.links, sheets, { max: Infinity }).questions.find(
    (x) => x.kind === 'end' && x.node === 1,
  )!;
  const row: StoredCheck = {
    key: q.key,
    kind: q.kind,
    answer: 'no',
    alt: 'break',
    revision: 'rev1',
    checkedAt: '2026-10-26T09:00:00.000Z',
    model: 'test/vision-model',
    reason: 'a break symbol',
    question: q.question,
    trust: '',
    circuit: CIRCUIT,
    crops: 'overview ov1 c1',
  };
  sheets[0]!.checks = [{ ...row, seal: sealOf(sealFieldsOf(q.tableId, row)) }];
  return sheets;
}

type ImageCheck = { guesses: number; unchecked: number; corrected: number; note: string };

describe('every author gets the same unchecked-guess count', () => {
  it('circuit_trace, then present_create by an agent and over MCP, report one count', async () => {
    h.sheets = sheetsWithOneCheck();
    const traced = await circuitTraceHandler({ circuit: CIRCUIT }, 'anchor');
    expect(traced.ok).toBe(true);
    const out = (traced as { output: Record<string, unknown> }).output;
    const fromTrace = out.image_check as ImageCheck;
    expect(fromTrace.corrected).toBe(1);
    expect(fromTrace.unchecked).toBe(fromTrace.guesses - 1);
    expect(fromTrace.note).toMatch(/not checked by image/);
    // The trace tells every author the same steps, and what to do next.
    expect((out as { workflow: string }).workflow).toBe(CIRCUIT_DRAWING_STEPS);
    expect(out.next).toMatch(/circuit_verify on circuit/);
    // The drawing carries the count the view shows.
    const pid = out.pid as { checks: Record<string, number> };
    expect(pid.checks).toMatchObject({ unchecked: fromTrace.unchecked, corrected: 1 });

    const counts: Record<string, ImageCheck> = {};
    for (const [who, ctx] of Object.entries(AUTHORS)) {
      // An author that drops or forges the summary changes nothing: the
      // count is the drawing's own marks.
      const data = {
        ...pid,
        checks: { guesses: 1, unchecked: 0, checked: 1, unsure: 0, contradicted: 0, corrected: 0 },
      };
      const saved = await tool('present_create').handler(
        { template: 'pid', data, look: false },
        ctx,
      );
      expect(saved.ok, JSON.stringify(saved)).toBe(true);
      counts[who] = (saved as { output: { image_check: ImageCheck } }).output.image_check;
      const source = (h.createPresent.mock.calls.at(-1)![1] as { source: string }).source;
      const stored = readCanvasData(source) as { checks: Record<string, number> };
      expect(stored.checks.unchecked).toBe(fromTrace.unchecked);
    }
    expect(counts.mcp).toEqual(counts.agent);
    expect(counts.agent).toEqual(fromTrace);
  });

  it('present_update reports the count of the new data, the same for both authors', async () => {
    h.sheets = readingSheets();
    const traced = await circuitTraceHandler({ circuit: CIRCUIT }, 'anchor');
    const pid = (traced as { output: { pid: Record<string, unknown> } }).output.pid;
    await tool('present_create').handler(
      { template: 'pid', data: pid, look: false },
      AUTHORS.agent!,
    );
    const source = (h.createPresent.mock.calls[0]![1] as { source: string }).source;
    h.getPresent.mockResolvedValue(detail(source));
    const seen: ImageCheck[] = [];
    for (const ctx of Object.values(AUTHORS)) {
      const out = await tool('present_update').handler({ id: ID, data: pid, look: false }, ctx);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      seen.push((out as { output: { image_check: ImageCheck } }).output.image_check);
    }
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]!.unchecked).toBe(seen[0]!.guesses);
    expect(seen[0]).toMatchObject({ next: expect.stringMatching(/circuit_verify/) });
  });

  it('a drawing that is no trace reports no image check', async () => {
    const out = await tool('present_create').handler(
      {
        template: 'pid',
        data: {
          title: 'Hand drawn',
          equipment: [{ id: 'V-101', type: 'vertical-vessel' }],
          offpage: [{ id: 'OPC-1', direction: 'in', sheet: 'S1' }],
          lines: [{ from: 'OPC-1', to: 'V-101' }],
        },
        look: false,
      },
      AUTHORS.mcp!,
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect((out as { output: Record<string, unknown> }).output.image_check).toBeUndefined();
  });
});

describe('circuit_verify runs at most once per trace in a turn', () => {
  it('its description, and the trace hint that names it, say so', async () => {
    const verify = CIRCUIT_TOOLS.find((t) => t.slug === 'circuit_verify')!;
    // The one sentence every author reads, word for word.
    expect(verify.description).toContain(VERIFY_ONCE);
    h.sheets = readingSheets();
    const traced = await circuitTraceHandler({ circuit: CIRCUIT }, 'anchor');
    const out = (traced as { output: { next: string; workflow: string } }).output;
    expect(out.next).toContain(VERIFY_ONCE);
    expect(out.workflow).toContain(VERIFY_ONCE);
  });
});

describe('no saved pid canvas keeps a count its marks do not hold', () => {
  const FORGED = { guesses: 1, unchecked: 0, checked: 1, unsure: 0, contradicted: 0, corrected: 0 };
  /** A traced drawing's canvas whose stored count says every guess is
   *  checked, while its marks say none is. */
  async function forged() {
    h.sheets = readingSheets();
    const traced = await circuitTraceHandler({ circuit: CIRCUIT }, 'anchor');
    const pid = (traced as { output: { pid: Record<string, unknown> } }).output.pid;
    const source = buildCanvas({
      template: 'pid',
      data: { ...pid, checks: FORGED },
      mode: 'import',
    });
    const own = imageCheckSummary(readCanvasData(source))!;
    expect(own.unchecked).toBe(own.guesses);
    return { source, own };
  }
  const storedOf = (call: unknown[] | undefined) =>
    readCanvasData((call![2] as { source: string }).source) as { checks: unknown };

  it('present_create with a whole source', async () => {
    const { source, own } = await forged();
    for (const ctx of Object.values(AUTHORS)) {
      const out = await tool('present_create').handler({ source, look: false }, ctx);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      const saved = (h.createPresent.mock.calls.at(-1)![1] as { source: string }).source;
      expect(readCanvasData(saved).checks).toEqual(own);
      expect((out as { output: { image_check: unknown } }).output.image_check).toMatchObject(own);
    }
  });

  it('present_update with source, and with edits', async () => {
    const { source, own } = await forged();
    h.getPresent.mockResolvedValue(detail(source));
    const bySource = await tool('present_update').handler(
      { id: ID, source, look: false },
      AUTHORS.mcp!,
    );
    expect(bySource.ok, JSON.stringify(bySource)).toBe(true);
    expect(storedOf(h.savePresentSource.mock.calls.at(-1)).checks).toEqual(own);
    // An edit somewhere else in a canvas that carries the forged count.
    const byEdits = await tool('present_update').handler(
      {
        id: ID,
        edits: [
          {
            find: '<meta name="canvas:theme" content="fixed">',
            replace: '<meta name="canvas:theme" content="fixed">\n',
          },
        ],
        look: false,
      },
      AUTHORS.agent!,
    );
    expect(byEdits.ok, JSON.stringify(byEdits)).toBe(true);
    expect(storedOf(h.savePresentSource.mock.calls.at(-1)).checks).toEqual(own);
  });

  it('present_restore of a kept version', async () => {
    const { source, own } = await forged();
    h.getPresentRevisionSource.mockResolvedValue(source);
    const out = await tool('present_restore').handler({ id: ID, rev: 1 }, AUTHORS.mcp!);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(storedOf(h.savePresentSource.mock.calls.at(-1)).checks).toEqual(own);
    expect((out as { output: { restored_from: number } }).output.restored_from).toBe(1);
  });

  it('a canvas whose count already matches is saved byte for byte', async () => {
    const { source } = await forged();
    h.getPresent.mockResolvedValue(detail(source));
    await tool('present_update').handler({ id: ID, source, look: false }, AUTHORS.agent!);
    const honest = (h.savePresentSource.mock.calls.at(-1)![2] as { source: string }).source;
    await tool('present_update').handler({ id: ID, source: honest, look: false }, AUTHORS.agent!);
    expect((h.savePresentSource.mock.calls.at(-1)![2] as { source: string }).source).toBe(honest);
  });
});

describe('marks are sealed by circuit_trace and kept only so by every save (fix round 2, M-c)', () => {
  type Mark = { key: string; state: string; sig?: string; crops?: string[] };
  /** A traced and verified drawing: one guess corrected from a sealed answer. */
  async function verified() {
    h.sheets = sheetsWithOneCheck();
    const traced = await circuitTraceHandler({ circuit: CIRCUIT }, 'anchor');
    const out = (traced as { output: { pid: Record<string, unknown>; pid_check: unknown } }).output;
    expect(out.pid_check).toMatchObject({ ok: true });
    expect(out.pid.provenance).toMatchObject({ id: expect.any(String), sig: expect.any(String) });
    return out.pid;
  }
  const marks = (data: unknown): Mark[] => {
    const d = data as { pages?: { data: unknown }[] };
    const drawings = d.pages ? d.pages.map((p) => p.data) : [data];
    return drawings.flatMap((x) => {
      const p = x as {
        offpage?: { check?: Mark }[];
        lines?: { checks?: Mark[]; inline?: { check?: Mark }[] }[];
      };
      return [
        ...(p.offpage ?? []).flatMap((o) => (o.check ? [o.check] : [])),
        ...(p.lines ?? []).flatMap((l) => [
          ...(l.checks ?? []),
          ...(l.inline ?? []).flatMap((i) => (i.check ? [i.check] : [])),
        ]),
      ];
    });
  };
  const lastSaved = (m: typeof h.createPresent) =>
    readCanvasData((m.mock.calls.at(-1)!.at(-1) as { source: string }).source);
  /** The data as stored, without the count a save adds, and the style
   *  edition present_create stamps on a new drawing (diagram-templates
   *  style.ts). */
  const same = (stored: Record<string, unknown>, pid: Record<string, unknown>) => {
    const { checks: _a, template: _t, version: _v, style: _s, ...a } = stored;
    const { checks: _b, template: _u, version: _w, ...b } = pid;
    expect(a).toEqual(b);
  };

  it('every mark is sealed under the provenance, which lists every guess', async () => {
    const pid = await verified();
    const all = marks(pid);
    expect(all.length).toBeGreaterThan(1);
    for (const m of all) expect(m.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(all.some((m) => m.state === 'corrected')).toBe(true);
    const keys = (pid.provenance as { keys: string[] }).keys;
    for (const m of all) expect(keys).toContain(m.key);
  });

  it('round-trips unchanged through present_create, present_update and present_restore', async () => {
    const pid = await verified();
    const own = imageCheckSummary(pid);
    // present_create with data, and with the whole source.
    await tool('present_create').handler({ template: 'pid', data: pid, look: false }, AUTHORS.mcp!);
    const created = lastSaved(h.createPresent);
    same(created, pid);
    const source = (h.createPresent.mock.calls.at(-1)![1] as { source: string }).source;
    await tool('present_create').handler({ source, look: false }, AUTHORS.agent!);
    expect((h.createPresent.mock.calls.at(-1)![1] as { source: string }).source).toBe(source);
    // present_update with data, source and edits elsewhere.
    h.getPresent.mockResolvedValue(detail(source));
    await tool('present_update').handler({ id: ID, data: pid, look: false }, AUTHORS.agent!);
    same(lastSaved(h.savePresentSource), pid);
    await tool('present_update').handler({ id: ID, source, look: false }, AUTHORS.mcp!);
    expect((h.savePresentSource.mock.calls.at(-1)![2] as { source: string }).source).toBe(source);
    const edits = [
      {
        find: '<meta name="canvas:theme" content="fixed">',
        replace: '<meta name="canvas:theme" content="fixed">\n',
      },
    ];
    await tool('present_update').handler({ id: ID, edits, look: false }, AUTHORS.mcp!);
    same(lastSaved(h.savePresentSource), pid);
    // present_restore of the kept version.
    h.getPresentRevisionSource.mockResolvedValue(source);
    await tool('present_restore').handler({ id: ID, rev: 1 }, AUTHORS.mcp!);
    expect((h.savePresentSource.mock.calls.at(-1)![2] as { source: string }).source).toBe(source);
    expect(imageCheckSummary(lastSaved(h.savePresentSource))).toEqual(own);
  });

  it('a forged "checked" with made-up evidence is saved unchecked; dropped marks still count', async () => {
    const pid = await verified();
    const own = imageCheckSummary(pid)!;
    const forge = (data: unknown): unknown =>
      JSON.parse(
        JSON.stringify(data, (k, v: unknown) =>
          k === 'check' && v && (v as Mark).state === 'unchecked'
            ? {
                ...(v as Mark),
                state: 'checked',
                answer: 'yes',
                crops: ['00000000-0000-4000-8000-0000000f0f0f'],
              }
            : v,
        ),
      );
    for (const ctx of Object.values(AUTHORS)) {
      const out = await tool('present_create').handler(
        { template: 'pid', data: forge(pid), look: false },
        ctx,
      );
      expect(out.ok, JSON.stringify(out)).toBe(true);
      const stored = lastSaved(h.createPresent);
      expect(imageCheckSummary(stored)).toEqual(own);
      expect(marks(stored).some((m) => m.crops?.includes('made-up'))).toBe(false);
    }
    // Every mark dropped: the provenance still counts each guess, unchecked.
    const stripped = JSON.parse(
      JSON.stringify(pid, (k, v: unknown) => (k === 'check' || k === 'checks' ? undefined : v)),
    ) as Record<string, unknown>;
    await tool('present_create').handler(
      { template: 'pid', data: stripped, look: false },
      AUTHORS.mcp!,
    );
    expect(imageCheckSummary(lastSaved(h.createPresent))).toMatchObject({
      guesses: own.guesses,
      unchecked: own.guesses,
    });
  });
});
