/**
 * The export sync of an app clients write (client tier audit 2026-09-30,
 * I2), with fake timers: an app at client level commits its exported Table
 * at most once per CLIENT_SYNC_MIN_GAP_MS however often clients write, the
 * writes in between land in the next sync, and the Table is stamped for
 * retrieval depth before the commit that notifies the extractor. A team app
 * keeps its timing (a sync 15 s after each quiet write). The database, the
 * app's SQLite and the Tables surface are stood in: a commit here is the
 * commit that clears the extraction marker and notifies the extractor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  audience: 'client' as string,
  clientWrittenAt: null as Date | null,
  version: 0,
  tableData: {} as Record<string, unknown>,
  link: null as null | Record<string, unknown>,
  commits: [] as Array<{ at: number; depth: unknown; version: number }>,
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock('drizzle-orm', () => ({ and: () => ({}), eq: () => ({}) }));
vi.mock('@mantle/db', () => {
  const nodes = { t: 'nodes', id: {}, ownerId: {}, audience: {}, data: {} };
  const appDatabases = { t: 'appDatabases', appNodeId: {}, clientWrittenAt: {} };
  const appTableExports = { t: 'exports', id: {}, ownerId: {}, appNodeId: {}, sqliteTable: {} };
  type Fields = Record<string, unknown> | undefined;
  const rowsFor = (table: { t: string }, fields: Fields) => {
    if (table.t === 'exports') return h.link ? [h.link] : [];
    if (fields && 'audience' in fields) {
      return [{ audience: h.audience, clientWrittenAt: h.clientWrittenAt }];
    }
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
        if (table.t === 'exports' && h.link) h.link = { ...h.link, ...v };
      },
    }),
  });
  const insert = () => ({
    values: (v: Record<string, unknown>) => ({ returning: async () => [{ id: 'new-link', ...v }] }),
  });
  return { db: { select, update, insert }, nodes, appDatabases, appTableExports };
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

const { CLIENT_SYNC_MIN_GAP_MS, createAppTableExport, scheduleAppTableExportSync } =
  await import('./app-table-exports');

const OWNER = 'brain';
let appSeq = 0;

beforeEach(() => {
  vi.useFakeTimers();
  appSeq += 1;
  h.audience = 'client';
  h.clientWrittenAt = null;
  h.version = 0;
  h.tableData = {};
  h.commits.length = 0;
  h.created.length = 0;
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

describe('export sync of a client-level app', () => {
  it('commits at most once for five client writes 16 s apart, at retrieval depth', async () => {
    const app = `app-${appSeq}`;
    await fiveWrites(app);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]!.depth).toBe('retrieval');
    expect(h.tableData.brain_depth).toBe('retrieval');

    // The writes in between are not lost: the held sync takes them once the
    // gap is over, and nothing else runs before it.
    await vi.advanceTimersByTimeAsync(CLIENT_SYNC_MIN_GAP_MS - 3 * 60_000);
    expect(h.commits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(h.commits).toHaveLength(2);
    expect(h.commits[1]!.version).toBe(5);
    expect(h.commits[1]!.at - h.commits[0]!.at).toBeGreaterThanOrEqual(CLIENT_SYNC_MIN_GAP_MS);
  });

  it('a team app keeps its timing and full depth', async () => {
    h.audience = 'team';
    await fiveWrites(`app-${appSeq}`);
    expect(h.commits).toHaveLength(5);
    expect(h.commits.every((c) => c.depth === undefined)).toBe(true);
  });

  it('a team app a client once wrote keeps its timing but stays at retrieval depth', async () => {
    h.audience = 'team';
    h.clientWrittenAt = new Date('2026-09-01T00:00:00Z');
    await fiveWrites(`app-${appSeq}`);
    expect(h.commits).toHaveLength(5);
    expect(h.commits.every((c) => c.depth === 'retrieval')).toBe(true);
  });
});

describe('creating an export', () => {
  it('creates the Table of a client-level app at retrieval depth, of a team app at full', async () => {
    h.link = null;
    await createAppTableExport(OWNER, `app-${appSeq}`, 'notes');
    h.audience = 'team';
    await createAppTableExport(OWNER, `app-${appSeq}`, 'notes');
    expect(h.created.map((c) => c.brainDepth)).toEqual(['retrieval', undefined]);
  });
});
