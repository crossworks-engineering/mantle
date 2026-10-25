/**
 * circuit_trace's rights, without a database: the tables come from the
 * caller's scoped list, and a table the caller cannot open (tableSqlSurface
 * answers null, as it does for a table its scope does not read) is never
 * queried, so none of its rows reach the trace. The same on a real
 * Postgres with row level security: builtins-circuits.viewer.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listed = vi.hoisted(() => ({ rows: [] as { id: string; title: string; data: unknown }[] }));
const surfaces = vi.hoisted(() => ({ readable: new Set<string>(), opened: [] as string[] }));
const sqlCalls = vi.hoisted(() => ({ files: [] as string[] }));

vi.mock('@mantle/db', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => listed.rows,
  };
  return {
    db: chain,
    nodes: {
      id: 'id',
      title: 'title',
      data: 'data',
      ownerId: 'owner_id',
      type: 'type',
      tags: 'tags',
      updatedAt: 'updated_at',
    },
  };
});
vi.mock('@mantle/content', () => ({ nodeUrl: (id: string) => `https://brain.test/n/${id}` }));
vi.mock('@mantle/content/table-storage', () => ({
  tableSqlSurface: async (_owner: string, id: string) => {
    surfaces.opened.push(id);
    if (!surfaces.readable.has(id)) return null;
    return {
      abs: `/tables/${id}.sqlite`,
      draftAbs: null,
      draftOk: false,
      tabs: ['Layers', 'Segments', 'Nodes', 'Circuits'].map((name) => ({ name, viewName: name })),
    };
  },
}));
vi.mock('@mantle/tabledb', () => ({
  runTableSql: async (file: string, q: string) => {
    sqlCalls.files.push(file);
    // A table whose workbook file is not there (another box's, a lost file).
    if (file.includes('broken')) throw new Error('SQLITE_CANTOPEN: unable to open database file');
    if (q.includes('FROM "Layers"'))
      return { columns: ['l'], rows: [['Circuit 10000-001-01']], truncated: false };
    if (q.includes('FROM "Segments"') && q.includes('IN (')) {
      return {
        columns: [],
        rows: [['Circuit 10000-001-01', 'A1', 0, 0, 10, 0, 10, 1, 2]],
        truncated: false,
      };
    }
    if (q.includes('FROM "Nodes"') && q.includes('"Node" IN')) {
      return {
        columns: [],
        rows: [
          [1, 0, 0, 1, 'end', '', '', 'Circuit 10000-001-01'],
          [2, 10, 0, 1, 'end', '', '', 'Circuit 10000-001-01'],
        ],
        truncated: false,
      };
    }
    return { columns: [], rows: [], truncated: false };
  },
}));

import { CIRCUIT_TOOLS, circuitTraceHandler } from './builtins-circuits';
import { policyUntrusted } from './tool-policy';
import { readSheet } from './circuit-trace/read';

const dwgRow = (id: string, title: string) => ({
  id,
  title,
  data: {
    description: 'AutoCAD DWG model-space registry. ... within 2 drawing units of it ...',
    sourceFileId: `file-${id}`,
  },
});

describe('circuit_trace reads only what the caller may read', () => {
  beforeEach(() => {
    surfaces.readable = new Set();
    surfaces.opened = [];
    sqlCalls.files = [];
  });

  it('a table the caller cannot open is never queried', async () => {
    const r = await readSheet(
      'owner',
      { id: 'secret', title: 'PID-9', description: null, sourceFileId: null },
      '10000-001-01',
    );
    expect(r).toEqual({ kind: 'skip' });
    expect(sqlCalls.files).toEqual([]);
  });

  it('the trace holds the readable sheet and nothing of the other', async () => {
    listed.rows = [dwgRow('open', 'PID-1001'), dwgRow('secret', 'PID-SECRET')];
    surfaces.readable = new Set(['open']);
    const r = await circuitTraceHandler({ circuit: '10000-001-01' }, 'owner');
    expect(r.ok).toBe(true);
    const out = JSON.stringify((r as { output: unknown }).output);
    expect(out).toContain('PID-1001');
    expect(out).not.toContain('PID-SECRET');
    expect(out).not.toContain('secret');
    expect(sqlCalls.files.every((f) => f === '/tables/open.sqlite')).toBe(true);
    expect(surfaces.opened).toEqual(['open', 'secret']);
  });

  it('a table the scoped list does not return is never opened', async () => {
    listed.rows = [dwgRow('open', 'PID-1001')];
    surfaces.readable = new Set(['open', 'unlisted']);
    await circuitTraceHandler({ circuit: '10000-001-01' }, 'owner');
    expect(surfaces.opened).toEqual(['open']);
  });

  it('a table that cannot be opened is skipped and named in limits, not the end of the trace', async () => {
    listed.rows = [dwgRow('broken', 'PID-LOST'), dwgRow('open', 'PID-1001')];
    surfaces.readable = new Set(['open', 'broken']);
    const r = await circuitTraceHandler({ circuit: '10000-001-01' }, 'owner');
    expect(r.ok).toBe(true);
    const out = (r as { output: { limits: string[]; sheets: { title: string }[] } }).output;
    expect(out.sheets.map((x) => x.title)).toEqual(['PID-1001']);
    expect(out.limits.some((l) => /PID-LOST: its table could not be opened/.test(l))).toBe(true);
    expect(JSON.stringify(out)).not.toContain('SQLITE_CANTOPEN');
  });

  it('its results are fenced as data: drawing text is the uploader’s (security LOW-5)', () => {
    const def = CIRCUIT_TOOLS.find((t) => t.slug === 'circuit_trace')!;
    expect(policyUntrusted(def.policy)).toBe(true);
    // The rights are unchanged: a read in the caller's own scope.
    expect(def.policy).toMatchObject({ effect: 'read', scope: 'any', keyArea: 'tables' });
  });

  it('asks for the circuit name when it is missing', async () => {
    const r = await circuitTraceHandler({}, 'owner');
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/circuit is required/);
  });
});
