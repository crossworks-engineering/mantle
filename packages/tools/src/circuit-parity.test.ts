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
  return {
    readCanvas: real.readCanvas,
    getPresent: h.getPresent,
    createPresent: h.createPresent,
    savePresentSource: h.savePresentSource,
    deletePresent: vi.fn(),
    setPresentPoster: vi.fn(async () => true),
    updatePresent: vi.fn(),
    listPresents: vi.fn(async () => []),
    listPresentRevisions: vi.fn(async () => null),
    getPresentRevisionSource: vi.fn(async () => null),
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

import { readCanvasData } from '@mantle/diagram-templates';
import { circuitTraceHandler } from './builtins-circuits';
import { PRESENT_TOOLS } from './builtins-presents';
import { registerCanvasRenderer } from './canvas-render-bridge';
import { questionsFor, sealFieldsOf, type StoredCheck } from './circuit-trace/check';
import { sealOf } from './circuit-trace/check-seal';
import { CIRCUIT, readingSheets } from './circuit-trace/fixtures';
import { traceCircuit } from './circuit-trace/walk';
import { CIRCUIT_DRAWING_STEPS } from './circuit-trace/workflow';
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
