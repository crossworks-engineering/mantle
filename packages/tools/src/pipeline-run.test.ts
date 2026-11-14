/**
 * `pipeline_run` and runPipelines (docs/pipelines.md, "Run on demand"), with
 * no Postgres: the file rows, the busy check, the notify, the state and the
 * database's tabs are stand-ins. The gate's edit check is proven on
 * Postgres (server/web/app/api/files/pipeline-run-route.db.test.ts), the
 * job and the queue in server/api.
 *
 *  - The dry run is the default and sends nothing; it gives each pipeline
 *    that can run with its count, and the reader of a PDF drawing refused.
 *  - `apply` with no `pipeline` is refused; with one, one notify per file.
 *  - A busy queue sends nothing, in the dry run and the run.
 *  - The cap: one call looks at `limit` files, and `next` goes on.
 *  - Site tags on a file of a workspace it is not attached to is skipped as
 *    `not-attached`; with no database, `no-database`; a private file,
 *    `private`.
 *  - The tool's one rights check: its handler asks edit of the file or
 *    folder (assertItemRight) before anything; a refusal sends nothing.
 *    runPipelines asks no right (a route's gate asks it). It spends nothing,
 *    and it is MCP only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDataRow } from '@mantle/files';

const FOLDER = '0f000000-0000-4000-8000-000000000000';
const OWNER = '00000000-0000-4000-8000-000000000000';
const WS_A = 'aa000000-0000-4000-8000-000000000000';
const WS_B = 'bb000000-0000-4000-8000-000000000000';
const SHA = 'a'.repeat(64);

const h = vi.hoisted(() => ({
  busy: false,
  notified: [] as { nodeId: string; pipelineId: string }[],
  rows: [] as FileDataRow[],
  total: 0,
  limits: [] as number[],
  home: new Map<string, string | null>(),
  privateIds: new Set<string>(),
  withDb: new Set<string>(),
  attached: [] as string[],
  asked: [] as string[],
  refuse: false,
}));

vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  extractQueueBusy: vi.fn(async () => h.busy),
  assertItemRight: vi.fn(async (id: string, need: string) => {
    h.asked.push(`${need} ${id}`);
    if (h.refuse) throw new Error('You cannot change this item in your workspaces');
  }),
  notifyPipelineRun: vi.fn(async (nodeId: string, pipelineId: string) => {
    h.notified.push({ nodeId, pipelineId });
  }),
}));

vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof import('@mantle/files')>()),
  fileDataRows: vi.fn(async (_o: string, ids: readonly string[]) =>
    h.rows.filter((r) => ids.includes(r.id)),
  ),
  fileDataRowsIn: vi.fn(async (_o: string, _p: string, opts: { limit: number }) => {
    h.limits.push(opts.limit);
    return h.rows.slice(0, opts.limit).map((r) => ({ ...r, total: h.total || h.rows.length }));
  }),
  folderById: vi.fn(async (args: { folderId: string }) =>
    args.folderId === FOLDER ? { id: FOLDER, path: 'files.drawings' } : null,
  ),
  fileDbSqlitePath: vi.fn(async (id: string) =>
    h.withDb.has(id) ? `/made-up/${id}.sqlite` : null,
  ),
}));

vi.mock('@mantle/tabledb', async (orig) => ({
  ...(await orig<typeof import('@mantle/tabledb')>()),
  describeWorkbook: vi.fn(() => [{ name: 'Texts', columns: [{ name: 'Text' }] }]),
}));

vi.mock('@mantle/content/file-database', () => ({
  readFileRowNow: vi.fn(async (id: string) => ({
    sha256: SHA,
    isPrivate: h.privateIds.has(id),
    home: h.home.get(id) ?? null,
    filename: '',
  })),
}));

vi.mock('@mantle/content/pipeline-state', async () => {
  const f = await import('@mantle/files');
  return {
    pipelineStateOf: vi.fn(async (_o: string, p: import('@mantle/files').PipelineManifest) => ({
      workspaces: f.isAfterPipeline(p) ? h.attached : ('all' as const),
      options: {},
      optionsHash: '',
    })),
  };
});

const { runPipelines, pipeline_run, PIPELINE_RUN_REFUSED, RUN_MAX_LIMIT } =
  await import('./pipeline-run');
const { PIPELINE_TOOLS } = await import('./pipelines');

let seq = 0;
const file = (name: string, home: string | null = WS_A): FileDataRow => {
  seq += 1;
  const id = `${String(seq).padStart(8, '0')}-0000-4000-8000-000000000000`;
  h.home.set(id, home);
  return { id, path: 'files.drawings', title: name, data: { filename: name, sha256: SHA } };
};

beforeEach(() => {
  h.busy = false;
  h.notified = [];
  h.rows = [];
  h.total = 0;
  h.limits = [];
  h.home.clear();
  h.privateIds.clear();
  h.withDb.clear();
  h.attached = [];
  h.asked = [];
  h.refuse = false;
});

const run = async (input: Record<string, unknown>) => {
  const res = await runPipelines(OWNER, input);
  if (!res.ok) throw new Error(res.error);
  return res.answer;
};

describe('the dry run', () => {
  it('is the default, sends nothing, and gives each pipeline that can run with its count', async () => {
    h.rows = [file('a.dxf'), file('b.dwg'), file('c.pdf'), file('d.csv'), file('notes.txt')];
    const answer = await run({ folder_id: FOLDER });
    expect(h.notified).toEqual([]);
    expect(answer).toMatchObject({ apply: false, busy: false, queued: 0, skipped: {}, next: null });
    const by = Object.fromEntries(answer.choices.map((c) => [c.pipeline, c]));
    expect(by['drawing-cad']).toMatchObject({ files: 2, refused: null });
    expect(by['sheet']).toMatchObject({ files: 1, refused: null });
    // The reader of a PDF drawing is refused with its word.
    expect(by['drawing-pdf']).toMatchObject({ files: 0, refused: 'pdf' });
    // Site tags is attached to no workspace: listed, taking none.
    expect(by['site-tags']).toMatchObject({ files: 0, refused: null });
    // No file of their extensions: not a choice.
    expect(by['plan-mspdi']).toBeUndefined();
  });

  it('for one file too', async () => {
    const one = file('a.dxf');
    h.rows = [one];
    const answer = await run({ file_id: one.id, pipeline: 'drawing-cad' });
    expect(answer.choices).toEqual([
      { pipeline: 'drawing-cad', name: expect.any(String), files: 1, refused: null },
    ]);
    expect(h.notified).toEqual([]);
  });
});

describe('the run', () => {
  it('apply with no pipeline is refused, and sends nothing', async () => {
    h.rows = [file('a.dxf')];
    const res = await runPipelines(OWNER, { folder_id: FOLDER, apply: true });
    expect(res).toEqual({ ok: false, error: expect.stringContaining('apply needs a pipeline') });
    expect(h.notified).toEqual([]);
  });

  it('one notify for each file the pipeline takes', async () => {
    h.rows = [file('a.dxf'), file('b.dwg'), file('d.csv')];
    const answer = await run({ folder_id: FOLDER, pipeline: 'drawing-cad', apply: true });
    expect(answer).toMatchObject({ apply: true, queued: 2, skipped: { 'no-match': 1 } });
    expect(h.notified).toEqual([
      { nodeId: h.rows[0]!.id, pipelineId: 'drawing-cad' },
      { nodeId: h.rows[1]!.id, pipelineId: 'drawing-cad' },
    ]);
  });

  it('the reader of a PDF drawing queues nothing: pdf', async () => {
    h.rows = [file('c.pdf')];
    const answer = await run({ folder_id: FOLDER, pipeline: 'drawing-pdf', apply: true });
    expect(answer).toMatchObject({ queued: 0, skipped: { pdf: 1 } });
    expect(h.notified).toEqual([]);
    expect(PIPELINE_RUN_REFUSED).toEqual({ 'drawing-pdf': 'pdf' });
  });

  it('a busy queue sends nothing, and the dry run says so too', async () => {
    h.busy = true;
    h.rows = [file('a.dxf')];
    expect(await run({ folder_id: FOLDER, pipeline: 'drawing-cad', apply: true })).toMatchObject({
      busy: true,
      queued: 0,
    });
    expect((await run({ folder_id: FOLDER })).busy).toBe(true);
    expect(h.notified).toEqual([]);
  });

  it('the cap: one call looks at limit files, and next goes on', async () => {
    h.rows = [file('a.dxf'), file('b.dxf'), file('c.dxf')];
    h.total = 3;
    const answer = await run({ folder_id: FOLDER, pipeline: 'drawing-cad', apply: true, limit: 2 });
    expect(answer).toMatchObject({ queued: 2, next: h.rows[1]!.id });
    // Never past the most, whatever is asked.
    await run({ folder_id: FOLDER, limit: 5000 });
    expect(h.limits).toEqual([2, RUN_MAX_LIMIT]);
    // The whole list: no next.
    h.total = 0;
    expect((await run({ folder_id: FOLDER })).next).toBeNull();
  });

  it('refuses a bad input with a sentence that says what to do', async () => {
    expect((await runPipelines(OWNER, {})).ok).toBe(false);
    expect((await runPipelines(OWNER, { file_id: 'x', folder_id: FOLDER })).ok).toBe(false);
    expect((await runPipelines(OWNER, { folder_id: FOLDER, limit: 0 })).ok).toBe(false);
    expect((await runPipelines(OWNER, { folder_id: FOLDER, after: 'nope' })).ok).toBe(false);
    expect(await runPipelines(OWNER, { folder_id: FOLDER, pipeline: 'no-such' })).toEqual({
      ok: false,
      error: expect.stringContaining('There is no pipeline'),
    });
    expect(h.notified).toEqual([]);
  });
});

describe('an after pipeline on demand', () => {
  it('needs the file home workspace in its attach list, else not-attached', async () => {
    h.attached = [WS_A];
    const inA = file('a.dxf', WS_A);
    const inB = file('b.dxf', WS_B);
    const noHome = file('c.dxf', null);
    h.rows = [inA, inB, noHome];
    for (const r of h.rows) h.withDb.add(r.id);
    const answer = await run({ folder_id: FOLDER, pipeline: 'site-tags', apply: true });
    expect(answer).toMatchObject({ queued: 1, skipped: { 'not-attached': 2 } });
    expect(h.notified).toEqual([{ nodeId: inA.id, pipelineId: 'site-tags' }]);
  });

  it('no database, a private file, and a PDF that runs', async () => {
    h.attached = [WS_A];
    const noDb = file('a.dxf');
    const priv = file('b.dxf');
    const pdf = file('c.pdf');
    h.withDb.add(priv.id);
    h.withDb.add(pdf.id);
    h.privateIds.add(priv.id);
    h.rows = [noDb, priv, pdf];
    const answer = await run({ folder_id: FOLDER, pipeline: 'site-tags', apply: true });
    expect(answer).toMatchObject({ queued: 1, skipped: { 'no-database': 1, private: 1 } });
    expect(h.notified).toEqual([{ nodeId: pdf.id, pipelineId: 'site-tags' }]);
  });
});

describe('the policy', () => {
  const ctx = { ownerId: OWNER } as Parameters<typeof pipeline_run.handler>[1];

  it('the handler asks edit of the file or folder it names, before anything', async () => {
    h.rows = [file('a.dxf')];
    await pipeline_run.handler({ folder_id: FOLDER, pipeline: 'drawing-cad', apply: true }, ctx);
    expect(h.asked).toEqual([`edit ${FOLDER}`]);
    expect(h.notified).toHaveLength(1);
    h.asked = [];
    h.notified = [];
    h.refuse = true;
    await expect(
      pipeline_run.handler({ file_id: h.rows[0]!.id, pipeline: 'drawing-cad', apply: true }, ctx),
    ).rejects.toThrow('You cannot change this item');
    expect(h.asked).toEqual([`edit ${h.rows[0]!.id}`]);
    expect(h.notified).toEqual([]);
    // runPipelines itself asks no right: a route's gate asked it.
    h.asked = [];
    await run({ folder_id: FOLDER });
    expect(h.asked).toEqual([]);
  });

  it('it spends nothing; MCP only', () => {
    expect(PIPELINE_TOOLS).toContain(pipeline_run);
    expect(pipeline_run.mcpOnly).toBe(true);
    expect(pipeline_run.policy).toMatchObject({
      effect: 'write',
      spends: 'none',
      scope: 'any',
      itemArgs: [{ param: 'file_id' }, { param: 'folder_id' }],
      recipe: { step: 'forbidden' },
    });
    expect(Object.keys(pipeline_run.inputSchema.properties ?? {}).sort()).toEqual([
      'after',
      'apply',
      'file_id',
      'folder_id',
      'limit',
      'pipeline',
    ]);
  });
});
