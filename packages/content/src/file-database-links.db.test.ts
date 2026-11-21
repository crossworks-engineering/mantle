/**
 * The links Transformer on a real migrated Postgres and a real files root,
 * through the chain an upload takes (buildFileDatabase, then the `after`
 * pipelines), on a made-up piping specification book
 * (@mantle/files/pipelines/links-fixture):
 *  - the build adds the tabs Links and Link nodes and the entry
 *    `links@<version>` in `pipelines_after`; the Reader's tabs are the same
 *    as in a workspace where Links is switched off;
 *  - three link questions answered with plain SQL through the read-only
 *    runner file_sql uses (runTableSql), and a two-hop join;
 *  - a run again (patchFileDatabase) gives the same rows, and the Reader's
 *    tabs stay as they were.
 * The parser is faked at the fetch: each pipelineRun job runs the real step
 * in this process (pipelineRunAnswer); any other fetch fails, so no model
 * is asked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/content/src/file-database-links.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import { pipelineRunAnswer } from '@mantle/files/pipelines/test-job';
import { specSheets } from '@mantle/files/pipelines/links-fixture';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('links through the after chain', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let f: typeof import('@mantle/files');
  let fd: typeof import('./file-database');
  let ps: typeof import('./pipeline-state');
  let t: typeof import('@mantle/tabledb');
  let sqlTag: typeof import('drizzle-orm').sql;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let anchor: string;
  /** A workspace Links runs in, and one it is switched off in. */
  const on = randomUUID();
  const off = randomUUID();
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-links-'));
  const runs: string[] = [];
  const READER_TABS = ['Pages', 'Tables', 'File', ...specSheets().slice(3).map((s) => s.name)];

  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sqlTag>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const folderOf = (ws: string) => `files.links_${ws.slice(0, 8)}`;
  const links = () => f.BUILTIN_PIPELINES.find((p) => p.id === 'links')!;

  /** Upload a made-up PDF in `ws` and build its database from the spec's
   *  tabs, as an extract does after the book reader. */
  const built = async (ws: string) => {
    const bytes = Buffer.from(`%PDF-1.7 a made-up piping specification ${randomUUID()}`);
    const file = await m.withCreateHome({ createWs: ws, privateWs: null }, () =>
      f.upsertFile({
        ownerId: anchor,
        parentPath: folderOf(ws),
        filename: `${randomUUID().slice(0, 8)}.pdf`,
        bytes,
      }),
    );
    const out = await fd.buildFileDatabase({
      fileId: file.id,
      ownerId: anchor,
      sha256: sha256(bytes),
      bytes,
      filename: file.filename,
      parsed: { kind: 'sheets', sheets: specSheets() },
    });
    expect(out.status).toBe('built');
    return { id: file.id, sha: sha256(bytes), abs: f.fileDbPaths(file.id, sha256(bytes))!.sqlite };
  };
  const tabNames = (abs: string) => t.describeWorkbook(abs).map((tab) => tab.name);
  /** The rows of some tabs by display value. */
  const valuesOf = (abs: string, names: readonly string[]) =>
    Object.fromEntries(
      t
        .describeWorkbook(abs)
        .filter((tab) => names.includes(tab.name))
        .map((tab) => [
          tab.name,
          t.readTabColumns(abs, [{ tab: tab.name, columns: tab.columns.map((c) => c.name) }])[0],
        ]),
    );
  const meta = (abs: string, k: string) => t.readDocMeta(abs, [k])?.[k];
  const sql = async (abs: string, q: string) => (await t.runTableSql(abs, q)).rows;

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
    t = await import('@mantle/tabledb');
    sqlTag = (await import('drizzle-orm')).sql;
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
      .$client;
    anchor = await ensureTestAnchor(admin);
    for (const ws of [on, off]) {
      await su(sqlTag`insert into workspaces (id, owner_id, name)
        values (${ws}, ${anchor}, ${`made-up ${ws.slice(0, 8)}`})`);
    }
    await su(sqlTag`insert into workspaces (owner_id, name, is_admin)
      select ${anchor}::uuid, 'Admin', true where mantle_ws_admin_id(${anchor}::uuid) is null`);
    await x(sqlTag`insert into nodes (owner_id, type, title, slug, path)
      values (${anchor}, 'branch', 'files', 'files', 'files') on conflict do nothing`);
    for (const ws of [on, off]) {
      const folder = folderOf(ws);
      await m.withCreateHome({ createWs: ws, privateWs: null }, () =>
        m.withNodeInsertHeads(anchor, [{ type: 'branch', path: folder }], (tx) =>
          tx.execute(sqlTag`insert into nodes (id, owner_id, type, title, path)
            values (${randomUUID()}, ${anchor}, 'branch', ${folder}, ${folder}::ltree)`),
        ),
      );
    }
    expect((await ps.setPipelineState(anchor, null, links(), { offIn: [off] })).ok).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    runs.length = 0;
    f?.resetParserFailures();
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        if (!String(url).includes('/pipeline/run')) {
          return Response.json({ ok: false, error: { code: 'unavailable' } }, { status: 503 });
        }
        const length = Number(new Headers(init?.headers).get('x-parser-opts-length'));
        const sent = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
        runs.push((JSON.parse(sent.subarray(0, length).toString('utf8')) as { id: string }).id);
        return pipelineRunAnswer({ ...init, body: sent });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('a build adds Links and Link nodes, and leaves the Reader tabs as they are', async () => {
    const yes = await built(on);
    expect(runs).toEqual(['links']);
    runs.length = 0;
    const no = await built(off);
    expect(runs).toEqual([]);
    expect(tabNames(yes.abs)).toEqual([...tabNames(no.abs), 'Links', 'Link nodes']);
    expect(String(meta(yes.abs, 'pipelines_after'))).toBe(`links@${links().version}`);
    expect(meta(no.abs, 'pipelines_after')).toBeUndefined();
    expect(valuesOf(yes.abs, READER_TABS)).toEqual(valuesOf(no.abs, READER_TABS));
  });

  it('three link questions in plain SQL through the read-only runner, and two hops', async () => {
    const file = await built(on);
    // The classes that list a code on their own sheets: an addendum only
    // changes a class, so its page gives no CLASS_CODE.
    expect(
      await sql(
        file.abs,
        `SELECT DISTINCT from_id FROM Links WHERE kind = 'CLASS_CODE' AND to_id = 'code:ZX10001'`,
      ),
    ).toEqual([['class:K2']]);
    // The pages a code is on, from rows and from page text alike.
    expect(
      await sql(
        file.abs,
        `SELECT DISTINCT CAST(page AS INTEGER) FROM Links
          WHERE kind = 'NAMES_CODE' AND to_id = 'code:ZX10001' ORDER BY 1`,
      ),
    ).toEqual([[2], [3], [8]]);
    // The classes that call for a grade, the one in text with no spaces.
    expect(
      await sql(
        file.abs,
        `SELECT DISTINCT n.label FROM Links l JOIN "Link nodes" n ON n.id = l.from_id
          WHERE l.kind = 'CLASS_MATERIAL' AND l.to_id = 'mat:A193-B7M'`,
      ),
    ).toEqual([['Q3X']]);
    // Two hops: the rating of the class of page 5.
    expect(
      await sql(
        file.abs,
        `SELECT r.to_id FROM Links c JOIN Links r ON r.from_id = c.from_id AND r.kind = 'HAS_RATING'
          WHERE c.kind = 'CLASS_PAGE' AND c.to_id = 'page:5'`,
      ),
    ).toEqual([['rating:600']]);
    // The coverage lines a reader of the file can ask for.
    const coverage = await sql(file.abs, `SELECT id FROM "Link nodes" WHERE kind = 'coverage'`);
    expect(coverage.map((r) => r[0])).toEqual(
      expect.arrayContaining(['coverage:links', 'coverage:pages-no-text', 'coverage:pack:piping-spec']),
    );
  });

  it('a run again gives the same rows, and the Reader tabs stay', async () => {
    const file = await built(on);
    const before = valuesOf(file.abs, [...READER_TABS, 'Links', 'Link nodes']);
    const out = await fd.patchFileDatabase({
      fileId: file.id,
      ownerId: anchor,
      sha256: file.sha,
      pipeline: links(),
    });
    expect(out).toMatchObject({ status: 'patched', tabs: 2 });
    expect(valuesOf(file.abs, [...READER_TABS, 'Links', 'Link nodes'])).toEqual(before);
    expect(tabNames(file.abs).filter((n) => n === 'Links')).toHaveLength(1);
  });
});
