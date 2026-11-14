/**
 * The `after` chain on a real migrated Postgres and a real files root:
 *  - a box with no row in pipeline_state builds as before: no `Site tags`
 *    tab, and the `_meta` keys of phase 1, key for key;
 *  - a made-up DXF in a workspace Site tags is attached to gets the tab and
 *    the `pipelines_after` key; the same drawing in a workspace it is not
 *    attached to gets neither, and its reader tabs are the same;
 *  - a made-up PDF drawing database: the rows a model paid for (the File
 *    tab) are the same after the patch;
 *  - an adapter that throws leaves the reader's database in place;
 *  - a spreadsheet with sheets named `Texts` and `Site tags` is not touched;
 *  - patchFileDatabase with other options replaces the tab, writes the
 *    hash, and a second patch of the same input gives the same rows;
 *  - the runs: a build adds one to its reader, a patch one to its `after`
 *    pipeline only, a skip and a word add none, and a count that fails
 *    fails no build and no patch.
 * The parser is faked at the fetch (the CAD tier), with made-up texts, and
 * the job `pipelineRun` of Site tags by its real step in this process
 * (pipelineRunAnswer); any other fetch fails the test, so no model is
 * asked. A drawing with no Texts tab costs no job.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/file-database-after.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import { pipelineRunAnswer } from '@mantle/files/pipelines/test-job';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  throwScan: false,
  throwCount: false,
  /** How the faked parser answers `pipelineRun`: the real step, or a code. */
  run: 'step' as 'step' | 'busy' | 'failed',
  /** The runs on demand asked for (notifyPipelineRun), `<pipeline>:<node>`. */
  notified: [] as string[],
}));

// The run on demand a busy parser at upload queues: recorded, then sent.
vi.mock('@mantle/db', async (orig) => {
  const actual = await orig<typeof import('@mantle/db')>();
  return {
    ...actual,
    notifyPipelineRun: async (nodeId: string, pipelineId: string) => {
      h.notified.push(`${pipelineId}:${nodeId}`);
      return actual.notifyPipelineRun(nodeId, pipelineId);
    },
  };
});

// The count of runs, made to fail on demand: a failed count must never fail
// or undo a build or a patch.
vi.mock('./pipeline-state', async (orig) => {
  const actual = await orig<typeof import('./pipeline-state')>();
  return {
    ...actual,
    countPipelineRun: async (...args: Parameters<typeof actual.countPipelineRun>) => {
      if (h.throwCount) throw new Error('a made-up failure of the count');
      return actual.countPipelineRun(...args);
    },
  };
});

vi.mock('@mantle/tabledb', async (orig) => {
  const actual = await orig<typeof import('@mantle/tabledb')>();
  return {
    ...actual,
    scanTabColumns: (...args: Parameters<typeof actual.scanTabColumns>) => {
      if (h.throwScan) throw new Error('a made-up failure of the adapter');
      return actual.scanTabColumns(...args);
    },
  };
});

/** The base `_meta` keys of a file database, and the four of the stamp. */
const PHASE1_KEYS = [
  'description',
  'engine_version',
  'node_id',
  'owner_id',
  'pipeline_api',
  'pipeline_id',
  'pipeline_version',
  'schema_version',
  'shapes',
];

describe.skipIf(!URL)('the after chain', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let f: typeof import('@mantle/files');
  let fd: typeof import('./file-database');
  let ps: typeof import('./pipeline-state');
  let sqlTag: typeof import('drizzle-orm').sql;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const attached = randomUUID();
  const other = randomUUID();
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-after-'));
  const fetches: string[] = [];
  /** The pipeline id of each pipelineRun job, in order. */
  const runs: string[] = [];
  let seed = 0;

  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sqlTag>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const folderOf = (ws: string) => `files.after_${ws.slice(0, 8)}`;
  const site = () => f.AFTER_PIPELINES.find((p) => p.id === 'site-tags')!;

  /** A made-up DXF: a 999 comment pair keeps each one's bytes unique. */
  const dxf = () =>
    Buffer.from(
      `999\nafter-${(seed += 1)}\n0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n`,
    );

  /** The CAD tier's reply for every made-up drawing. */
  const CAD_REPLY = {
    ok: true,
    dpi: 300,
    converter: 'none',
    version: 'AC1027',
    entities: 4,
    capped: false,
    layers: [{ name: 'INSTR', count: 4 }],
    texts: [
      { text: 'FIC-101', layer: 'INSTR', x: 10, y: 20 },
      { text: 'EA-101 COOLER', layer: 'EQUIP', x: 11, y: 21 },
      { text: 'P-1001-A1A', layer: 'PIPE', x: 12, y: 22 },
      { text: 'NOTE 3', layer: 'NOTES', x: 0, y: 0 },
    ],
    counts: { TEXT: 4 },
    render_error: null,
    png_base64: null,
  };

  const upload = (ws: string, ext: string, bytes: Buffer) =>
    m.withCreateHome({ createWs: ws, privateWs: null }, () =>
      f.upsertFile({
        ownerId: anchor,
        parentPath: folderOf(ws),
        filename: `${randomUUID().slice(0, 8)}.${ext}`,
        bytes,
      }),
    );

  /** Upload and build, as an extract does. */
  const built = async (
    ws: string,
    ext: string,
    bytes: Buffer,
    parsed?: import('./file-database').ParsedFile,
  ) => {
    const file = await upload(ws, ext, bytes);
    const out = await fd.buildFileDatabase({
      fileId: file.id,
      ownerId: anchor,
      sha256: sha256(bytes),
      bytes,
      filename: file.filename,
      ...(parsed ? { parsed } : {}),
    });
    expect(out.status).toBe('built');
    return { id: file.id, sha: sha256(bytes), abs: f.fileDbPaths(file.id, sha256(bytes))!.sqlite };
  };

  const metaOf = (abs: string) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(abs, { readOnly: true });
    try {
      return Object.fromEntries(
        (db.prepare('SELECT k, v FROM _meta ORDER BY k').all() as { k: string; v: string }[]).map(
          (r) => [r.k, r.v],
        ),
      );
    } finally {
      db.close();
    }
  };
  /** Each tab's rows by display value, the ids left out. */
  const valuesOf = async (abs: string, skip: readonly string[] = []) => {
    const t = await import('@mantle/tabledb');
    return Object.fromEntries(
      t
        .describeWorkbook(abs)
        .filter((tab) => !skip.includes(tab.name))
        .map((tab) => [
          tab.name,
          t.readTabColumns(abs, [{ tab: tab.name, columns: tab.columns.map((c) => c.name) }])[0],
        ]),
    );
  };
  const tabNames = async (abs: string) =>
    (await import('@mantle/tabledb')).describeWorkbook(abs).map((t) => t.name);
  const setState = (change: Parameters<typeof ps.setPipelineState>[3]) =>
    ps.setPipelineState(anchor, null, site(), change);

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    fd = await import('./file-database');
    ps = await import('./pipeline-state');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);
    // The superuser: the system pool holds no insert on workspaces.
    for (const ws of [attached, other]) {
      await su(sqlTag`insert into workspaces (id, owner_id, name)
        values (${ws}, ${anchor}, ${`made-up ${ws.slice(0, 8)}`})`);
    }
    await su(sqlTag`insert into workspaces (owner_id, name, is_admin)
      select ${anchor}::uuid, 'Admin', true where mantle_ws_admin_id(${anchor}::uuid) is null`);
    await x(sqlTag`insert into nodes (owner_id, type, title, slug, path)
      values (${anchor}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    for (const ws of [attached, other]) {
      const folder = folderOf(ws);
      await m.withCreateHome({ createWs: ws, privateWs: null }, () =>
        m.withNodeInsertHeads(anchor, [{ type: 'branch', path: folder }], (tx) =>
          tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
            values (${randomUUID()}, ${anchor}, 'branch', ${folder}, ${folder}::ltree)`),
        ),
      );
    }
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    fetches.length = 0;
    runs.length = 0;
    h.throwScan = false;
    h.throwCount = false;
    h.run = 'step';
    h.notified = [];
    f?.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        fetches.push(String(url));
        // Each pipelineRun job is pinned by its pipeline id; a package's real
        // step runs in this process (a spreadsheet's `sheet`, Site tags).
        if (!String(url).includes('/pipeline/run')) {
          return Response.json({ ok: false, error: { code: 'unavailable' } }, { status: 503 });
        }
        const length = Number(new Headers(init?.headers).get('x-parser-opts-length'));
        const sent = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
        const id = (JSON.parse(sent.subarray(0, length).toString('utf8')) as { id: string }).id;
        runs.push(id);
        // A drawing's read is the package drawing-cad: its real step, with
        // the CAD tier's reply below as its `cadRender`.
        if (id === 'drawing-cad') {
          return pipelineRunAnswer({ ...init, body: sent }, { cadRender: async () => CAD_REPLY });
        }
        if (h.run === 'busy') {
          return Response.json({ ok: false, error: { code: 'busy' } }, { status: 429 });
        }
        if (h.run === 'failed') {
          return Response.json({ ok: false, error: { code: 'failed' } }, { status: 500 });
        }
        return pipelineRunAnswer({ ...init, body: sent });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // The readers' own jobs, and Site tags' job on a drawing it patches, by
  // their pipeline id and count: `sheetJobs` CSV reads (the package `sheet`)
  // and `siteTagsJobs` runs of Site tags. No other pipelineRun job passes.
  // A drawing's own read (drawing-cad) is not pinned here, as its
  // `/dwg/render` was not before the move.
  const onlyParser = (sheetJobs: number, siteTagsJobs = 0) => {
    const cad = runs.filter((id) => id === 'drawing-cad').length;
    expect(runs.filter((id) => id !== 'drawing-cad').sort()).toEqual(
      [
        ...Array.from({ length: sheetJobs }, () => 'sheet'),
        ...Array.from({ length: siteTagsJobs }, () => 'site-tags'),
      ].sort(),
    );
    expect(fetches.filter((u) => !u.endsWith('/pipeline/run'))).toEqual([]);
    expect(fetches.filter((u) => u.endsWith('/pipeline/run'))).toHaveLength(
      sheetJobs + siteTagsJobs + cad,
    );
  };

  it('a box with no row: no Site tags tab, and the _meta keys of phase 1', async () => {
    expect((await ps.pipelineStateOf(anchor, site())).workspaces).toEqual([]);
    for (const ws of [attached, other]) {
      const file = await built(ws, 'dxf', dxf());
      expect(await tabNames(file.abs)).not.toContain('Site tags');
      expect(Object.keys(metaOf(file.abs))).toEqual(PHASE1_KEYS);
      expect(await fd.readFileDbStamp(file.id, file.sha)).toEqual({
        pipeline_id: 'drawing-cad',
        pipeline_version: '1.0.0',
        pipeline_api: '1',
        shapes: '',
      });
    }
    const csv = Buffer.from('tag,size\nP-101,50\n');
    const sheet = await built(attached, 'csv', csv);
    expect(Object.keys(metaOf(sheet.abs))).toEqual(PHASE1_KEYS.filter((k) => k !== 'description'));
    onlyParser(1);
  });

  it('attached: the DXF gets the tab and the key; not attached: neither, and the reader tabs are the same', async () => {
    expect((await setState({ workspaces: [attached] })).ok).toBe(true);
    const yes = await built(attached, 'dxf', dxf());
    const no = await built(other, 'dxf', dxf());

    expect(await tabNames(yes.abs)).toEqual([...(await tabNames(no.abs)), 'Site tags']);
    expect(metaOf(yes.abs).pipelines_after).toBe('site-tags@1.0.0');
    expect(Object.keys(metaOf(no.abs))).toEqual(PHASE1_KEYS);
    const { pipelines_after: _after, node_id: _a, ...yesMeta } = metaOf(yes.abs);
    const { node_id: _b, ...noMeta } = metaOf(no.abs);
    expect(yesMeta).toEqual(noMeta);
    // The four phase 1 keys are the reader's, unchanged by the patch.
    expect(await fd.readFileDbStamp(yes.id, yes.sha)).toMatchObject({
      pipeline_id: 'drawing-cad',
      pipelines_after: 'site-tags@1.0.0',
    });
    expect(await valuesOf(yes.abs, ['Site tags'])).toEqual(await valuesOf(no.abs));
    const tags = (await valuesOf(yes.abs))['Site tags'] as Record<string, unknown>[];
    expect(tags.map((r) => [r.Tag, r.Type, r.Layer])).toEqual([
      ['FIC-101', 'instrument', 'INSTR'],
      ['EA-101', 'instrument', 'EQUIP'],
      ['P-1001-A1A', 'equipment', 'PIPE'],
    ]);
    onlyParser(0, 1);
  });

  it('a PDF drawing: the rows a model paid for are the same after the patch', async () => {
    const bytes = Buffer.from(`%PDF-1.7 a made-up drawing ${randomUUID()}`);
    const parsed = {
      kind: 'sheets' as const,
      sheets: [
        {
          name: 'File',
          columns: [
            { name: 'Kind', type: 'text' as const },
            { name: 'Rules kind', type: 'text' as const },
            { name: 'Decider answer', type: 'text' as const },
            { name: 'Vision read', type: 'text' as const },
          ],
          rows: [['pid', 'unsure', 'a made-up paid answer', 'a made-up paid sketch read']],
        },
        {
          name: 'Texts',
          columns: [
            { name: 'Page', type: 'number' as const },
            { name: 'Text', type: 'text' as const },
          ],
          rows: [
            [1, 'TO 40-PSV-0012'],
            [2, 'FIC-102'],
          ],
        },
      ],
    };
    const file = await built(attached, 'pdf', bytes, parsed);
    const values = await valuesOf(file.abs);
    expect(values.File).toEqual([
      {
        Kind: 'pid',
        'Rules kind': 'unsure',
        'Decider answer': 'a made-up paid answer',
        'Vision read': 'a made-up paid sketch read',
      },
    ]);
    expect(
      (values['Site tags'] as { Tag: string; Page: number }[]).map((r) => [r.Tag, r.Page]),
    ).toEqual([
      ['40-PSV-0012', 1],
      ['FIC-102', 2],
    ]);
    expect(metaOf(file.abs).shapes).toBe('pdf-file-v1');
    // The reader's rows came in parsed; Site tags is one job.
    expect(fetches).toEqual(['http://parser.test:8095/pipeline/run']);
  });

  it('attached, a drawing with no Texts tab: no match, no job, no entry', async () => {
    const bytes = Buffer.from(`%PDF-1.7 a made-up drawing ${randomUUID()}`);
    const file = await built(attached, 'pdf', bytes, {
      kind: 'sheets',
      sheets: [
        {
          name: 'File',
          columns: [{ name: 'Kind', type: 'text' }],
          rows: [['pid']],
        },
      ],
    });
    expect(await tabNames(file.abs)).not.toContain('Site tags');
    expect(metaOf(file.abs).pipelines_after).toBeUndefined();
    expect(fetches).toEqual([]);
  });

  it('an adapter that throws leaves the reader database in place, with no entry', async () => {
    h.throwScan = true;
    const yes = await built(attached, 'dxf', dxf());
    h.throwScan = false;
    const no = await built(other, 'dxf', dxf());
    expect(await tabNames(yes.abs)).toEqual(await tabNames(no.abs));
    expect(Object.keys(metaOf(yes.abs))).toEqual(PHASE1_KEYS);
    expect(await valuesOf(yes.abs)).toEqual(await valuesOf(no.abs));
  });

  it('the parser busy at upload: the reader database stands, no tag and no entry, and ONE run is queued', async () => {
    const was = (await ps.pipelineStateOf(anchor, site())).workspaces;
    expect((await setState({ workspaces: [attached] })).ok).toBe(true);
    try {
      h.run = 'busy';
      // A person waiting skips the busy waits of the client: the test's
      // stand-in for the tries that end busy under load.
      const file = await f.withParserScope({ interactive: true }, () =>
        built(attached, 'dxf', dxf()),
      );
      expect(await tabNames(file.abs)).not.toContain('Site tags');
      expect(metaOf(file.abs).pipelines_after).toBeUndefined();
      expect((await fd.readFileDbStamp(file.id, file.sha))?.pipeline_id).toBe('drawing-cad');
      expect(h.notified).toEqual([`site-tags:${file.id}`]);

      // The run job patches by patchFileDatabase, never through the
      // chain: busy again, it fails and queues no second run.
      await expect(
        f.withParserScope({ interactive: true }, () =>
          fd.patchFileDatabase({
            fileId: file.id,
            ownerId: anchor,
            sha256: file.sha,
            pipeline: site(),
          }),
        ),
      ).rejects.toMatchObject({ code: 'busy' });
      expect(h.notified).toHaveLength(1);
    } finally {
      await setState({ workspaces: was === 'all' ? [] : was });
    }
  });

  it('a failed job at upload (a verdict on the input): no run is queued', async () => {
    const was = (await ps.pipelineStateOf(anchor, site())).workspaces;
    expect((await setState({ workspaces: [attached] })).ok).toBe(true);
    try {
      h.run = 'failed';
      const file = await built(attached, 'dxf', dxf());
      expect(await tabNames(file.abs)).not.toContain('Site tags');
      expect(metaOf(file.abs).pipelines_after).toBeUndefined();
      expect(h.notified).toEqual([]);
    } finally {
      await setState({ workspaces: was === 'all' ? [] : was });
    }
  });

  it('a spreadsheet with sheets named Texts and Site tags is not touched', async () => {
    const bytes = Buffer.from(`a made-up workbook ${randomUUID()}`);
    const parsed = {
      kind: 'sheets' as const,
      sheets: [
        { name: 'Texts', columns: [{ name: 'Text', type: 'text' as const }], rows: [['FIC-101']] },
        {
          name: 'Site tags',
          columns: [{ name: 'Mine', type: 'text' as const }],
          rows: [['a cell of my own']],
        },
      ],
    };
    const file = await built(attached, 'xlsx', bytes, parsed);
    expect(await valuesOf(file.abs)).toEqual({
      Texts: [{ Text: 'FIC-101' }],
      'Site tags': [{ Mine: 'a cell of my own' }],
    });
    expect(metaOf(file.abs).pipelines_after).toBeUndefined();
  });

  it('patchFileDatabase: other options replace the tab and write the hash; the same input twice gives the same rows', async () => {
    const file = await built(attached, 'dxf', dxf());
    const reader = await valuesOf(file.abs, ['Site tags']);
    expect(
      (await setState({ options: { equipment_types: ['EA'], line_services: ['P'] } })).ok,
    ).toBe(true);
    const state = await ps.pipelineStateOf(anchor, site());
    expect(state.optionsHash).toMatch(/^[0-9a-f]{8}$/);
    const patch = () =>
      fd.patchFileDatabase({
        fileId: file.id,
        ownerId: anchor,
        sha256: file.sha,
        pipeline: site(),
      });
    expect(await patch()).toEqual({ status: 'patched', tabs: 1, rows: 3, warnings: [] });
    const once = await valuesOf(file.abs);
    expect(
      (once['Site tags'] as { Tag: string; Type: string }[]).map((r) => [r.Tag, r.Type]),
    ).toEqual([
      ['FIC-101', 'instrument'],
      ['EA-101', 'equipment'],
      ['P-1001-A1A', 'line'],
    ]);
    expect(metaOf(file.abs).pipelines_after).toBe(`site-tags@1.0.0#${state.optionsHash}`);
    await patch();
    expect(await valuesOf(file.abs)).toEqual(once);
    expect(await valuesOf(file.abs, ['Site tags'])).toEqual(reader);
    expect(await tabNames(file.abs)).toEqual(Object.keys(once));
    // A file with no database, or bytes that are not the row's: nothing.
    const bare = await upload(attached, 'dxf', dxf());
    expect(
      await fd.patchFileDatabase({
        fileId: bare.id,
        ownerId: anchor,
        sha256: sha256(Buffer.from('other bytes')),
        pipeline: site(),
      }),
    ).toEqual({ status: 'skipped', reason: 'stale' });
    // A reader is not an after pipeline.
    expect(
      await fd.patchFileDatabase({
        fileId: file.id,
        ownerId: anchor,
        sha256: file.sha,
        pipeline: f.builtinForExt('dxf')!,
      }),
    ).toEqual({ status: 'skipped', reason: 'not-after' });
    await setState({ options: { equipment_types: [], line_services: [] }, workspaces: [] });
  });

  it('the runs: a build adds one to its reader, a patch one to its after pipeline, a skip and a word none', async () => {
    const cad = f.builtinForExt('dxf')!;
    const sheet = f.builtinForExt('csv')!;
    const runs = async () =>
      Object.fromEntries(
        await Promise.all(
          [cad, sheet, site()].map(async (p) => [p.id, (await ps.pipelineStateOf(anchor, p)).runs]),
        ),
      );
    const before = await runs();
    const file = await built(attached, 'dxf', dxf());
    let now = await runs();
    expect(now[cad.id]).toBe(before[cad.id] + 1);
    expect(now[site().id]).toBe(before[site().id]);
    expect((await ps.pipelineStateOf(anchor, cad)).lastRunAt).toBeInstanceOf(Date);
    // A patch counts for the after pipeline only.
    expect(
      (
        await fd.patchFileDatabase({
          fileId: file.id,
          ownerId: anchor,
          sha256: file.sha,
          pipeline: site(),
        })
      ).status,
    ).toBe('patched');
    const patched = await runs();
    expect(patched[site().id]).toBe(now[site().id] + 1);
    expect(patched[cad.id]).toBe(now[cad.id]);
    // A skip (bytes that are not the row's) and a word (a CSV with no rows)
    // count none.
    const bare = await upload(attached, 'csv', Buffer.from('a,b\n'));
    await fd.buildFileDatabase({
      fileId: bare.id,
      ownerId: anchor,
      sha256: sha256(Buffer.from('other bytes')),
      bytes: Buffer.from('other bytes'),
      filename: bare.filename,
    });
    const empty = Buffer.from(`only,a,header,${randomUUID().slice(0, 4)}\n`);
    const word = await upload(attached, 'csv', empty);
    expect(
      (
        await fd.buildFileDatabase({
          fileId: word.id,
          ownerId: anchor,
          sha256: sha256(empty),
          bytes: empty,
          filename: word.filename,
        })
      ).status,
    ).toBe('none');
    now = await runs();
    expect(now).toEqual(patched);
    // A count that fails: the build and the patch stand, and nothing is counted.
    h.throwCount = true;
    const again = await built(attached, 'dxf', dxf());
    expect(await tabNames(again.abs)).toContain('Texts');
    expect(
      (
        await fd.patchFileDatabase({
          fileId: again.id,
          ownerId: anchor,
          sha256: again.sha,
          pipeline: site(),
        })
      ).status,
    ).toBe('patched');
    expect(await runs()).toEqual(patched);
  });

  it('a row the count makes reads as the defaults of the code', async () => {
    const plan = f.builtinForExt('xml')!;
    await ps.countPipelineRun(anchor, plan.id);
    await ps.countPipelineRun(anchor, plan.id);
    const state = await ps.pipelineStateOf(anchor, plan);
    expect(state).toMatchObject({ workspaces: 'all', options: {}, optionsHash: '', runs: 2 });
    const [row] = await x<{
      updated_by: string | null;
      workspaces: string[] | null;
      options: unknown;
    }>(
      sqlTag`select updated_by, workspaces, options from pipeline_state
              where owner_id = ${anchor} and pipeline_id = ${plan.id}`,
    );
    expect(row).toEqual({ updated_by: null, workspaces: null, options: {} });
    // An after pipeline with no row: the row its count makes leaves it
    // attached to NO workspace, with its default options.
    // (A brain id of its own: the anchor's Site tags row was set above.)
    const other = randomUUID();
    await ps.countPipelineRun(other, site().id);
    expect(await ps.pipelineStateOf(other, site())).toMatchObject({
      workspaces: [],
      options: f.effectiveOptions(site(), {}),
      optionsHash: '',
      runs: 1,
    });
    // A set after it keeps the count.
    expect((await ps.setPipelineState(anchor, null, plan, { options: {} })).ok).toBe(true);
    expect((await ps.pipelineStateOf(anchor, plan)).runs).toBe(2);
  });
});
