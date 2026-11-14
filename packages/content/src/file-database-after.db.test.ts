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
 *    hash, and a second patch of the same input gives the same rows.
 * The parser is faked at the fetch (the CAD tier), with made-up texts; any
 * other fetch fails the test, so no model is asked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/file-database-after.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ throwScan: false }));

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
    h.throwScan = false;
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        fetches.push(String(url));
        if (!String(url).includes('/dwg/render')) {
          return Response.json({ ok: false, error: { code: 'unavailable' } }, { status: 503 });
        }
        return Response.json({
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
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const onlyParser = () => {
    for (const call of fetches) expect(call).toMatch(/^http:\/\/parser\.test:8095\/dwg\/render/);
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
    onlyParser();
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
    onlyParser();
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
});
