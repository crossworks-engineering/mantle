/**
 * The text and the pictures of a file from its own Reader (docs/pipelines.md,
 * "Text and pictures from every Reader"), on a real migrated Postgres and a
 * real files root. The own rows are the templates (docs/pipeline-template,
 * made up): `qnote/` gives a text and no tabs, `bun/` (LX-9) gives tabs and
 * a text, here also with a picture. The parser is faked at the fetch, and
 * its `pipelineRun` job runs the template's step in this process; each job
 * is counted (the real job from the mount is proven through a real parser:
 * packages/content/src/pipeline-runner.test.ts).
 *
 *  - A text-only upload: no database, the word `no-rows` with the stamp as
 *    its second line, the run counted, the text for the extract, and ONE
 *    parser job for the database pass and the text pass.
 *  - An upload with tabs, text and a picture: the database, the text, the
 *    picture as an image file, and ONE parser job for the three passes.
 *  - A re-extract whose run is no longer kept runs the Reader once.
 *  - A Reader that is off in the file's home workspace gives no tabs, no
 *    text and no picture, and sends no job.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract/own-pipeline-text.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import type { PipelineStep } from '@mantle/files';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TEMPLATES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../docs/pipeline-template',
);
/** A template folder as an install sends it, with manifest changes. */
const pkg = (folder: string, change: Record<string, unknown> = {}) => {
  const out: Record<string, string> = {};
  for (const n of readdirSync(path.join(TEMPLATES, folder))) {
    if (n.startsWith('sample.')) continue;
    out[n] = readFileSync(path.join(TEMPLATES, folder, n), 'utf8');
  }
  out['pipeline.json'] = JSON.stringify({ ...JSON.parse(out['pipeline.json']!), ...change });
  return { files: out };
};

/** A made-up PNG of noise, large enough for the picture gate. */
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
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let seed = 7;
  for (let i = 0; i < raw.length; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    raw[i] = i % (w * 3 + 1) === 0 ? 0 : seed >>> 24;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe.skipIf(!URL)('the text and the pictures of an own Reader', () => {
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  let maybeAutoTableSpreadsheet: typeof import('./auto-table').maybeAutoTableSpreadsheet;
  let maybeExtractEmbeddedImages: typeof import('./images').maybeExtractEmbeddedImages;
  let loadExtractableBody: typeof import('./load-body').loadExtractableBody;
  let state: typeof import('@mantle/content/pipeline-state');
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const FOLDER = 'files.p32';
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-own-text-'));
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
  /** The passes of an extract, in their order (gates.ts): the database,
   *  the pictures, then the text. */
  const extract = async (id: string) => {
    await maybeAutoTableSpreadsheet(await nodeRow(id), anchor);
    await maybeExtractEmbeddedImages(await nodeRow(id), anchor, 30);
    return body(id);
  };
  const body = async (id: string) => {
    const node = await nodeRow(id);
    return loadExtractableBody(
      node,
      anchor,
      { slug: 'test-extractor' } as never,
      (node.data ?? {}) as Record<string, unknown>,
    );
  };
  const runs = async (id: string) =>
    (
      await x<{ runs: number }>(sqlTag`select runs::int as runs from pipeline_state
        where owner_id = ${anchor} and pipeline_id = ${id}`)
    )[0]?.runs ?? 0;
  const images = async (id: string) =>
    x<{ id: string }>(sqlTag`select id from nodes where owner_id = ${anchor} and type = 'file'
      and data->>'sourceFileId' = ${id}`);
  const install = (id: string, folder: string, change?: Record<string, unknown>) =>
    state.underPackageLock(anchor, id, (row) => row.put(null, pkg(folder, change)));
  const remove = (id: string) => state.underPackageLock(anchor, id, (row) => row.remove());
  const qnote = () =>
    Buffer.concat([
      readFileSync(path.join(TEMPLATES, 'qnote', 'sample.qnote')),
      Buffer.from(`Note ${randomUUID()}.\n`),
    ]);
  const lx9 = () =>
    Buffer.concat([
      readFileSync(path.join(TEMPLATES, 'sample.lx9')),
      Buffer.from(`#NOTE=${randomUUID()}\n`),
    ]);

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    state = await import('@mantle/content/pipeline-state');
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
    f.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const all = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
        const n = Number(new Headers(init?.headers).get('x-parser-opts-length') ?? 0);
        const opts = JSON.parse(all.subarray(0, n).toString('utf8')) as {
          id: string;
          request: Parameters<PipelineStep>[0];
        };
        jobs.push(opts.id);
        const folder = opts.id === 'qnote-field-note' ? 'qnote' : 'bun';
        const { step } = (await import(path.join(TEMPLATES, folder, 'step.ts'))) as {
          step: PipelineStep;
        };
        const { inProcessStepJob } = await import('@mantle/files/pipelines/test-job');
        const result = await step(opts.request, inProcessStepJob(all.subarray(n), root));
        // The LX-9 Reader with a picture: its write names a trend picture,
        // and the job sends its bytes, as a real job does for a file the
        // step wrote in its folder.
        const write = result.calls?.[0];
        if (opts.id === 'lx9-logger' && write?.call === 'tool') {
          (write.input as Record<string, unknown>).pictures = [
            { file: 'trend.png', mime: 'image/png', caption: 'Trend of PT-101' },
          ];
          return Response.json({
            ok: true,
            result,
            pictures: [{ file: 'trend.png', bytes_base64: PNG.toString('base64') }],
          });
        }
        return Response.json({ ok: true, result, pictures: [] });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('a text-only upload: no database, the word with the stamp, the text, one job', async () => {
    await install('qnote-field-note', 'qnote');
    const file = await upload(`${randomUUID().slice(0, 8)}.qnote`, qnote());
    const got = await extract(file.id);
    expect(got.ok && got.rawBody).toMatch(/Pump room walk-down\. Date: 2026-02-11\./);
    expect(got.ok && got.rawBody).toMatch(/P-201 runs warm/);
    // The database pass and the text pass: one job (the picture pass asks
    // none: the Reader gives no pictures).
    expect(jobs).toEqual(['qnote-field-note']);
    const sha = await shaOf(file.id);
    expect(await f.fileDbSqlitePath(file.id, sha)).toBeNull();
    expect(await f.readFileDbNone(file.id, sha)).toBe('no-rows');
    expect(f.stampOfMeta(await f.readFileDbNoneStamp(file.id, sha))).toEqual({
      pipeline_id: 'qnote-field-note',
      pipeline_version: '1.0.0',
      pipeline_api: '1',
      shapes: '',
    });
    expect(await runs('qnote-field-note')).toBe(1);
    expect(await images(file.id)).toEqual([]);
    await remove('qnote-field-note');
  });

  it('tabs, text and a picture: the three passes take one job', async () => {
    await install('lx9-logger', 'bun', { produces: { text: true, pictures: true } });
    const file = await upload(`${randomUUID().slice(0, 8)}.lx9`, lx9());
    const got = await extract(file.id);
    expect(jobs).toEqual(['lx9-logger']);
    expect(got.ok && got.rawBody).toMatch(
      /LX-9 logger export from Test bench A\. Tags: PT-101, PT-102\./,
    );
    expect(await f.fileDbSqlitePath(file.id, await shaOf(file.id))).not.toBeNull();
    expect(await images(file.id)).toHaveLength(1);
    await remove('lx9-logger');
  });

  it('a re-extract whose run is no longer kept runs the Reader once', async () => {
    await install('qnote-field-note', 'qnote');
    const file = await upload(`${randomUUID().slice(0, 8)}.qnote`, qnote());
    await extract(file.id);
    // Two other files: the memo keeps two runs, so this file's run goes.
    for (let i = 0; i < 2; i += 1) {
      await extract((await upload(`${randomUUID().slice(0, 8)}.qnote`, qnote())).id);
    }
    jobs.length = 0;
    const again = await body(file.id);
    expect(again.ok && again.rawBody).toMatch(/Pump room walk-down/);
    expect(jobs).toEqual(['qnote-field-note']);
    await remove('qnote-field-note');
  });

  it('off in the file’s home workspace: no tabs, no text, no picture, and no job', async () => {
    await install('lx9-logger', 'bun', { produces: { text: true, pictures: true } });
    const { boxPipelines } = await import('@mantle/content/pipeline-registry');
    const p = (await boxPipelines(anchor)).byId('lx9-logger')!;
    expect(await state.setPipelineState(anchor, null, p, { offIn: [team] })).toMatchObject({
      ok: true,
    });
    const file = await upload(`${randomUUID().slice(0, 8)}.lx9`, lx9());
    const got = await extract(file.id);
    expect(got.ok).toBe(false); // no_parser: nothing reads .lx9 here
    expect(jobs).toEqual([]);
    const sha = await shaOf(file.id);
    expect(await f.fileDbSqlitePath(file.id, sha)).toBeNull();
    expect(await f.readFileDbNone(file.id, sha)).toBeNull();
    expect(await images(file.id)).toEqual([]);
    await remove('lx9-logger');
  });
});
