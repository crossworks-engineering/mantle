/**
 * dwg-reindex without a database: the scope and cap rules, the edited-table
 * rule, and that a rebuild writes the SAME table (draft + commit on its id,
 * never a create or a delete). The Checks tab is read from a real
 * workbook file written by the store's own writer (@mantle/tabledb, no
 * database), so its column definitions and cell encoding are the real
 * ones. The real-Postgres half is dwg-reindex.db.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ log: [] as string[] }));
/** What the fresh read right before the write sees (the table row now). */
const fresh = vi.hoisted(() => ({
  row: { version: 1, draftRev: 7, hasDraft: false } as Record<string, unknown>,
  /** Runs while the sidecar pass "takes a while": a user acting mid-run. */
  duringBuild: null as null | (() => void),
  commit: 'ok' as 'ok' | 'null' | 'throw',
  saveConflict: false,
  /** The table's workbook file when it has a Checks tab (circuit_verify's
   *  answers), written by the store's own writer. */
  checksFile: null as null | string,
  /** The tabs the last draft save wrote. */
  saved: [] as string[],
  /** The Checks tab the last draft save wrote, whole. */
  savedChecks: null as null | Record<string, unknown>,
  /** The Checks tab's row count as the surface reports it (the real count
   *  when null). */
  checkRowCount: null as null | number,
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
  tableDocFromGrid: (g: { columns: { name: string; type?: string }[]; rows: unknown[][] }) => {
    return {
      columns: g.columns.map((c) => ({ id: c.name, name: c.name, type: c.type ?? 'text' })),
      rows: g.rows.map((r, i) => ({ id: String(i), cells: { v: r[0] } })),
    };
  },
  saveTableDraft: async (
    _o: string,
    id: string,
    d: { tabs: { name: string; rows: unknown[] }[] },
    opts: { ifRev?: number },
  ) => {
    calls.log.push(`draft:${id}:ifRev=${opts.ifRev}`);
    fresh.saved = d.tabs.map((t) => `${t.name}:${t.rows.length}`);
    fresh.savedChecks =
      (d.tabs.find((t) => t.name === 'Checks') as Record<string, unknown> | undefined) ?? null;
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
vi.mock('@mantle/content/table-storage', async () => {
  const { describeWorkbook } = await import('@mantle/tabledb');
  return {
    tableSqlSurface: async () => {
      if (!fresh.checksFile) return { abs: '/x.sqlite', tabs: [] };
      const tabs = describeWorkbook(fresh.checksFile).map((t) =>
        t.name === 'Checks' && fresh.checkRowCount != null
          ? { ...t, rowCount: fresh.checkRowCount }
          : t,
      );
      return { abs: fresh.checksFile, tabs };
    },
  };
});
// The real keys, dwgTableEdited and dwgSourceSha: only the sidecar pass is
// made up.
vi.mock('@mantle/files/dwg', async (orig) => ({
  ...(await orig<typeof import('@mantle/files/dwg')>()),
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
vi.mock('@mantle/config', async (orig) => {
  const real = await orig<typeof import('@mantle/config')>();
  return {
    ...real,
    envNum: (n: string) => (n === 'MANTLE_MAX_AUTO_TABLE_TABLES' ? 50 : real.envNum(n as never)),
  };
});

import { writeDocFile } from '@mantle/tabledb/write';
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

/** Workbook files this file writes, all under its own directory. */
const dir = mkdtempSync(path.join(tmpdir(), 'mantle-dwgre-unit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
type ChecksTab = Parameters<typeof writeDocFile>[1] extends infer W
  ? W extends { tabs: (infer T)[] }
    ? T
    : never
  : never;

/** The table's workbook as the store writes it: a sidecar tab and the
 *  Checks tab given. */
function writeChecks(tab: Omit<ChecksTab, 'name' | 'aggregates' | 'views'> & Partial<ChecksTab>) {
  const abs = path.join(dir, `t${++fileNo}.sqlite`);
  writeDocFile(
    abs,
    {
      tabs: [
        {
          name: 'Layers',
          columns: [{ id: 'layer', name: 'Layer', type: 'text' }],
          rows: [{ id: 'r0', cells: { layer: 'Circuit 1' } }],
          aggregates: {},
          views: [],
        },
        { aggregates: {}, views: [], ...tab, name: 'Checks' },
      ],
    },
    { nodeId: 'n', ownerId: 'o' },
  );
  fresh.checksFile = abs;
}

/** Two text columns, one row per [key, answer]. */
const plainChecks = (rows: [string, string][]) =>
  writeChecks({
    columns: [
      { id: 'k', name: 'Key', type: 'text' },
      { id: 'a', name: 'Answer', type: 'text' },
    ],
    rows: rows.map(([k, a], i) => ({ id: `r${i}`, cells: { k, a } })),
  });

describe('a rebuild keeps the table', () => {
  beforeEach(() => {
    calls.log = [];
    fresh.checksFile = null;
    fresh.saved = [];
    fresh.savedChecks = null;
    fresh.checkRowCount = null;
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
    plainChecks([
      ['join:pGap', 'yes'],
      ['end:A@20.0,0.0', 'no'],
    ]);
    const r = await rebuildOne(cand(), {});
    expect(r).toMatchObject({ result: 'rebuilt', tabs: ['Layers', 'Segments', 'Checks'] });
    expect(fresh.saved).toEqual(['Layers:1', 'Segments:1', 'Checks:2']);
  });

  it('keeps every row and each column whole: type, options, format; two rebuilds give the same tab (L5, MED-1)', async () => {
    const tags = [
      { id: 'ok', label: 'ok' },
      { id: 'rv', label: 'reviewed' },
      { id: 'ab', label: 'a, b' },
    ];
    const columns = [
      { id: 'k', name: 'Key', type: 'text' as const, width: 220 },
      { id: 'tags', name: 'Tags', type: 'multiselect' as const, options: tags },
      {
        id: 'v',
        name: 'Verdict',
        type: 'select' as const,
        options: [
          { id: 'y', label: 'yes', color: 'green' },
          { id: 'n', label: 'no' },
        ],
      },
      { id: 'len', name: 'Length', type: 'number' as const, format: { decimals: 2 } },
      {
        id: 'cost',
        name: 'Cost',
        type: 'currency' as const,
        format: { currency: 'ZAR', decimals: 2 },
      },
      { id: 'on', name: 'Checked on', type: 'date' as const },
      { id: 'at', name: 'Checked at', type: 'datetime' as const },
      { id: 'rev', name: 'Reviewed', type: 'checkbox' as const },
      { id: 'tot', name: 'Double', type: 'formula' as const, formula: '{Length} * 2' },
      {
        id: 'src',
        name: 'Source',
        type: 'reference' as const,
        ref: { tabId: 'old-tab', columnId: 'old-col' },
      },
    ];
    const tagsOf = (i: number) =>
      i % 3 === 0 ? ['ok', 'reviewed'] : i % 3 === 1 ? ['a, b'] : ['ok'];
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      id: `r${i}`,
      cells: {
        k: `k${i}`,
        tags: tagsOf(i),
        v: i % 2 ? 'no' : 'yes',
        len: i + 0.25,
        cost: 12.5,
        on: '2026-10-25',
        at: '2026-10-25T12:00:00',
        rev: i % 2 === 0,
        src: 'V-201',
      },
    }));
    writeChecks({
      columns,
      rows,
      aggregates: { len: 'sum' },
      views: [{ id: 'view1', name: 'Longest', sort: [{ colId: 'len', dir: 'desc' }] }],
    });
    const r = await rebuildOne(cand(), {});
    expect(r).toMatchObject({ result: 'rebuilt', tabs: ['Layers', 'Segments', 'Checks'] });
    expect(fresh.saved).toEqual(['Layers:1', 'Segments:1', 'Checks:2500']);
    const first = fresh.savedChecks as unknown as ChecksTab;
    // Every column whole; only the reference, whose tab the rebuild
    // replaces, comes back as text holding its value.
    expect(first.columns).toEqual([
      ...columns.slice(0, -1),
      { id: 'src', name: 'Source', type: 'text' },
    ]);
    expect(first.rows).toHaveLength(2500);
    expect(first.rows.slice(0, 3)).toEqual(rows.slice(0, 3));
    expect(first.rows.map((x) => x.cells.tags)).toEqual(rows.map((x) => x.cells.tags));
    expect(first.rows[1]!.cells.tags).toEqual(['a, b']);
    expect(first.aggregates).toEqual({ len: 'sum' });
    expect(first.views).toEqual([
      { id: 'view1', name: 'Longest', sort: [{ colId: 'len', dir: 'desc' }] },
    ]);

    // The store writes what the rebuild saved; the next rebuild reads it
    // back: the same tab, cell for cell (nothing nests or splits again).
    writeChecks(first);
    expect(await rebuildOne(cand(), {})).toMatchObject({ result: 'rebuilt' });
    expect(fresh.savedChecks).toEqual(first);
  });

  it('a Checks tab past the cap is refused whole, nothing written (L5)', async () => {
    plainChecks([['k', 'yes']]);
    fresh.checkRowCount = 100_001;
    const r = await rebuildOne(cand(), {});
    expect(r).toMatchObject({ result: 'refused' });
    expect((r as { reason: string }).reason).toMatch(
      /more than 100,000 rows.*nothing was rebuilt.*then run again/,
    );
    expect(calls.log).toEqual([]);
    // Rows the count did not show yet are caught by the read itself.
    plainChecks(Array.from({ length: 100_001 }, (_, i): [string, string] => [`k${i}`, 'yes']));
    fresh.checkRowCount = 5;
    expect(await rebuildOne(cand(), {})).toMatchObject({ result: 'refused' });
    expect(calls.log).toEqual([]);
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
