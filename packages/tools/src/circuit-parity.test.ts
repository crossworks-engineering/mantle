/**
 * DWG bones phase 6, "same check for every author": circuit_trace's result
 * carries the steps every author reads (`workflow`, the text the internal
 * agents' skills carry too: server/web circuit-steps.test.ts), its `next`
 * says circuit_verify runs at most once per trace in a turn, and the
 * drawing it returns is plain data: the image check's answers are plain
 * words in the labels, with no marks, seals or counts. Nothing here
 * spends: circuit_verify is never called.
 *
 * The drawing tables are stubbed; the trace and the template package are
 * real. Synthetic sheets only.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sheets: [] as unknown[] }));

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

import { circuitTraceHandler, CIRCUIT_TOOLS } from './builtins-circuits';
import { questionsFor, sealFieldsOf, type StoredCheck } from './circuit-trace/check';
import { sealOf } from './circuit-trace/check-seal';
import { CIRCUIT, readingSheets } from './circuit-trace/fixtures';
import { traceCircuit } from './circuit-trace/walk';
import { CIRCUIT_DRAWING_STEPS, VERIFY_ONCE } from './circuit-trace/workflow';

beforeAll(() => {
  process.env.MANTLE_MASTER_KEY ??= 'circuit-verify-test-key';
});

type Out = { next: string; workflow: string; pid: unknown; checks?: { items: unknown[] } };
const trace = async () =>
  (
    (await circuitTraceHandler({ circuit: CIRCUIT }, 'anchor')) as {
      output: Out;
    }
  ).output;

describe('circuit_trace tells every author the same steps', () => {
  it('its result carries the steps, and circuit_verify is held to once', async () => {
    const verify = CIRCUIT_TOOLS.find((t) => t.slug === 'circuit_verify')!;
    expect(verify.description).toContain(VERIFY_ONCE);
    h.sheets = readingSheets();
    const out = await trace();
    expect(out.workflow).toBe(CIRCUIT_DRAWING_STEPS);
    expect(out.next).toContain(VERIFY_ONCE);
    expect(out.next).toMatch(/circuit_verify on circuit/);
  });

  it('the drawing is plain data: answers are words in the labels, nothing else', async () => {
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
      crops: '',
    };
    sheets[0]!.checks = [{ ...row, seal: sealOf(sealFieldsOf(q.tableId, row)) }];
    h.sheets = sheets;
    const out = await trace();
    const text = JSON.stringify(out.pid);
    expect(text).toContain('BREAK (FROM IMAGE)');
    expect(text).not.toMatch(/"check"|"checks"|"provenance"|"sig"|"assets"/);
    expect(out.checks?.items).toEqual([expect.objectContaining({ image_says: 'break' })]);
    // An answered trace no longer asks for the check in its hint.
    expect(out.next).not.toMatch(/circuit_verify on circuit/);
  });
});
