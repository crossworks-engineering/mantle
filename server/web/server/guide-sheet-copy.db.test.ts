/**
 * The snippet of docs/app-authoring-guide.md, "Copying a sheet into an app", run
 * as it stands in the guide: read from the doc, its SQL declared by the app's
 * author, its loop run as a member of a workspace that holds the app with Write,
 * with `host` over the real tool and database brokers (POST /api/apps/:id/
 * tool-broker and db-broker, through the full pipeline, as the iframe's host page
 * calls them), a real file database and a real app SQLite.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/guide-sheet-copy.db.test.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordAppAccess: vi.fn(),
  recordAppError: vi.fn(),
}));

type Host = {
  tools: { call: (slug: string, input: unknown) => Promise<unknown> };
  db: {
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
    exec: (sql: string, params?: unknown[]) => Promise<unknown>;
  };
};
type CopyTab = (
  fileId: string,
  view: string,
  from: string[],
  into: { table: string; columns: string[] },
) => Promise<number>;

describe.skipIf(!URL)('the guide: copying a sheet into an app', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let files: typeof import('@mantle/files');
  let build: typeof import('@mantle/content/file-database').buildFileDatabase;
  let runRoute: typeof import('./run-route').runRoute;
  let dir = '';
  let snippet: { copyTab: (host: Host) => CopyTab; ddl: string[] };
  const tag = `gsc${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const member = randomUUID();
  const app = randomUUID();
  let adminWs = '';
  let team = '';
  let folder = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const sys = <R>(fn: () => Promise<R>) => m.asSystem(fn, 'test');

  /** What the app's bridge does with a broker's answer (app-build kit.ts post). */
  const bridge = async (who: string, route: string, body: unknown) => {
    const res = await runRoute(who, 'POST', `/api/apps/${app}/${route}`, body);
    const out = (await res.json()) as { ok?: boolean; output?: unknown; error?: string };
    if (!out.ok) throw new Error(out.error ?? `broker answered ${res.status}`);
    return out.output;
  };
  const log = { sql: [] as string[], params: [] as number[], replies: [] as number[] };
  const hostOf = (who: string, opts: { failExecAt?: number } = {}): Host => {
    let execs = 0;
    return {
      tools: {
        call: async (slug, input) => {
          const out = await bridge(who, 'tool-broker', { slug, input });
          const i = input as { sql?: string };
          if (slug === 'file_sql' && i.sql) {
            log.sql.push(i.sql);
            log.replies.push((out as { rows: unknown[] }).rows.length);
          }
          return out;
        },
      },
      db: {
        query: async (s, params = []) =>
          (await bridge(who, 'db-broker', { op: 'query', sql: s, params })) as unknown[],
        exec: async (s, params = []) => {
          execs += 1;
          if (execs === opts.failExecAt) throw new Error('the window was closed');
          log.params.push(params.length);
          return bridge(who, 'db-broker', { op: 'exec', sql: s, params });
        },
      },
    };
  };
  const ownerExec = (s: string) => bridge(owner, 'db-broker', { op: 'exec', sql: s, params: [] });
  const appRows = async <T>(s: string) =>
    (await bridge(owner, 'db-broker', { op: 'query', sql: s, params: [] })) as T[];

  /** Two tabs, with a text value late in the size column. */
  const sheets = (n: number) => [
    {
      name: 'Lines',
      columns: [
        { name: 'Tag', type: 'text' as const },
        { name: 'Size', type: 'text' as const },
      ],
      rows: Array.from({ length: n }, (_, i) => [`V-${i + 1}`, i === 1500 ? 'N/A' : String(i + 1)]),
    },
    {
      name: 'Valves',
      columns: [{ name: 'Valve', type: 'text' as const }],
      rows: [['A'], ['B']],
    },
  ];
  const newFile = async (name: string, rows: number) => {
    const bytes = Buffer.from(`${name} ${rows}`);
    return sys(async () => {
      const file = await m.withCreateHome({ createWs: team, privateWs: null, quiet: true }, () =>
        files.upsertFile({ ownerId: owner, parentPath: folder, filename: name, bytes }),
      );
      await buildFor(file.id, name, bytes, rows);
      return file.id;
    });
  };
  const buildFor = async (id: string, name: string, bytes: Buffer, rows: number) => {
    const out = await build({
      fileId: id,
      ownerId: owner,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
      filename: name,
      parsed: { kind: 'sheets', sheets: sheets(rows) },
    });
    expect(out).toMatchObject({ status: 'built' });
  };
  const LINES = ['Tag', 'Size'];
  const INTO = { table: 'lines', columns: ['tag', 'size'] };

  beforeAll(async () => {
    const tss: Ts = await import('@mantle/db/test-support');
    scratch = await tss.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'guide-copy-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'guide-sheet-copy-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    m.openLoginWritePool({ max: 2 });
    t = await import('@mantle/tools');
    files = await import('@mantle/files');
    build = (await import('@mantle/content/file-database')).buildFileDatabase;
    runRoute = (await import('./run-route')).runRoute;

    const guide = await readFile(
      path.join(import.meta.dirname, '../../../docs/app-authoring-guide.md'),
      'utf8',
    );
    const from = guide.indexOf('\n## Copying a sheet into an app\n');
    const section = guide.slice(from, guide.indexOf('\n## ', from + 5));
    const fence = (lang: string) => {
      const found = new RegExp('```' + lang + '\\n([\\s\\S]*?)```').exec(section);
      if (!found) throw new Error(`the section has no ${lang} block`);
      return found[1]!;
    };
    const js = ts.transpileModule(fence('ts').replace(/^import .*$/m, ''), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    snippet = {
      copyTab: (host) => new Function('host', `${js}\nreturn copyTab;`)(host) as CopyTab,
      ddl: fence('sql')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
    };

    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await tss.runWorkspacesSwitch();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${member}, ${`${tag}-u@example.invalid`}, 'x', false, 'member', 'Member')`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    team = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Team`}) returning id::text`)
    )[0]!.id;
    await su(sql`delete from workspace_users where login_id = ${member}`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${team}, ${member}, false)`);
    await sys(() => t.seedBuiltinTools(owner));
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled)
      values (${owner}, ${`${tag}-reads`}, 'Reads', '{file_sql,file_get}'::text[], 'team', true)`);
    await sys(async () => {
      await files.ensureFilesRootBranch(owner);
      const f = await m.withCreateHome({ createWs: team, privateWs: null, quiet: true }, () =>
        files.createFolder({ ownerId: owner, parentPath: 'files', slug: `${tag}-copy` }),
      );
      folder = f.path;
    });
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${app}, ${owner}, 'app', ${`${tag} app`}, 'apps')`);
    const green = JSON.stringify({ ok: true, storageKey: `apps/${tag}.js`, builtAt: '2026-11-05' });
    await x(sql`insert into apps (node_id, manifest, published_build)
      values (${app}, ${JSON.stringify({ toolSlugs: ['file_sql', 'file_get'] })}::jsonb, ${green}::jsonb)`);
    await m.withHeads([app], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${app}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home) values
        (${app}, ${adminWs}, true, true), (${app}, ${team}, true, false)`);
    });
    // The author declares the tables.
    for (const ddl of snippet.ddl) await ownerExec(ddl);
    await ownerExec('create table if not exists valves (_rid text primary key, valve text)');
  }, 300_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a member copies a tab of 2,345 rows, within every limit, and no value is lost', async () => {
    const file = await newFile(`${tag}-lines.csv`, 2_345);
    const started = Date.now();
    const copied = await snippet.copyTab(hostOf(member))(file, 'Lines', LINES, INTO);
    console.log(`the guide's loop: 2,345 rows in ${Date.now() - started} ms`);
    expect(copied).toBe(2_345);
    expect(await appRows('select count(*) as n from lines')).toEqual([{ n: 2_345 }]);
    expect(await appRows("select tag, size from lines where tag = 'V-1501'")).toEqual([
      { tag: 'V-1501', size: 'N/A' },
    ]);
    expect(Math.max(...log.params)).toBeLessThanOrEqual(999);
    expect(Math.max(...log.replies)).toBeLessThanOrEqual(1000);
    const [progress] = await appRows<{ last_pos: number; done: number; sha256: string }>(
      "select last_pos, done, sha256 from import_progress where tab = 'Lines'",
    );
    expect(progress).toMatchObject({ last_pos: 2_345, done: 1 });
    expect(progress!.sha256).toMatch(/^[0-9a-f]{64}$/);

    // A second call with the same bytes pages nothing.
    log.sql = [];
    expect(await snippet.copyTab(hostOf(member))(file, 'Lines', LINES, INTO)).toBe(2_345);
    expect(log.sql.filter((s) => s.includes('"_pos" >'))).toEqual([]);
  }, 120_000);

  it('a reload goes on from the progress row, with no row twice', async () => {
    await ownerExec('delete from lines');
    await ownerExec('delete from import_progress');
    const file = await newFile(`${tag}-reload.csv`, 2_100);
    // Past the first page, which is 12 statements and a progress row.
    await expect(
      snippet.copyTab(hostOf(member, { failExecAt: 16 }))(file, 'Lines', LINES, INTO),
    ).rejects.toThrow('the window was closed');
    const [mid] = await appRows<{ last_pos: number; done: number }>(
      "select last_pos, done from import_progress where tab = 'Lines'",
    );
    expect(mid).toMatchObject({ last_pos: 1000, done: 0 });

    log.sql = [];
    expect(await snippet.copyTab(hostOf(member))(file, 'Lines', LINES, INTO)).toBe(2_100);
    expect(log.sql.find((s) => s.includes('"_pos" >'))).toContain('"_pos" > 1000');
    expect(await appRows('select count(*) as n, count(distinct _rid) as d from lines')).toEqual([
      { n: 2_100, d: 2_100 },
    ]);
  }, 120_000);

  it('new bytes under the same id start the copy again', async () => {
    const name = `${tag}-replace.csv`;
    const file = await newFile(name, 40);
    await ownerExec('delete from lines');
    await ownerExec('delete from import_progress');
    expect(await snippet.copyTab(hostOf(member))(file, 'Lines', LINES, INTO)).toBe(40);
    const bytes = Buffer.from(`${name} newer`);
    await sys(async () => {
      const again = await m.withCreateHome({ createWs: team, privateWs: null, quiet: true }, () =>
        files.upsertFile({ ownerId: owner, parentPath: folder, filename: name, bytes }),
      );
      expect(again.id).toBe(file);
      await buildFor(file, name, bytes, 60);
    });
    expect(await snippet.copyTab(hostOf(member))(file, 'Lines', LINES, INTO)).toBe(60);
    expect(await appRows('select count(*) as n from lines')).toEqual([{ n: 60 }]);
  }, 120_000);

  it('the count check says so when the rows do not match', async () => {
    await ownerExec('delete from lines');
    await ownerExec('delete from import_progress');
    await ownerExec("insert into lines (_rid, tag) values ('own', 'an extra row')");
    const file = await newFile(`${tag}-count.csv`, 5);
    await expect(snippet.copyTab(hostOf(member))(file, 'Lines', LINES, INTO)).rejects.toThrow(
      'Copied 6 of 5 rows',
    );
    const [row] = await appRows<{ done: number }>(
      "select done from import_progress where tab = 'Lines'",
    );
    expect(row!.done).toBe(0);
  }, 120_000);

  it('waits out a budget and goes on: a refused call never ran', async () => {
    await ownerExec('delete from valves');
    await ownerExec("delete from import_progress where tab = 'Valves'");
    const file = await newFile(`${tag}-paced.csv`, 3);
    const real = hostOf(member);
    let refused = 0;
    const host: Host = {
      ...real,
      tools: {
        call: async (slug, input) => {
          if (refused === 0) {
            refused += 1;
            throw new Error('Too many requests: this app made more than 120 tool calls');
          }
          return real.tools.call(slug, input);
        },
      },
    };
    const copied = await snippet.copyTab(host)(file, 'Valves', ['Valve'], {
      table: 'valves',
      columns: ['valve'],
    });
    expect(copied).toBe(2);
    expect(refused).toBe(1);
  }, 120_000);
});
