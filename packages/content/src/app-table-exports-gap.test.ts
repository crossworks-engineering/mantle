/**
 * The export sync of an app (client tier audit 2026-09-30, I2), with fake
 * timers: a sync 15 s after each quiet write, and an app a client login once
 * wrote stays at retrieval depth, stamped before the commit that notifies
 * the extractor. Clients run no apps since workspaces W5c, so no app waits
 * out a client gap any more, and an app's level decides nothing here. The
 * database, the app's SQLite and the Tables surface are stood in: a commit
 * here is the commit that clears the extraction marker and notifies the
 * extractor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  clientWrittenAt: null as Date | null,
  version: 0,
  tableData: {} as Record<string, unknown>,
  link: null as null | Record<string, unknown>,
  commits: [] as Array<{ at: number; depth: unknown; version: number }>,
  created: [] as Array<Record<string, unknown>>,
  /** The system reasons the export bookkeeping ran as (runAsSystem). */
  actors: [] as string[],
}));

vi.mock('drizzle-orm', () => ({
  and: () => ({}),
  eq: () => ({}),
  lt: () => ({}),
  lte: () => ({}),
  isNotNull: () => ({}),
  isNull: () => ({}),
  or: () => ({}),
  sql: () => 'now()',
}));
vi.mock('@mantle/db', () => {
  const nodes = { t: 'nodes', id: {}, ownerId: {}, audience: {}, data: {} };
  const appDatabases = { t: 'appDatabases', appNodeId: {}, clientWrittenAt: {} };
  const appTableExports = { t: 'exports', id: {}, ownerId: {}, appNodeId: {}, sqliteTable: {} };
  type Fields = Record<string, unknown> | undefined;
  const rowsFor = (table: { t: string }, fields: Fields) => {
    if (table.t === 'exports') return h.link ? [h.link] : [];
    if (fields && 'clientWrittenAt' in fields) return [{ clientWrittenAt: h.clientWrittenAt }];
    return [{ data: h.tableData }];
  };
  const select = (fields?: Fields) => {
    let table: { t: string } = { t: '' };
    const b = {
      from: (t: { t: string }) => ((table = t), b),
      leftJoin: () => b,
      innerJoin: () => b,
      where: () => b,
      limit: () => b,
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(rowsFor(table, fields)).then(res, rej),
    };
    return b;
  };
  const update = (table: { t: string }) => ({
    set: (v: Record<string, unknown>) => ({
      where: async () => {
        if (table.t === 'nodes') h.tableData = v.data as Record<string, unknown>;
        if (table.t === 'exports' && h.link) {
          // The sync's record clears the mark in the same statement (a SQL
          // CASE: no write after its read here, so cleared).
          const clear = 'lastSyncedAt' in v;
          h.link = { ...h.link, ...v, ...(clear ? { dirtySince: null } : {}) };
        }
      },
    }),
  });
  const insert = () => ({
    values: (v: Record<string, unknown>) => ({ returning: async () => [{ id: 'new-link', ...v }] }),
  });
  // The actor binding (A8 F9): the bookkeeping runs as system(app-export).
  const runAsSystem = (reason: string, fn: () => unknown) => {
    h.actors.push(reason);
    return Promise.resolve(fn());
  };
  return { db: { select, update, insert }, nodes, appDatabases, appTableExports, runAsSystem };
});
vi.mock('@mantle/tabledb', () => ({ importMaxRows: () => 100_000 }));
vi.mock('./apps', () => ({ getApp: vi.fn(async () => ({ title: 'Orders' })) }));
vi.mock('./app-broker', () => ({
  appDbReadQuery: vi.fn(async (_o: string, _a: string, sql: string) =>
    sql.startsWith('PRAGMA')
      ? { rows: [{ name: 'note', type: 'TEXT' }], empty: false }
      : { rows: [{ note: `client row ${h.version}` }], empty: false },
  ),
}));
vi.mock('./tables', () => ({
  createTable: vi.fn(async (_owner: string, input: Record<string, unknown>) => {
    h.created.push(input);
    return { id: 'table-new' };
  }),
  saveTableDraft: vi.fn(async () => true),
  commitTable: vi.fn(async () => {
    h.commits.push({ at: Date.now(), depth: h.tableData.brain_depth, version: h.version });
    return {};
  }),
}));

const { createAppTableExport, scheduleAppTableExportSync } = await import('./app-table-exports');

const OWNER = 'brain';
let appSeq = 0;

beforeEach(() => {
  vi.useFakeTimers();
  appSeq += 1;
  h.clientWrittenAt = null;
  h.version = 0;
  h.tableData = {};
  h.commits.length = 0;
  h.created.length = 0;
  h.actors.length = 0;
  h.link = {
    id: `link-${appSeq}`,
    ownerId: OWNER,
    appNodeId: `app-${appSeq}`,
    sqliteTable: 'notes',
    tableNodeId: `table-${appSeq}`,
    contentHash: null,
  };
});
afterEach(() => {
  vi.useRealTimers();
});

/** Five writes 16 s apart (each one row changed), then a quiet minute. */
async function fiveWrites(app: string): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    h.version += 1;
    scheduleAppTableExportSync(OWNER, app);
    await vi.advanceTimersByTimeAsync(16_000);
  }
  await vi.advanceTimersByTimeAsync(60_000);
}

describe('export sync', () => {
  it('stamps the export dirty at the first write, and the sync clears it (D8)', async () => {
    scheduleAppTableExportSync(OWNER, `app-${appSeq}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.link!.dirtySince).toBe('now()');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(h.commits).toHaveLength(1);
    expect(h.link!.dirtySince).toBeNull();
    // The stamp and the sync ran as system(app-export), never the writer.
    expect(h.actors).toEqual(['app-export', 'app-export']);
  });

  it('an app keeps its timing and full depth', async () => {
    await fiveWrites(`app-${appSeq}`);
    expect(h.commits).toHaveLength(5);
    expect(h.commits.every((c) => c.depth === undefined)).toBe(true);
  });

  it('an app a client once wrote keeps its timing but stays at retrieval depth', async () => {
    h.clientWrittenAt = new Date('2026-09-01T00:00:00Z');
    await fiveWrites(`app-${appSeq}`);
    expect(h.commits).toHaveLength(5);
    expect(h.commits.every((c) => c.depth === 'retrieval')).toBe(true);
  });
});

describe('creating an export', () => {
  it('creates the Table of an app a client wrote at retrieval depth, of any other at full', async () => {
    h.link = null;
    h.clientWrittenAt = new Date('2026-09-01T00:00:00Z');
    await createAppTableExport(OWNER, `app-${appSeq}`, 'notes');
    h.clientWrittenAt = null;
    await createAppTableExport(OWNER, `app-${appSeq}`, 'notes');
    expect(h.created.map((c) => c.brainDepth)).toEqual(['retrieval', undefined]);
  });
});
