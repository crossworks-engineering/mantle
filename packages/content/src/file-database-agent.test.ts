/**
 * An Agent's run on a real file database on disk (runAgentOnFile,
 * ./file-database.ts), with three stand-ins: the parser job (the Agent's one
 * step: its asks and pictures, counted), the paid ask (counted), and the
 * file's row. No Postgres and no model.
 *
 * The money rules, each pinned here:
 *  - a first run makes one paid call for each ask, and writes the tab and
 *    the stamp entry;
 *  - a second run of the same file makes ZERO paid calls;
 *  - ONE parser job a run, and it ends before the first paid call: no code
 *    of the pipeline runs after a paid call;
 *  - a failed ask keeps the older rows and takes the stamp entry out;
 *  - a stop before any paid call leaves the older rows exactly as they are;
 *  - the Reader's tabs are the same rows after a run;
 *  - a Reader's new read of the same bytes keeps the paid tab, and the run
 *    after it pays nothing;
 *  - a step that asks more than its manifest allows pays nothing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineCallAnswer, PipelineManifest } from '@mantle/files';
import type { AgentAsk } from './pipeline-agent';
import type { BoxPipeline, BoxPipelines } from './pipeline-registry';

const PNG = (tail: string) =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(tail)]);

const h = vi.hoisted(() => ({
  /** What happened, in order: `step` (the parser job) and `ask:<key>`. */
  events: [] as string[],
  /** The pictures the step's answer carries, by file name. */
  pictures: new Map<string, Buffer>(),
  /** The calls the step returns. */
  calls: [] as unknown[],
  row: { sha256: '', indexing: 'full', home: null as string | null, filename: 'sheet.csv' },
}));

vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof import('@mantle/files')>()),
  // The Agent's one step, as the parser would answer it.
  parserPipelineRun: vi.fn(async () => {
    h.events.push('step');
    return { result: { status: 'ok', calls: h.calls }, pictures: h.pictures };
  }),
}));

// The file's row, as the row checks read it.
vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ path: 'files', ...h.row }] }) }),
    }),
  },
}));

vi.mock('./pipeline-state', async (orig) => ({
  ...(await orig<typeof import('./pipeline-state')>()),
  pipelineStateOf: vi.fn(async () => ({
    options: {},
    optionsHash: '',
    offIn: [],
    runs: 0,
    lastRunAt: null,
  })),
  countPipelineRun: vi.fn(async () => {}),
}));

const AGENT: BoxPipeline = {
  id: 'made-up-agent',
  name: 'Made-up agent',
  description: 'A made-up Agent of a test.',
  version: '1.0.0',
  api: 1,
  runtime: 'bun',
  entry: 'step.ts',
  start: 'demand',
  input: 'file',
  match: { ext: ['csv'] },
  produces: { tabs: ['Title block'] },
  needs: { weight: 'light', workers: { vision: 2 } },
  source: 'builtin',
};
const READER = { id: 'sheet', version: '1.0.0', api: 1, produces: {} } as PipelineManifest;

/** The box's pipelines, made up: one Reader of .csv and the one Agent. */
const pipelines = {
  all: [AGENT],
  byId: (id: string) => (id === AGENT.id ? AGENT : null),
  readerFor: () => READER as BoxPipeline,
  routerFor: () => null,
  after: [],
  agents: [AGENT],
  acted: [AGENT],
  dbExts: new Set(['csv']),
  problems: new Map(),
  problemCodes: new Map(),
} as unknown as BoxPipelines;

const FIELDS = [{ name: 'Line number' }, { name: 'Revision' }];
const ask = (key: string, picture: string) => ({
  call: 'worker',
  worker: 'vision',
  key,
  input: { picture, fields: FIELDS },
});

const root = mkdtempSync(path.join(tmpdir(), 'mantle-agent-'));
process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('an Agent run on a file database', () => {
  let fd: typeof import('./file-database');
  let tdb: typeof import('@mantle/tabledb');
  let f: typeof import('@mantle/files');
  const ownerId = randomUUID();
  let fileId: string;
  let bytes: Buffer;
  let sha256: string;
  let fail: ((a: AgentAsk) => PipelineCallAnswer | null) | undefined;

  /** The paid ask: counted, and answered from the ask's key and picture. */
  const paid = async (a: AgentAsk): Promise<PipelineCallAnswer> => {
    h.events.push(`ask:${a.key}`);
    const no = fail?.(a);
    if (no) return no;
    return {
      ok: true,
      output: {
        values: { 'Line number': `L-${a.key}-${a.picture.length}`, Revision: 'A' },
        model: 'made-up-model',
      },
    };
  };
  const asksMade = () => h.events.filter((e) => e.startsWith('ask:'));

  const run = () =>
    fd.runAgentOnFile({
      fileId,
      ownerId,
      sha256,
      bytes,
      filename: 'sheet.csv',
      pipeline: AGENT,
      pipelines,
      ask: paid,
    });

  /** The Reader's write of the file's database, with these rows. */
  const read = (rows: string[][]) =>
    fd.buildFileDatabase({
      fileId,
      ownerId,
      sha256,
      bytes,
      filename: 'sheet.csv',
      pipelines,
      parsed: {
        kind: 'sheets',
        sheets: [
          {
            name: 'Drawing',
            columns: [
              { name: 'Key', type: 'text' },
              { name: 'Value', type: 'text' },
            ],
            rows,
          },
        ],
      },
    });

  const sqlite = () => f.fileDbPaths(fileId, sha256)!.sqlite;
  const rowsOf = (tab: string): unknown[][] => {
    const t = tdb.describeWorkbook(sqlite()).find((x) => x.name === tab);
    if (!t) return [];
    const cols = t.columns.map((c) => c.name);
    const out: unknown[][] = [];
    tdb.scanTabColumns(sqlite(), tab, cols, { maxRows: 100, cellMaxChars: 5000 }, (r) => {
      out.push(cols.map((c) => r[c]));
      return true;
    });
    return out;
  };
  const entry = () => tdb.readDocMeta(sqlite(), ['pipelines_after'])?.pipelines_after ?? '';

  beforeEach(async () => {
    fd = await import('./file-database');
    tdb = await import('@mantle/tabledb');
    f = await import('@mantle/files');
    fileId = randomUUID();
    bytes = Buffer.from(`made-up,${fileId}\n`);
    sha256 = createHash('sha256').update(bytes).digest('hex');
    h.row = { sha256, indexing: 'full', home: null, filename: 'sheet.csv' };
    h.events.length = 0;
    h.pictures = new Map([
      ['sheet.png', PNG('whole')],
      ['side.png', PNG('side')],
    ]);
    h.calls = [ask('sheet', 'sheet.png'), ask('right-side', 'side.png')];
    fail = undefined;
    expect(await read([['Format', 'made-up']])).toMatchObject({ status: 'built' });
  });

  it('a first run: one parser job, then one paid call for each ask, the tab and the stamp entry', async () => {
    const before = rowsOf('Drawing');
    expect(await run()).toMatchObject({ status: 'asked', rows: 2, made: 2, reused: 0 });
    // The one parser job ends before the first paid call, and none runs after.
    expect(h.events).toEqual(['step', 'ask:sheet', 'ask:right-side']);
    expect(rowsOf('Title block').map((r) => r.slice(0, 4))).toEqual([
      ['sheet', 'L-sheet-13', 'A', 'made-up-model'],
      ['right-side', 'L-right-side-12', 'A', 'made-up-model'],
    ]);
    expect(entry()).toBe('made-up-agent@1.0.0');
    // The Reader's rows are the same.
    expect(rowsOf('Drawing')).toEqual(before);
  });

  it('a second run of the same file makes ZERO paid calls and leaves the tab equal', async () => {
    await run();
    const first = rowsOf('Title block');
    h.events.length = 0;
    expect(await run()).toMatchObject({ status: 'asked', rows: 2, made: 0, reused: 2 });
    expect(asksMade()).toEqual([]);
    expect(h.events).toEqual(['step']);
    expect(rowsOf('Title block')).toEqual(first);
    expect(entry()).toBe('made-up-agent@1.0.0');
  });

  it('a failed ask keeps the older rows, writes what was paid for and takes the entry out', async () => {
    await run();
    const first = rowsOf('Title block');
    // Both pictures are new, so both asks need a call. The second one fails.
    h.pictures = new Map([
      ['sheet.png', PNG('whole-2')],
      ['side.png', PNG('side-2')],
    ]);
    h.events.length = 0;
    fail = (a) =>
      a.key === 'right-side' ? { ok: false, error: 'failed', reason: 'no_json' } : null;
    expect(await run()).toMatchObject({ status: 'asked', made: 1, reused: 0, stopped: 'no_json' });
    const now = rowsOf('Title block');
    expect(now[0]!.slice(0, 2)).toEqual(['sheet', 'L-sheet-15']);
    // The older row of the failed ask is still there, as it was.
    expect(now[1]).toEqual(first[1]);
    expect(entry()).toBe('');
    // A run again pays only for the one that is missing.
    fail = undefined;
    h.events.length = 0;
    expect(await run()).toMatchObject({ made: 1, reused: 1 });
    expect(asksMade()).toEqual(['ask:right-side']);
    expect(entry()).toBe('made-up-agent@1.0.0');
  });

  it('at a cap before any call: zero paid answers, and the database is byte for byte as it was', async () => {
    const before = createHash('sha256').update(readFileSync(sqlite())).digest('hex');
    fail = () => ({ ok: false, error: 'not_available', reason: 'day_cap' });
    expect(await run()).toEqual({
      status: 'asked',
      rows: 0,
      made: 0,
      reused: 0,
      stopped: 'day_cap',
      warnings: [],
    });
    // The ask function said no one time, and the run asked nothing after it.
    expect(asksMade()).toEqual(['ask:sheet']);
    expect(createHash('sha256').update(readFileSync(sqlite())).digest('hex')).toBe(before);
  });

  it('at a cap before any call, after a full run: the rows are as they were and the entry is out', async () => {
    await run();
    const first = rowsOf('Title block');
    expect(entry()).toBe('made-up-agent@1.0.0');
    // Both pictures are new, so both asks need a call. The first one is refused.
    h.pictures = new Map([
      ['sheet.png', PNG('whole-2')],
      ['side.png', PNG('side-2')],
    ]);
    h.events.length = 0;
    fail = () => ({ ok: false, error: 'not_available', reason: 'day_cap' });
    expect(await run()).toMatchObject({ status: 'asked', made: 0, reused: 0, stopped: 'day_cap' });
    expect(asksMade()).toEqual(['ask:sheet']);
    expect(rowsOf('Title block')).toEqual(first);
    expect(rowsOf('Drawing')).toEqual([['Format', 'made-up']]);
    expect(entry()).toBe('');
  });

  it("a Reader's new read of the same bytes keeps the paid tab, and the run after it pays nothing", async () => {
    await run();
    const paidRows = rowsOf('Title block');
    h.events.length = 0;
    expect(await read([['Format', 'made-up, read again']])).toMatchObject({
      status: 'built',
      tabs: 1,
      rows: 1,
    });
    // The Reader's build itself made no ask and ran no Agent step.
    expect(h.events).toEqual([]);
    expect(rowsOf('Drawing')).toEqual([['Format', 'made-up, read again']]);
    expect(rowsOf('Title block')).toEqual(paidRows);
    // The new database has no entry: the file shows as not done for the Agent.
    expect(entry()).toBe('');
    expect(await run()).toMatchObject({ made: 0, reused: 2 });
    expect(asksMade()).toEqual([]);
    expect(entry()).toBe('made-up-agent@1.0.0');
  });

  it('a step that asks more than its manifest allows pays nothing and writes nothing', async () => {
    h.calls = [ask('a', 'sheet.png'), ask('b', 'side.png'), ask('c', 'side.png')];
    await expect(run()).rejects.toThrow(/more asks/);
    expect(asksMade()).toEqual([]);
    expect(rowsOf('Title block')).toEqual([]);
  });

  it('a step that returns a write call is a failure: an Agent writes nothing itself', async () => {
    h.calls = [{ call: 'tool', tool: 'file_tabs_write', input: { tabs: [] } }];
    await expect(run()).rejects.toThrow(/writes nothing/);
    expect(asksMade()).toEqual([]);
  });

  it('skips with no call: a file with no database, another extension, a private file, older bytes', async () => {
    const other = randomUUID();
    const none = await fd.runAgentOnFile({
      fileId: other,
      ownerId,
      sha256,
      bytes,
      filename: 'sheet.csv',
      pipeline: AGENT,
      pipelines,
      ask: paid,
    });
    expect(none).toEqual({ status: 'skipped', reason: 'no-database' });
    const ext = await fd.runAgentOnFile({
      fileId,
      ownerId,
      sha256,
      bytes,
      filename: 'sheet.xlsx',
      pipeline: AGENT,
      pipelines,
      ask: paid,
    });
    expect(ext).toEqual({ status: 'skipped', reason: 'no-match' });
    h.row = { ...h.row, indexing: 'metadata' };
    expect(await run()).toEqual({ status: 'skipped', reason: 'private' });
    h.row = { ...h.row, indexing: 'full', sha256: 'c'.repeat(64) };
    expect(await run()).toEqual({ status: 'skipped', reason: 'stale' });
    expect(h.events).toEqual([]);
  });
});
