/**
 * The `pipeline-reread` task on a real migrated Postgres and a real files root.
 * CSV files are read in this process, so a run needs no parser: every fetch is
 * counted, and a run over them must make none. That is the proof of "no model
 * call": a model is only reached over the network. The proof of "no extract
 * job": an extract starts from a `node_ingested` notice, and a listener on it
 * hears none during a run; the file's row (its summary, its data) and its
 * passages are the same after the run as before.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/lib/maintenance/pipeline-reread.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  /** The arguments of every buildFileDatabase call the task makes. */
  builds: [] as Record<string, unknown>[],
}));

vi.mock('@mantle/content/file-database', async (orig) => {
  const actual = await orig<typeof import('@mantle/content/file-database')>();
  return {
    ...actual,
    buildFileDatabase: (args: Parameters<typeof actual.buildFileDatabase>[0]) => {
      h.builds.push({ ...args });
      return actual.buildFileDatabase(args);
    },
  };
});

const STAMP_KEYS = ['pipeline_id', 'pipeline_version', 'pipeline_api', 'shapes'];

describe.skipIf(!URL)('pipeline-reread', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let f: typeof import('@mantle/files');
  let fd: typeof import('@mantle/content/file-database');
  let r: typeof import('./pipeline-reread');
  let sqlTag: typeof import('drizzle-orm').sql;
  let scratch: { url: string; drop: () => Promise<void> } | undefined;
  let listener: ReturnType<typeof postgres> | undefined;
  let anchor: string;
  const team = randomUUID();
  const FOLDER = 'files.reread';
  const root = mkdtempSync(path.join(tmpdir(), 'mantle-reread-'));
  const fetches: string[] = [];
  const heard: string[] = [];

  const su = async (q: ReturnType<typeof sqlTag>) =>
    (await import('@mantle/db/test-support')).superuserExec(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sqlTag>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const unique = (ext: string) => `${randomUUID().slice(0, 8)}.${ext}`;
  const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

  const upload = (name: string, bytes: string) =>
    m.withCreateHome({ createWs: team, privateWs: null }, () =>
      f.upsertFile({
        ownerId: anchor,
        parentPath: FOLDER,
        filename: name,
        bytes: Buffer.from(bytes),
      }),
    );
  /** A CSV file with a database, built as an extract builds it (stamped). */
  const built = async (bytes: string) => {
    const file = await upload(unique('csv'), bytes);
    const out = await fd.buildFileDatabase({
      fileId: file.id,
      ownerId: anchor,
      sha256: sha256(bytes),
      bytes: Buffer.from(bytes),
      filename: file.filename,
    });
    expect(out.status).toBe('built');
    return { id: file.id, sha: sha256(bytes) };
  };
  const dbPath = (file: { id: string; sha: string }) => f.fileDbPaths(file.id, file.sha)!.sqlite;
  /** Write the database's `_meta` by hand: a stamp from an older build. */
  const editMeta = (file: { id: string; sha: string }, sqlText: string) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(dbPath(file));
    db.exec(sqlText);
    db.close();
  };
  const unstamped = async (bytes: string) => {
    const file = await built(bytes);
    editMeta(file, `DELETE FROM _meta WHERE k IN (${STAMP_KEYS.map((k) => `'${k}'`).join(', ')})`);
    expect(await fd.readFileDbStamp(file.id, file.sha)).toBeNull();
    return file;
  };
  const stampOf = (file: { id: string; sha: string }) => fd.readFileDbStamp(file.id, file.sha);
  /** A run of the task, as its script runs it. */
  const run = async (...argv: string[]) => {
    const lines: string[] = [];
    h.builds.length = 0;
    const code = await r.runPipelineReread(argv, (line) => lines.push(line));
    // A notice a run sent arrives after the run: give it the time.
    await new Promise((ok) => setTimeout(ok, 300));
    return { code, lines, text: lines.join('\n') };
  };
  const scoped = (...files: { id: string }[]) => `--file=${files.map((x) => x.id).join(',')}`;
  /** The file's row and its passages, as text: what an extract would change. */
  const indexOf = async (id: string) => {
    const [row] = await x<{ row: string; passages: number }>(sqlTag`
      select to_jsonb(n)::text as row,
        (select count(*)::int from content_chunks c where c.node_id = n.id) as passages
      from nodes n where n.id = ${id}`);
    return row;
  };

  beforeAll(async () => {
    scratch = await (await import('@mantle/db/test-support')).createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(root, 'tables');
    process.env.MANTLE_FILES_ROOT = path.join(root, 'files');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    mkdirSync(process.env.MANTLE_FILES_ROOT, { recursive: true });
    m = await import('@mantle/db');
    f = await import('@mantle/files');
    fd = await import('@mantle/content/file-database');
    sqlTag = (await import('drizzle-orm')).sql;
    r = await import('./pipeline-reread');
    const admin = (m.systemDb as unknown as { $client: Parameters<Db['ensureViewerRoles']>[0] })
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
    listener = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await listener.listen('node_ingested', (id) => heard.push(id));
  }, 180_000);

  afterAll(async () => {
    await listener?.end();
    await m?.closeDb();
    await scratch?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    fetches.length = 0;
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        fetches.push(String(url));
        return Response.json({ ok: false, error: { code: 'unavailable' } }, { status: 503 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('needs a pipeline by id', async () => {
    expect((await run()).code).toBe(2);
    const bad = await run('--pipeline=nope', '--apply');
    expect(bad.code).toBe(2);
    expect(bad.text).toContain('one of: sheet');
    expect((await run('--pipeline=sheet', '--file=not-an-id')).code).toBe(2);
  });

  it('a dry run lists the unstamped file and writes nothing', async () => {
    const file = await unstamped('tag,size\nP-101,50\n');
    const before = statSync(dbPath(file)).mtimeMs;
    const { code, text } = await run('--pipeline=sheet', scoped(file));
    expect(code).toBe(0);
    expect(text).toContain(`${file.id}: would read`);
    expect(text).toContain('DRY RUN: 1 to read');
    expect(h.builds).toEqual([]);
    expect(statSync(dbPath(file)).mtimeMs).toBe(before);
    expect(await stampOf(file)).toBeNull();
  });

  it('--apply stamps a file that had no stamp, with no model call and no extract job', async () => {
    const file = await unstamped('tag,size\nP-201,80\n');
    await x(sqlTag`update nodes set data = data || '{"summary":"kept as it was"}'::jsonb
      where id = ${file.id}`);
    const index = await indexOf(file.id);
    // The control: the listener hears a notice when one is sent.
    const control = randomUUID();
    await x(sqlTag`select pg_notify('node_ingested', ${control}::text)`);
    await vi.waitFor(() => expect(heard).toContain(control));
    heard.length = 0;
    const { code, text } = await run('--pipeline=sheet', scoped(file), '--apply');
    expect(code).toBe(0);
    expect(text).toContain(`${file.id}: built (1 tabs, 1 rows)`);
    const csv = f.builtinForExt('csv')!;
    expect(await stampOf(file)).toEqual({
      pipeline_id: csv.id,
      pipeline_version: csv.version,
      pipeline_api: String(csv.api),
      shapes: '',
    });
    // No parse result and no decider went in: the read asks no model.
    expect(h.builds).toHaveLength(1);
    expect(Object.keys(h.builds[0]!).sort()).toEqual([
      'bytes',
      'fileId',
      'filename',
      'ownerId',
      'sha256',
    ]);
    expect(fetches).toEqual([]);
    expect(heard).toEqual([]);
    expect(await indexOf(file.id)).toEqual(index);
  });

  it('takes a lower version, and leaves a file at the current one', async () => {
    const older = await built('tag,size\nP-301,10\n');
    editMeta(older, `UPDATE _meta SET v = '0.9.0' WHERE k = 'pipeline_version'`);
    const current = await built('tag,size\nP-302,20\n');
    const before = statSync(dbPath(current)).mtimeMs;
    const { text } = await run('--pipeline=sheet', scoped(older, current), '--apply');
    expect(text).toContain(`${older.id}: built`);
    expect(text).toContain('1 current');
    expect(text).not.toContain(`${current.id}: reading`);
    expect((await stampOf(older))?.pipeline_version).toBe(f.builtinForExt('csv')!.version);
    expect(statSync(dbPath(current)).mtimeMs).toBe(before);
    expect(h.builds).toHaveLength(1);
  });

  it('a file with no database is counted and left; another pipeline is not a candidate', async () => {
    const bare = await upload(unique('csv'), 'tag,size\nP-401,1\n');
    const plan = await upload(unique('xml'), '<Project></Project>');
    const { text } = await run('--pipeline=sheet', `--file=${bare.id},${plan.id}`, '--apply');
    expect(text).toContain('1 no database');
    expect(text).toContain(`${plan.id}: skipped: not-a-candidate`);
    expect(h.builds).toEqual([]);
    expect(await f.fileDbSqlitePath(bare.id, sha256('tag,size\nP-401,1\n'))).toBeNull();
  });

  it('the cap holds, and --after goes on', async () => {
    const files = [
      await unstamped('tag,size\nP-501,1\n'),
      await unstamped('tag,size\nP-502,2\n'),
      await unstamped('tag,size\nP-503,3\n'),
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    const first = await run('--pipeline=sheet', scoped(...files), '--limit=2', '--apply');
    expect(first.text).toContain(`cut at --limit=2; go on with --after=${files[1]!.id}`);
    expect(h.builds).toHaveLength(2);
    expect(await stampOf(files[0]!)).not.toBeNull();
    expect(await stampOf(files[1]!)).not.toBeNull();
    expect(await stampOf(files[2]!)).toBeNull();

    // The dry run is capped the same way.
    const dry = await run('--pipeline=sheet', scoped(...files), '--limit=1');
    expect(dry.text).toContain('2 current');
    expect(dry.text).toContain(`${files[2]!.id}: would read`);

    const next = await run(
      '--pipeline=sheet',
      scoped(...files),
      `--after=${files[1]!.id}`,
      '--apply',
    );
    expect(next.text).toContain(`${files[2]!.id}: built`);
    expect(await stampOf(files[2]!)).not.toBeNull();
  });

  it('drawing-pdf: a dry run lists the PDF, and --apply is refused before any read', async () => {
    const bytes = '%PDF-1.7 a made-up drawing';
    const pdf = await upload(unique('pdf'), bytes);
    const file = { id: pdf.id, sha: sha256(bytes) };
    const { writeDocFile } = await import('@mantle/tabledb/write');
    mkdirSync(f.fileDbsDir(), { recursive: true });
    writeDocFile(
      dbPath(file),
      {
        columns: [{ id: 'c1', name: 'Kind', type: 'text' }],
        rows: [{ id: 'r1', cells: { c1: 'pid' } }],
      },
      { nodeId: file.id, ownerId: anchor, extraMeta: { description: 'Built before stamps.' } },
    );
    const before = statSync(dbPath(file)).mtimeMs;
    const dry = await run('--pipeline=drawing-pdf', scoped(file));
    expect(dry.code).toBe(0);
    expect(dry.text).toContain(`${file.id}: would read`);
    const apply = await run('--pipeline=drawing-pdf', scoped(file), '--apply');
    expect(apply.code).toBe(2);
    expect(apply.text).toContain('takes a dry run only');
    expect(h.builds).toEqual([]);
    expect(fetches).toEqual([]);
    expect(statSync(dbPath(file)).mtimeMs).toBe(before);
  });

  it('prints no file name and no cell', async () => {
    const name = unique('csv');
    const bytes = 'tag,size\nSECRET-CELL,9\n';
    const file = await upload(name, bytes);
    await fd.buildFileDatabase({
      fileId: file.id,
      ownerId: anchor,
      sha256: sha256(bytes),
      bytes: Buffer.from(bytes),
      filename: name,
    });
    editMeta({ id: file.id, sha: sha256(bytes) }, `DELETE FROM _meta WHERE k = 'pipeline_id'`);
    const { text } = await run('--pipeline=sheet', scoped(file), '--apply');
    expect(text).toContain('built');
    for (const word of ['SECRET-CELL', name]) expect(text).not.toContain(word);
  });
});
