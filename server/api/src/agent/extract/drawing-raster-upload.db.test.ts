/**
 * The built-in raster reader `drawing-raster` at upload (docs/pipelines.md, "The
 * raster drawing reader"), on a real migrated Postgres and a real files root.
 * The parser is faked at the fetch: its `pipelineRun` job answers as the
 * Python step does (the step itself is tested in
 * server/parser/cad/tests/test_drawing_raster.py). The core's raw image read is
 * a spy, so no model is asked.
 *
 *  - A drawing `.tif` (the Reader takes it): the database with the Drawing
 *    tab, no automatic Table (`produces.table: false`), the Reader's text as
 *    the file's text, its picture, ONE parser job, and no raw image read.
 *  - A photo `.tif` (the Reader says `not_mine`): no database, no Table, the
 *    raw image read as before, and one parser job.
 *  - The chain to the Agent `iso-title-block` (docs/pipelines.md, "Agents"):
 *    the build of a drawing `.tif` queues ONE run of it, a second pass
 *    queues none, and a photo `.tif` queues none. The notify is recorded at
 *    `notifyPipelineRun`; nothing listens here, so no Agent runs and no
 *    model is asked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract/drawing-raster-upload.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import type { PipelineStepRequest } from '@mantle/files';

const vision = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./images', async (orig) => ({
  ...(await orig<typeof import('./images')>()),
  visionIngestImageNode: async () => {
    vision.calls += 1;
    return { text: 'A photo of a pump on a skid.', failure: null, ran: true };
  },
}));

// The run of an Agent the build of an upload queues: recorded, then sent.
const h = vi.hoisted(() => ({
  /** The runs asked for (notifyPipelineRun), `<pipeline>:<node>`. */
  notified: [] as string[],
}));
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

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** A made-up gray PNG of noise, large enough for the picture gate. */
function noisePng(w = 240, h = 240): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const raw = Buffer.alloc((w + 1) * h);
  let seed = 11;
  for (let i = 0; i < raw.length; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    raw[i] = i % (w + 1) === 0 ? 0 : seed >>> 24;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TEXT = 'TIFF raster, a drawing sheet of 267 x 190 mm.';

describe.skipIf(!URL)('the raster reader drawing-raster at upload', () => {
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  let maybeAutoTableSpreadsheet: typeof import('./auto-table').maybeAutoTableSpreadsheet;
  let maybeExtractEmbeddedImages: typeof import('./images').maybeExtractEmbeddedImages;
  let loadExtractableBody: typeof import('./load-body').loadExtractableBody;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const FOLDER = 'files.p33';
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-drawing-raster-'));
  /** The jobs the fake parser got, by pipeline id. */
  const jobs: string[] = [];
  const PNG = noisePng();

  const x = async <T>(q: ReturnType<typeof sqlTag>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const upload = async (name: string, bytes: Buffer) =>
    m.withCreateHome({ createWs: team, privateWs: null }, () =>
      f.upsertFile({ ownerId: anchor, parentPath: FOLDER, filename: name, bytes, overwrite: true }),
    );
  const nodeRow = async (id: string) => {
    const { eq } = await import('drizzle-orm');
    const [row] = await m.db.select().from(m.nodes).where(eq(m.nodes.id, id)).limit(1);
    return row!;
  };
  const shaOf = async (id: string) =>
    ((await nodeRow(id)).data as Record<string, unknown>).sha256 as string;
  /** The passes of an extract, in their order (gates.ts). */
  const extract = async (id: string) => {
    await maybeAutoTableSpreadsheet(await nodeRow(id), anchor);
    await maybeExtractEmbeddedImages(await nodeRow(id), anchor, 30);
    const node = await nodeRow(id);
    return loadExtractableBody(
      node,
      anchor,
      { slug: 'test-extractor' } as never,
      (node.data ?? {}) as Record<string, unknown>,
    );
  };
  const childrenOf = async (id: string, type: string) =>
    x<{ id: string }>(sqlTag`select id from nodes where owner_id = ${anchor} and type = ${type}
      and data->>'sourceFileId' = ${id}`);
  /** A made-up TIFF head: a drawing (the fake parser's step takes it) or a
   *  photo (it says not_mine). Unique bytes, so each upload is new. */
  const tiff = (kind: 'DRAW' | 'PHOT') =>
    Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.from(`${kind}${randomUUID()}`)]);

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    sqlTag = (await import('drizzle-orm')).sql;
    ({ maybeAutoTableSpreadsheet } = await import('./auto-table'));
    ({ maybeExtractEmbeddedImages } = await import('./images'));
    ({ loadExtractableBody } = await import('./load-body'));
    const admin = (m.systemDb as unknown as { $client: Parameters<typeof m.ensureViewerRoles>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);
    await su(sqlTag`insert into workspaces (id, owner_id, name)
      values (${team}, ${anchor}, ${`team ${team.slice(0, 8)}`})`);
    await su(sqlTag`insert into workspaces (owner_id, name, is_admin)
      select ${anchor}::uuid, 'Admin', true where mantle_ws_admin_id(${anchor}::uuid) is null`);
    await x(sqlTag`insert into nodes (owner_id, type, title, slug, path)
      values (${anchor}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    await m.withCreateHome({ createWs: team, privateWs: null }, () =>
      m.withNodeInsertHeads(anchor, [{ type: 'branch', path: FOLDER }], (tx) =>
        tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
          values (${randomUUID()}, ${anchor}, 'branch', ${FOLDER}, ${FOLDER}::ltree)`),
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    jobs.length = 0;
    h.notified.length = 0;
    vision.calls = 0;
    f.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const all = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
        const n = Number(new Headers(init?.headers).get('x-parser-opts-length') ?? 0);
        const opts = JSON.parse(all.subarray(0, n).toString('utf8')) as {
          id: string;
          request: PipelineStepRequest;
        };
        jobs.push(opts.id);
        const body = all.subarray(n).toString('latin1');
        if (opts.id !== 'drawing-raster' || !body.includes('DRAW')) {
          return Response.json({ ok: true, result: { status: 'not_mine' }, pictures: [] });
        }
        const result = {
          status: 'ok',
          calls: [
            {
              call: 'tool',
              tool: 'file_tabs_write',
              input: {
                tabs: [
                  {
                    name: 'Drawing',
                    columns: [
                      { name: 'Key', type: 'text' },
                      { name: 'Value', type: 'text' },
                    ],
                    rows: [
                      ['Format', 'TIFF raster'],
                      ['DPI', '200'],
                    ],
                  },
                ],
                description: 'TIFF raster.',
                text: TEXT,
                pictures: [{ file: 'sheet.png', mime: 'image/png', caption: 'The whole sheet' }],
              },
            },
          ],
        };
        return Response.json({
          ok: true,
          result,
          pictures: [{ file: 'sheet.png', bytes_base64: PNG.toString('base64') }],
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('a drawing tif: its database, no Table, the Reader text, its picture, one job, no raw image read', async () => {
    const file = await upload(`${randomUUID().slice(0, 8)}.tif`, tiff('DRAW'));
    const got = await extract(file.id);
    expect(got.ok && got.rawBody).toBe(TEXT);
    expect(vision.calls).toBe(0);
    expect(jobs).toEqual(['drawing-raster']);
    expect(await f.fileDbSqlitePath(file.id, await shaOf(file.id))).not.toBeNull();
    expect(await childrenOf(file.id, 'table')).toEqual([]);
    expect(await childrenOf(file.id, 'file')).toHaveLength(1);
  });

  it('a photo tif: not_mine, so no database and no Table, and the raw image read as before', async () => {
    const file = await upload(`${randomUUID().slice(0, 8)}.tif`, tiff('PHOT'));
    const got = await extract(file.id);
    expect(got.ok && got.rawBody).toMatch(/A photo of a pump on a skid\./);
    expect(vision.calls).toBe(1);
    expect(jobs).toEqual(['drawing-raster']);
    const sha = await shaOf(file.id);
    expect(await f.fileDbSqlitePath(file.id, sha)).toBeNull();
    expect(await f.readFileDbNone(file.id, sha)).toBeNull();
    expect(await childrenOf(file.id, 'table')).toEqual([]);
    expect(await childrenOf(file.id, 'file')).toEqual([]);
    // No database, so no run of the Agent is queued.
    expect(h.notified).toEqual([]);
  });

  it('the chain: a drawing tif gets the Drawing tab, and its build queues one run of the Agent, once', async () => {
    const file = await upload(`${randomUUID().slice(0, 8)}.tif`, tiff('DRAW'));
    await maybeAutoTableSpreadsheet(await nodeRow(file.id), anchor);
    expect(jobs).toEqual(['drawing-raster']);
    const sha = await shaOf(file.id);
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(f.fileDbPaths(file.id, sha)!.sqlite, { readOnly: true });
    expect(db.prepare(`SELECT "Key" FROM "Drawing" ORDER BY _pos`).all()).toEqual([
      { Key: 'Format' },
      { Key: 'DPI' },
    ]);
    db.close();
    const { readFileDbStamp } = await import('@mantle/content/file-database');
    expect(await readFileDbStamp(file.id, sha)).toMatchObject({ pipeline_id: 'drawing-raster' });
    expect(h.notified).toEqual([`iso-title-block:${file.id}`]);

    // A second pass of the same file builds nothing and queues nothing.
    await maybeAutoTableSpreadsheet(await nodeRow(file.id), anchor);
    expect(jobs).toEqual(['drawing-raster']);
    expect(h.notified).toEqual([`iso-title-block:${file.id}`]);
  });
});
