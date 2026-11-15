/**
 * An upload read by an own pipeline (docs/pipelines.md, "Own pipelines"),
 * on a real migrated Postgres and a real files root. The own row is the Bun
 * template (docs/pipeline-template/bun, made up); the parser is faked at
 * the fetch, and its `pipelineRun` job for an own id runs the template's
 * step in this process (the real job from the mount is proven through a
 * real parser: packages/content/src/pipeline-runner.test.ts).
 *
 *  - An upload of a `.lx9` file gets its database with the two tabs and the
 *    stamp of the own pipeline at its version; the job names the id and the
 *    version; the count of runs goes to 1.
 *  - A failed read counts against that version: the second is final, and
 *    the file gets its word; a higher version gets its own tries.
 *  - After a remove, a `.lx9` upload gets nothing and sends no job, as before
 *    the install.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract/own-pipeline-upload.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import type { PipelineStep } from '@mantle/files';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const TEMPLATES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../docs/pipeline-template',
);
const files = (version: string) => {
  const out: Record<string, string> = {};
  for (const n of readdirSync(path.join(TEMPLATES, 'bun'))) {
    out[n] = readFileSync(path.join(TEMPLATES, 'bun', n), 'utf8');
  }
  out['pipeline.json'] = JSON.stringify({ ...JSON.parse(out['pipeline.json']!), version });
  return { files: out };
};

describe.skipIf(!URL)('an upload read by an own pipeline', () => {
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  let maybeAutoTableSpreadsheet: typeof import('./auto-table').maybeAutoTableSpreadsheet;
  let state: typeof import('@mantle/content/pipeline-state');
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const FOLDER = 'files.p31';
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-own-pipeline-'));
  /** The own jobs the fake parser got: id and version. */
  const jobs: { id: string; version?: string }[] = [];
  let fail = false;

  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sqlTag>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
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
  const pass = async (id: string) => maybeAutoTableSpreadsheet(await nodeRow(id), anchor);
  const open = (abs: string) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    return new DatabaseSync(abs, { readOnly: true });
  };
  /** A made-up export, other bytes each time. */
  const sample = () =>
    Buffer.concat([
      readFileSync(path.join(TEMPLATES, 'sample.lx9')),
      Buffer.from(`#NOTE=${randomUUID()}\n`),
    ]);

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    state = await import('@mantle/content/pipeline-state');
    sqlTag = (await import('drizzle-orm')).sql;
    ({ maybeAutoTableSpreadsheet } = await import('./auto-table'));
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
    fail = false;
    f.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const all = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
        const n = Number(new Headers(init?.headers).get('x-parser-opts-length') ?? 0);
        const opts = JSON.parse(all.subarray(0, n).toString('utf8')) as {
          id: string;
          version?: string;
          request: Parameters<PipelineStep>[0];
        };
        jobs.push({ id: opts.id, version: opts.version });
        if (fail) {
          return Response.json(
            { ok: false, error: { code: 'timeout', message: 'a made-up timeout' } },
            { status: 504 },
          );
        }
        const { step } = (await import(path.join(TEMPLATES, 'bun', 'step.ts'))) as {
          step: PipelineStep;
        };
        const { inProcessStepJob } = await import('@mantle/files/pipelines/test-job');
        const result = await step(opts.request, inProcessStepJob(all.subarray(n), root));
        return Response.json({ ok: true, result, pictures: [] });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('an upload gets its database, with the stamp of the own pipeline at its version', async () => {
    await state.putOwnPackage(anchor, null, 'lx9-logger', files('1.0.0'));
    const file = await upload(`${randomUUID().slice(0, 8)}.lx9`, sample());
    await pass(file.id);
    expect(jobs).toEqual([{ id: 'lx9-logger', version: '1.0.0' }]);
    const abs = f.fileDbPaths(file.id, await shaOf(file.id))!.sqlite;
    const db = open(abs);
    expect(db.prepare(`SELECT "Tag", "Value", "Unit" FROM "Readings" ORDER BY _pos`).all()).toEqual(
      [
        { Tag: 'PT-101', Value: 412.5, Unit: 'kPa' },
        { Tag: 'PT-102', Value: 398, Unit: 'kPa' },
        { Tag: 'PT-101', Value: 413.1, Unit: 'kPa' },
      ],
    );
    db.close();
    const { readFileDbStamp } = await import('@mantle/content/file-database');
    expect(await readFileDbStamp(file.id, await shaOf(file.id))).toMatchObject({
      pipeline_id: 'lx9-logger',
      pipeline_version: '1.0.0',
    });
    const [row] = await x<{ runs: number }>(sqlTag`select runs::int as runs from pipeline_state
      where owner_id = ${anchor} and pipeline_id = 'lx9-logger'`);
    expect(row!.runs).toBe(1);
  });

  it('the second failed read is final for that version only; a higher version gets its own tries', async () => {
    await state.putOwnPackage(anchor, null, 'lx9-logger', files('1.0.0'));
    const bytes = sample();
    const file = await upload(`${randomUUID().slice(0, 8)}.lx9`, bytes);
    fail = true;
    await expect(pass(file.id)).rejects.toThrow();
    await pass(file.id);
    expect(await f.readFileDbNone(file.id, await shaOf(file.id))).toBe('unreadable');
    expect(jobs).toHaveLength(2);
    // The same bytes in another file, at 1.0.0: final, nothing is sent.
    const twin = await upload(`${randomUUID().slice(0, 8)}.lx9`, bytes);
    await pass(twin.id);
    expect(jobs).toHaveLength(2);
    expect(await f.readFileDbNone(twin.id, await shaOf(twin.id))).toBe('unreadable');
    // 1.0.1 has its own tries: the same bytes are sent again, and read.
    await state.putOwnPackage(anchor, null, 'lx9-logger', files('1.0.1'));
    fail = false;
    const third = await upload(`${randomUUID().slice(0, 8)}.lx9`, bytes);
    await pass(third.id);
    expect(jobs.at(-1)).toEqual({ id: 'lx9-logger', version: '1.0.1' });
    const { readFileDbStamp } = await import('@mantle/content/file-database');
    expect(await readFileDbStamp(third.id, await shaOf(third.id))).toMatchObject({
      pipeline_version: '1.0.1',
    });
  });

  it('with no own row, a .lx9 upload gets nothing and sends no job', async () => {
    await state.removeOwnRow(anchor, 'lx9-logger');
    const file = await upload(`${randomUUID().slice(0, 8)}.lx9`, sample());
    await pass(file.id);
    expect(jobs).toEqual([]);
    expect(await f.readFileDbNone(file.id, await shaOf(file.id))).toBeNull();
    expect(await f.fileDbSqlitePath(file.id, await shaOf(file.id))).toBeNull();
  });
});
