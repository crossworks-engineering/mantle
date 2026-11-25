/**
 * The built-in Reader `access` at upload (docs/pipelines.md, "The Access
 * reader"), on a real migrated Postgres and a real files root. The parser
 * job is the real step run in this process (inProcessPipelineFetch), on a
 * public test database (packages/files/src/pipelines/pkg/access/fixtures,
 * SOURCES.md). No model is asked.
 *
 *  - An `.accdb`: one parser job; the file database at
 *    `.file-dbs/<id>.<sha16>.sqlite` with a tab per table with rows, its
 *    columns typed as in Access, and the description; the Reader's text is
 *    the file's text (a summary of the tables, then their rows).
 *  - An `.accdb` encrypted with a password: no tab (the word `no-rows`), the
 *    text that says it is locked, and the cut `access_password` noted.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract/access-upload.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import { inProcessPipelineFetch } from '@mantle/files/pipelines/test-job';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const FIXTURES = path.resolve(
  path.dirname(new globalThis.URL(import.meta.url).pathname),
  '../../../../../packages/files/src/pipelines/pkg/access/fixtures',
);
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));

describe.skipIf(!URL)('the Access reader at upload', () => {
  let m: typeof import('@mantle/db');
  let f: typeof import('@mantle/files');
  let sqlTag: typeof import('drizzle-orm').sql;
  let maybeAutoTableSpreadsheet: typeof import('./auto-table').maybeAutoTableSpreadsheet;
  let loadExtractableBody: typeof import('./load-body').loadExtractableBody;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  const team = randomUUID();
  const FOLDER = 'files.access';
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-access-'));
  /** The parser jobs, by pipeline id. */
  const jobs: string[] = [];

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
  /** The database and text passes of an extract, in their order (gates.ts). */
  const extract = async (id: string) => {
    await maybeAutoTableSpreadsheet(await nodeRow(id), anchor);
    const node = await nodeRow(id);
    return loadExtractableBody(
      node,
      anchor,
      { slug: 'test-extractor' } as never,
      (node.data ?? {}) as Record<string, unknown>,
    );
  };

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
    const run = inProcessPipelineFetch();
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const n = Number(new Headers(init?.headers).get('x-parser-opts-length') ?? 0);
      const body = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
      jobs.push((JSON.parse(body.subarray(0, n).toString('utf8')) as { id: string }).id);
      return run(input, { ...init, body });
    });
    return () => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    };
  });

  it('an .accdb: one job, a typed tab per table with rows, and the text of its tables', async () => {
    const file = await upload(`${randomUUID().slice(0, 8)}.accdb`, fixture('types.accdb'));
    const got = await extract(file.id);
    expect(jobs).toEqual(['access']);
    expect(got.ok && got.rawBody).toContain(
      '# Microsoft Access database (.accdb): 4 tables, 2 rows',
    );
    expect(got.ok && got.rawBody).toContain('a,b,0,0,0,0,1981-12-12,0,FALSE');

    const sha = await shaOf(file.id);
    const at = f.fileDbPaths(file.id, sha)!.sqlite;
    expect(at.endsWith(`/.file-dbs/${file.id}.${sha.slice(0, 16)}.sqlite`)).toBe(true);
    expect(await f.fileDbSqlitePath(file.id, sha)).not.toBeNull();
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(at, { readOnly: true });
    try {
      expect(db.prepare(`SELECT "A", "C", "G", "I" FROM "Table1" ORDER BY _pos`).all()).toEqual([
        { A: 'a', C: 0, G: '1981-12-12', I: 0 },
        expect.objectContaining({ A: expect.any(String) }),
      ]);
      const types = Object.fromEntries(
        (db.prepare(`PRAGMA table_info("Table1")`).all() as { name: string; type: string }[]).map(
          (c) => [c.name, c.type],
        ),
      );
      expect(types).toMatchObject({ A: 'TEXT', C: 'REAL', G: 'TEXT', I: 'INTEGER' });
    } finally {
      db.close();
    }
    const { readFileDbStamp } = await import('@mantle/content/file-database');
    expect(await readFileDbStamp(file.id, sha)).toMatchObject({ pipeline_id: 'access' });
  });

  it('an .accdb encrypted with a password: no tab, the text says it is locked', async () => {
    const file = await upload(`${randomUUID().slice(0, 8)}.accdb`, fixture('encrypted.accdb'));
    const got = await extract(file.id);
    expect(jobs).toEqual(['access']);
    expect(got.ok && got.rawBody).toContain('protected by a password');
    const sha = await shaOf(file.id);
    expect(await f.fileDbSqlitePath(file.id, sha)).toBeNull();
    expect(await f.readFileDbNone(file.id, sha)).toBe('no-rows');
  });
});
