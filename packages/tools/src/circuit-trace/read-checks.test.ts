/**
 * The read of a drawing's Checks tab (read.ts readSheet): every column
 * circuit_verify writes comes back on the stored check, the seal among
 * them, so a sealed row applies; a row the read did not carry its Seal for
 * would read as written by hand and never apply. A fake table_sql run, a
 * synthetic sheet: no database, no model.
 */
import { describe, expect, it } from 'vitest';
import type { WorkbookTabRef } from '@mantle/tabledb';
import { CHECK_COLUMNS, CHECK_FIELD, sealedRow, sealFieldsOf, storedCheckOf } from './check';
import { sealOf } from './check-seal';
import { readSheet, type CandidateTable } from './read';

process.env.MANTLE_MASTER_KEY ??= 'circuit-verify-test-key';

const C = '40000-001-01';
const tabRef = (name: string, columns: string[]): WorkbookTabRef =>
  ({
    tabId: name,
    name,
    viewName: `v_${name}`,
    physicalTable: `t_${name}`,
    ftsTable: null,
    rowCount: 1,
    columns: columns.map((c) => ({ colId: c, name: c })),
  }) as unknown as WorkbookTabRef;

const table: CandidateTable = {
  id: 't-1',
  title: 'PID-1',
  description: 'AutoCAD DWG model-space registry ... within 2 drawing units of it',
  sourceFileId: 'f-1',
  revision: 'rev1',
  sourceSha: 'a'.repeat(64),
  source: 'current',
};

/** The table_sql surface of a drawing whose Checks tab holds `row`. */
function fakeRead(row: Record<string, unknown>) {
  const tabs = [
    tabRef('Layers', ['Layer']),
    tabRef('Segments', ['Layer', 'Handle', 'X1', 'Y1', 'X2', 'Y2', 'Length', 'Node 1', 'Node 2']),
    tabRef('Nodes', ['Node', 'X', 'Y', 'Degree', 'Kind', 'Block', 'Block handle', 'Layers']),
    tabRef('Checks', [...CHECK_COLUMNS]),
  ];
  const statements: string[] = [];
  const run = async (_abs: string, q: string) => {
    statements.push(q);
    const out = (columns: string[], rows: unknown[][]) =>
      ({ columns, rows, truncated: false }) as never;
    if (q.includes('"v_Layers"')) return out(['l'], [[`Circuit ${C}`]]);
    if (q.includes('"v_Segments"') && q.includes('IN (') && !q.includes('NOT IN'))
      return out([], [[`Circuit ${C}`, 'A', 0, 0, 20, 0, 20, 1, 2]]);
    if (q.includes('"v_Nodes"'))
      return out(
        [],
        [
          [1, 0, 0, 1, 'end', '', '', `Circuit ${C}`],
          [2, 20, 0, 1, 'end', '', '', `Circuit ${C}`],
        ],
      );
    if (q.includes('"v_Checks"')) {
      // The SELECT list ends at FROM (the WHERE names Circuit again).
      const named = [...q.slice(0, q.indexOf(' FROM ')).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      return out(named, q.includes('OFFSET 0') ? [named.map((c) => row[c])] : []);
    }
    return out([], []);
  };
  return {
    statements,
    deps: { run, surface: async () => ({ abs: '/x', tabs }) },
  };
}

describe('the Checks tab read', () => {
  it('maps every Checks column onto the stored check', () => {
    expect(Object.keys(CHECK_FIELD).sort()).toEqual([...CHECK_COLUMNS].sort());
    const row = Object.fromEntries(CHECK_COLUMNS.map((c) => [c, `v-${c.toLowerCase()}`]));
    const got = storedCheckOf(row) as unknown as Record<string, string>;
    for (const c of CHECK_COLUMNS) expect(got[CHECK_FIELD[c]]).toBe(`v-${c.toLowerCase()}`);
  });

  it('readSheet carries every column, the seal among them, so a sealed row applies', async () => {
    const fields = {
      Key: 'end:A@20.0,0.0',
      Kind: 'end',
      Circuit: C,
      Node: 2,
      Handles: 'A',
      Guess: 'the pipe end #2 belongs to "V-201"',
      Question: 'Does the pipe end connect to "V-201"?',
      Answer: 'yes',
      Reason: 'into its nozzle',
      Trust: 'CHECKED BY IMAGE',
      Model: 'test/vision-model',
      'Checked at': '2026-10-25T12:00:00.000Z',
      Revision: 'rev1',
      File: 'f-1',
      Crops: 'overview c0 c1',
    };
    const seal = sealOf(sealFieldsOf(table.id, storedCheckOf({ ...fields, Seal: '' })));
    const { deps, statements } = fakeRead({ ...fields, Seal: seal });
    const r = await readSheet('o', table, C, deps);
    expect(r.kind).toBe('sheet');
    const checks = r.kind === 'sheet' ? (r.sheet.checks ?? []) : [];
    expect(checks).toHaveLength(1);
    const got = checks[0]! as unknown as Record<string, string>;
    for (const c of CHECK_COLUMNS) {
      const want = c === 'Seal' ? seal : String(fields[c as keyof typeof fields]);
      expect(got[CHECK_FIELD[c]], c).toBe(want);
    }
    expect(sealedRow(table.id, checks[0]!)).toBe(true);
    // Every column was asked for.
    const ask = statements.find((s) => s.includes('"v_Checks"'))!;
    for (const c of CHECK_COLUMNS) expect(ask).toContain(`"${c}"`);
  });
});
