/**
 * dwg-reindex without a database: the scope and cap rules, the edited-table
 * rule, and that a rebuild writes the SAME table (draft + commit on its id,
 * never a create or a delete). The real-Postgres half is
 * dwg-reindex.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock('@mantle/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ version: 3 }] }) }),
    }),
  },
  nodes: { id: 'id', type: 'type', data: 'data' },
  tables: { version: 'version', nodeId: 'node_id' },
  withHeads: async (ids: string[], _k: string, fn: (tx: unknown) => Promise<unknown>) => {
    calls.log.push(`heads:${ids.join(',')}`);
    const tx = { update: () => ({ set: () => ({ where: async () => [] }) }) };
    return fn(tx);
  },
}));
vi.mock('@mantle/content', () => ({
  tableDocFromGrid: (g: { columns: { name: string }[]; rows: unknown[][] }) => ({
    columns: g.columns.map((c) => ({ id: c.name, name: c.name, type: 'text' })),
    rows: g.rows.map((r, i) => ({ id: String(i), cells: { v: r[0] } })),
  }),
  saveTableDraft: async (_o: string, id: string) => {
    calls.log.push(`draft:${id}`);
    return { ok: true, draftRev: 1 };
  },
  commitTable: async (_o: string, id: string, _d: unknown, opts: { keepSummary?: boolean }) => {
    calls.log.push(`commit:${id}:keepSummary=${opts.keepSummary}`);
    return { id };
  },
  createTable: async () => {
    calls.log.push('create');
  },
  deleteTable: async () => {
    calls.log.push('delete');
  },
}));
vi.mock('@mantle/content/table-snapshots', () => ({
  createTableSnapshot: async (_o: string, id: string) => {
    calls.log.push(`snapshot:${id}`);
    return { id: 'snap-1' };
  },
}));
vi.mock('@mantle/files/dwg', () => ({
  cadRegistryWorkbook: async () => ({
    grids: {
      sheets: [
        { name: 'Layers', columns: [{ name: 'Layer' }], rows: [['Circuit 1']] },
        { name: 'Segments', columns: [{ name: 'Layer' }], rows: [['Circuit 1']] },
        { name: 'Empty', columns: [{ name: 'X' }], rows: [] },
      ],
      capped: false,
    },
    description: 'AutoCAD DWG model-space registry. (rebuilt)',
  }),
}));
vi.mock('@mantle/files', () => ({
  readFileById: async () => ({ bytes: Buffer.from('AC1032'), row: {}, path: null }),
}));
vi.mock('@mantle/config', () => ({ envNum: () => 50 }));

import {
  clampLimit,
  decide,
  rebuildOne,
  REINDEX_MAX_LIMIT,
  scopeProblem,
  type ReindexCandidate,
} from './dwg-reindex';

const cand = (over: Partial<ReindexCandidate> = {}): ReindexCandidate => ({
  tableId: '11111111-1111-4111-8111-111111111111',
  ownerId: 'owner',
  fileId: '22222222-2222-4222-8222-222222222222',
  filename: 'PID-1001.dwg',
  version: 1,
  reindexedVersion: null,
  hasDraft: false,
  tabs: ['Layers'],
  ...over,
});

describe('scope and cap', () => {
  it('a run must name files or a folder', () => {
    expect(scopeProblem({})).toMatch(/--file=/);
    expect(scopeProblem({ fileIds: [] })).toMatch(/--folder=/);
    expect(scopeProblem({ fileIds: ['not-an-id'] })).toMatch(/not an id/);
    expect(scopeProblem({ folderId: '33333333-3333-4333-8333-333333333333' })).toBeNull();
  });
  it('the cap defaults to 10 and never passes 50', () => {
    expect(clampLimit(null)).toBe(10);
    expect(clampLimit(500)).toBe(REINDEX_MAX_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(3)).toBe(3);
  });
});

describe('the edited-table rule', () => {
  it('a fresh import rebuilds; a re-indexed one at its own version too', () => {
    expect(decide(cand(), {})).toEqual({ action: 'rebuild', snapshotFirst: false });
    expect(decide(cand({ version: 4, reindexedVersion: 4 }), {})).toEqual({
      action: 'rebuild',
      snapshotFirst: false,
    });
  });
  it('an edited table is refused, or snapshotted first with --keep-edits', () => {
    expect(decide(cand({ version: 2 }), {})).toEqual({ action: 'refuse', reason: 'edited' });
    expect(decide(cand({ version: 5, reindexedVersion: 4 }), { keepEdits: true })).toEqual({
      action: 'rebuild',
      snapshotFirst: true,
    });
  });
  it('a draft is always refused', () => {
    expect(decide(cand({ hasDraft: true }), { keepEdits: true })).toEqual({
      action: 'refuse',
      reason: 'draft',
    });
  });
});

describe('a rebuild keeps the table', () => {
  beforeEach(() => {
    calls.log = [];
  });

  it('drafts and commits on the same id, keeps the summary, never creates or deletes', async () => {
    const c = cand();
    const r = await rebuildOne(c, {});
    expect(r).toMatchObject({
      tableId: c.tableId,
      result: 'rebuilt',
      tabs: ['Layers', 'Segments'],
    });
    expect(calls.log).toEqual([
      `draft:${c.tableId}`,
      `commit:${c.tableId}:keepSummary=true`,
      `heads:${c.tableId}`,
    ]);
  });

  it('--resummarize lets the commit run the full pass', async () => {
    await rebuildOne(cand(), { resummarize: true });
    expect(calls.log).toContain(`commit:${cand().tableId}:keepSummary=false`);
  });

  it('an edited table: refused untouched, or a snapshot first', async () => {
    const edited = cand({ version: 2 });
    expect(await rebuildOne(edited, {})).toMatchObject({ result: 'refused' });
    expect(calls.log).toEqual([]);
    const r = await rebuildOne(edited, { keepEdits: true });
    expect(r).toMatchObject({ result: 'rebuilt', snapshot: 'snap-1' });
    expect(calls.log[0]).toBe(`snapshot:${edited.tableId}`);
    expect(calls.log).not.toContain('create');
    expect(calls.log).not.toContain('delete');
  });
});
