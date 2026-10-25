/**
 * dwg-reindex without a database: the scope and cap rules, the edited-table
 * rule, and that a rebuild writes the SAME table (draft + commit on its id,
 * never a create or a delete). The real-Postgres half is
 * dwg-reindex.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ log: [] as string[] }));
/** What the fresh read right before the write sees (the table row now). */
const fresh = vi.hoisted(() => ({
  row: { version: 1, draftRev: 7, hasDraft: false } as Record<string, unknown>,
  /** Runs while the sidecar pass "takes a while": a user acting mid-run. */
  duringBuild: null as null | (() => void),
  commit: 'ok' as 'ok' | 'null' | 'throw',
  saveConflict: false,
  /** The table's Checks tab rows (circuit_verify's answers), if it has one. */
  checks: null as null | unknown[][],
  /** The tabs the last draft save wrote. */
  saved: [] as string[],
}));

vi.mock('@mantle/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [fresh.row] }) }),
    }),
  },
  nodes: { id: 'id', type: 'type', data: 'data' },
  tables: {
    version: 'version',
    nodeId: 'node_id',
    draftRev: 'draft_rev',
    draftPath: 'draft_path',
    draftData: 'draft_data',
  },
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
  saveTableDraft: async (
    _o: string,
    id: string,
    d: { tabs: { name: string; rows: unknown[] }[] },
    opts: { ifRev?: number },
  ) => {
    calls.log.push(`draft:${id}:ifRev=${opts.ifRev}`);
    fresh.saved = d.tabs.map((t) => `${t.name}:${t.rows.length}`);
    if (fresh.saveConflict) return { ok: false, conflict: true, currentRev: 99 };
    return { ok: true, draftRev: 1 };
  },
  commitTable: async (_o: string, id: string, _d: unknown, opts: { keepSummary?: boolean }) => {
    calls.log.push(`commit:${id}:keepSummary=${opts.keepSummary}`);
    if (fresh.commit === 'throw') throw new Error('store refused');
    return fresh.commit === 'null' ? null : { id };
  },
  discardTableDraft: async (_o: string, id: string) => {
    calls.log.push(`discard:${id}`);
    return true;
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
vi.mock('@mantle/content/table-storage', () => ({
  tableSqlSurface: async () => ({
    abs: '/x.sqlite',
    tabs: fresh.checks
      ? [
          {
            name: 'Checks',
            viewName: 'Checks',
            columns: [
              { name: 'Key', type: 'text' },
              { name: 'Answer', type: 'text' },
            ],
          },
        ]
      : [],
  }),
}));
vi.mock('@mantle/tabledb', () => ({
  runTableSql: async (_abs: string, q: string) => ({
    columns: ['Key', 'Answer'],
    rows: / OFFSET 0$/.test(q) ? (fresh.checks ?? []) : [],
    truncated: false,
  }),
}));
vi.mock('@mantle/files/dwg', () => ({
  DWG_CHECKS_TAB: 'Checks',
  DWG_CHECKED_VERSION_KEY: 'dwgCheckedVersion',
  DWG_REINDEXED_VERSION_KEY: 'dwgReindexedVersion',
  dwgTableEdited: (t: {
    version: number;
    reindexedVersion: number | null;
    checkedVersion?: number | null;
  }) => t.version > Math.max(t.reindexedVersion ?? 1, t.checkedVersion ?? 0),
  cadRegistryWorkbook: async () => {
    fresh.duringBuild?.();
    return {
      grids: {
        sheets: [
          { name: 'Layers', columns: [{ name: 'Layer' }], rows: [['Circuit 1']] },
          { name: 'Segments', columns: [{ name: 'Layer' }], rows: [['Circuit 1']] },
          { name: 'Empty', columns: [{ name: 'X' }], rows: [] },
        ],
        capped: false,
      },
      description: 'AutoCAD DWG model-space registry. (rebuilt)',
    };
  },
}));
vi.mock('@mantle/files', () => ({
  readFileById: async () => ({ bytes: Buffer.from('AC1032'), row: {}, path: null }),
}));
vi.mock('@mantle/config', () => ({ envNum: () => 50 }));

import {
  clampLimit,
  decide,
  needsResummary,
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
  description: 'AutoCAD DWG model-space registry. Layers counts entities per layer.',
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
  it('an image-check commit on an unedited table is not an edit; an edit after it is', () => {
    expect(decide(cand({ version: 2, checkedVersion: 2 }), {})).toMatchObject({
      action: 'rebuild',
    });
    expect(decide(cand({ version: 3, checkedVersion: 2 }), {})).toEqual({
      action: 'refuse',
      reason: 'edited',
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
    fresh.checks = null;
    fresh.saved = [];
    fresh.row = { version: 1, draftRev: 7, hasDraft: false };
    fresh.duringBuild = null;
    fresh.commit = 'ok';
    fresh.saveConflict = false;
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
      `draft:${c.tableId}:ifRev=7`,
      `commit:${c.tableId}:keepSummary=true`,
      `heads:${c.tableId}`,
    ]);
  });

  it("the image check's Checks tab is written back with the rebuilt tabs", async () => {
    fresh.checks = [
      ['join:pGap', 'yes'],
      ['end:A@20.0,0.0', 'no'],
    ];
    const r = await rebuildOne(cand(), {});
    expect(r).toMatchObject({ result: 'rebuilt', tabs: ['Layers', 'Segments', 'Checks'] });
    expect(fresh.saved).toEqual(['Layers:1', 'Segments:1', 'Checks:2']);
  });

  it('a draft opened during the sidecar pass is never overwritten (security MED-1)', async () => {
    // The candidate read saw no draft; a user opens one while the pass runs.
    fresh.duringBuild = () => {
      fresh.row = { version: 1, draftRev: 8, hasDraft: true };
    };
    const r = await rebuildOne(cand(), {});
    expect(r).toMatchObject({ result: 'refused' });
    expect((r as { reason: string }).reason).toMatch(/draft was opened .* during the run/);
    expect(calls.log).toEqual([]);
  });

  it('a commit during the pass is judged on the new version, not the stale read', async () => {
    fresh.duringBuild = () => {
      fresh.row = { version: 2, draftRev: 9, hasDraft: false };
    };
    expect(await rebuildOne(cand(), {})).toMatchObject({ result: 'refused' });
    expect(calls.log).toEqual([]);
  });

  it('the draft is saved against the revision the fresh read saw; a conflict refuses', async () => {
    fresh.saveConflict = true;
    const r = await rebuildOne(cand(), {});
    expect(r).toMatchObject({ result: 'refused' });
    expect(calls.log).toEqual([`draft:${cand().tableId}:ifRev=7`]);
  });

  it('a commit that fails after the draft save discards that draft (security LOW-4)', async () => {
    for (const mode of ['null', 'throw'] as const) {
      calls.log = [];
      fresh.commit = mode;
      const r = await rebuildOne(cand(), {});
      expect(r).toMatchObject({ result: 'failed' });
      expect((r as { reason: string }).reason).toMatch(/draft was discarded/);
      expect(calls.log).toEqual([
        `draft:${cand().tableId}:ifRev=7`,
        `commit:${cand().tableId}:keepSummary=true`,
        `discard:${cand().tableId}`,
      ]);
    }
  });

  it('a summary written from "no vector geometry" is rewritten; others kept (security LOW-3)', async () => {
    const old = cand({
      description:
        'AutoCAD DWG model-space registry. Layers counts entities per layer. Vector geometry beyond text and block positions is not in this table.',
    });
    const r = await rebuildOne(old, {});
    expect(r).toMatchObject({ result: 'rebuilt', resummarized: true });
    expect(calls.log).toContain(`commit:${old.tableId}:keepSummary=false`);
    expect(
      needsResummary(old.description, 'AutoCAD DWG model-space registry. Segments ...', {}),
    ).toBe(true);
    // The new pass also failed its geometry: the old claim is still true.
    expect(
      needsResummary(
        old.description,
        'AutoCAD ... Vector geometry beyond text and block positions is not in this table (the geometry pass failed: x).',
        {},
      ),
    ).toBe(false);
    expect(needsResummary(cand().description, 'anything', {})).toBe(false);
    expect(needsResummary(null, 'anything', { resummarize: true })).toBe(true);
  });

  it('--resummarize lets the commit run the full pass', async () => {
    await rebuildOne(cand(), { resummarize: true });
    expect(calls.log).toContain(`commit:${cand().tableId}:keepSummary=false`);
  });

  it('an edited table: refused untouched, or a snapshot first', async () => {
    const edited = cand({ version: 2 });
    fresh.row = { version: 2, draftRev: 7, hasDraft: false };
    expect(await rebuildOne(edited, {})).toMatchObject({ result: 'refused' });
    expect(calls.log).toEqual([]);
    const r = await rebuildOne(edited, { keepEdits: true });
    expect(r).toMatchObject({ result: 'rebuilt', snapshot: 'snap-1' });
    expect(calls.log[0]).toBe(`snapshot:${edited.tableId}`);
    expect(calls.log).not.toContain('create');
    expect(calls.log).not.toContain('delete');
  });
});
