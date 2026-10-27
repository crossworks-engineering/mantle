/**
 * The image check overview of a traced P&ID canvas (overview.ts): what the
 * app's panel and present_get show. Only a pid drawing that names its
 * source gets one; per guess the latest sealed answer at the table's
 * current revision; unsealed rows and older revisions are said in limits,
 * never listed; crops are file ids. The tables and their Checks tabs are
 * stood in. Synthetic ids only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCanvas } from '@mantle/diagram-templates';
import { sealFieldsOf, type StoredCheck } from './check';
import { sealOf } from './check-seal';
import { canvasDataOf, checksOverviewOf, OVERVIEW_SOURCE_MAX, traceSourceOf } from './overview';
import type { CandidateTable } from './read';
import { IMAGE_CHECK_NOTE } from './workflow';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const C1 = '00000000-0000-4000-8000-00000000c001';
const OV = '00000000-0000-4000-8000-0000000000a1';
const CIRCUIT = '10000-001-01';

beforeAll(() => {
  process.env.MANTLE_MASTER_KEY ??= 'circuit-verify-test-key';
});

const table = (id: string, title: string): CandidateTable => ({
  id,
  title,
  description: null,
  sourceFileId: null,
  revision: 'rev1',
});
const row = (tableId: string, over: Partial<StoredCheck>): StoredCheck => {
  const r: StoredCheck = {
    key: 'end:A@20.0,0.0',
    kind: 'end',
    answer: 'yes',
    revision: 'rev1',
    checkedAt: '2026-10-27T09:00:00.000Z',
    model: 'test/vision-model',
    reason: 'into its nozzle',
    question: 'Does the pipe end connect to V-201?',
    trust: '',
    circuit: CIRCUIT,
    crops: `overview ${OV} ${C1} sha256:${'a'.repeat(64)}`,
    ...over,
  };
  return { ...r, seal: sealOf(sealFieldsOf(tableId, r)) };
};
const pid = (trace?: unknown) => ({
  template: 'pid',
  title: `Circuit ${CIRCUIT}`,
  equipment: [{ id: 'V-1', type: 'vertical-vessel' }],
  ...(trace ? { trace } : {}),
});

describe('which canvas has an overview', () => {
  it('only a pid drawing that names its source', () => {
    expect(traceSourceOf(pid({ circuit: CIRCUIT, tables: [T1] }))).toEqual({
      circuit: CIRCUIT,
      tables: [T1],
    });
    expect(traceSourceOf(pid())).toBeNull();
    expect(traceSourceOf({ template: 'flow', trace: { circuit: CIRCUIT, tables: [] } })).toBeNull();
    expect(traceSourceOf(null)).toBeNull();
  });

  it('reads the data block once, size first', async () => {
    const html = buildCanvas({
      template: 'pid',
      data: pid({ circuit: CIRCUIT, tables: [T1] }),
      mode: 'import',
    });
    expect(traceSourceOf(await canvasDataOf(html))?.circuit).toBe(CIRCUIT);
    expect(await canvasDataOf('<html>no template</html>')).toBeNull();
    expect(await canvasDataOf('x'.repeat(OVERVIEW_SOURCE_MAX + 1))).toBeNull();
    // Many opening tags with no close: refused fast, never quadratic.
    const open = '<script type="application/json" id="diagram-data">';
    const many = `<meta name="diagram:template" content="pid@1">${open.repeat(20_000)}`;
    const t = performance.now();
    expect(await canvasDataOf(many)).toBeNull();
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe('the overview', () => {
  it('is empty for a canvas with no traced drawing', async () => {
    const out = await checksOverviewOf('o', pid());
    expect(out).toEqual({ traced: false, note: IMAGE_CHECK_NOTE, circuits: [], limits: [] });
  });

  it('counts the latest sealed answer per guess, lists items, says what it leaves out', async () => {
    const rows = new Map<string, StoredCheck[]>([
      [
        T1,
        [
          row(T1, { answer: 'no', checkedAt: '2026-10-26T09:00:00.000Z' }),
          // The recheck of the same key: the latest wins.
          row(T1, { answer: 'yes', checkedAt: '2026-10-27T09:00:00.000Z' }),
          row(T1, { key: 'valve:h1', kind: 'valve', answer: 'no', alt: 'orifice' }),
          row(T1, { key: 'join:x', kind: 'join', answer: 'unsure', alt: 'gap' }),
          // An older revision and a row typed by hand: not listed.
          row(T1, { key: 'link:z', kind: 'link', revision: 'rev0' }),
          { ...row(T1, { key: 'end:B' }), answer: 'no' },
        ],
      ],
      [T2, []],
    ]);
    const out = await checksOverviewOf('o', pid({ circuit: CIRCUIT, tables: [T1, T2, T2 + 'x'] }), {
      tables: async (_o, ids) =>
        [table(T1, 'PID-1001'), table(T2, 'PID-1002')].filter((t) => ids.includes(t.id)),
      checks: async (_o, t, circuit) => {
        expect(circuit).toBe(CIRCUIT);
        return { rows: rows.get(t.id) ?? [], cut: false };
      },
    });
    expect(out.traced).toBe(true);
    expect(out.note).toBe(IMAGE_CHECK_NOTE);
    const c = out.circuits[0]!;
    expect(c.circuit).toBe(CIRCUIT);
    expect(c.counts).toEqual({ checked: 1, no: 1, unsure: 1 });
    expect(c.items).toHaveLength(3);
    const valve = c.items.find((i) => i.kind === 'valve')!;
    expect(valve).toMatchObject({ answer: 'no', alternative: 'orifice', sheet: 'PID-1001' });
    expect(valve.crops).toEqual([C1]);
    expect(valve.overview).toBe(OV);
    // An alternative only after a no.
    expect(c.items.find((i) => i.kind === 'join')!.alternative).toBeUndefined();
    const said = out.limits.join(' ');
    expect(said).toMatch(/1 of the drawing's 3 drawing tables could not be read/);
    expect(said).toMatch(/1 check of an earlier revision/);
    expect(said).toMatch(/1 row in its Checks tab carries no circuit_verify seal/);
  });

  it('a table whose Checks tab cannot be read is said, never fatal', async () => {
    const out = await checksOverviewOf('o', pid({ circuit: CIRCUIT, tables: [T1] }), {
      tables: async () => [table(T1, 'PID-1001')],
      checks: async () => null,
    });
    expect(out.circuits[0]!.items).toEqual([]);
    expect(out.limits).toEqual(['PID-1001: its Checks tab could not be read.']);
  });
});
