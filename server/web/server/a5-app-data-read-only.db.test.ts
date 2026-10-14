/**
 * The app data reads on a read-only MCP connection, with the actor check
 * and the edit check on (workspaces arch A5 step 4 must-do; docs/actors.md).
 *
 * Since step 4 the owner MCP surface runs a read tool read only (the gate's
 * callActor: login(ro); system work it starts stays read only, systemUnder),
 * and the database refuses a read-only actor's change of an item table
 * (0280's mantle_edit_check_ro). app_data_schema and app_data_query make an
 * app's registry row in app_databases (an item table) the first time a
 * login reads the app. That provisioning is a named read-path write
 * (READ_PATH_WRITES 'repair:app-db'), so on a real database:
 *
 *  - a member's read-only OAuth connection reads an app nobody used yet,
 *    and its registry row is made;
 *  - the same provisioning without the name, as a read-only login, is
 *    refused (ro_actor): the name is what lets it through.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a5-app-data-read-only.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Reply = { isError?: boolean; content?: { text?: string }[] };
const text = (r: unknown) =>
  ((r as Reply | null)?.content ?? []).map((p) => p.text ?? '').join(' ');

describe.skipIf(!URL)('the app data reads on a read-only MCP connection (A5 step 4)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ls: typeof import('@mantle/mcp-core');
  let broker: typeof import('@mantle/content/app-broker');
  let dir = '';
  const tag = `adro${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const member = randomUUID();
  let ws = '';
  const apps = { read: '', control: '' };
  const schema = {
    schemaSql: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT);',
    schemaVersion: 1,
  };
  const suiteMode = process.env.MANTLE_ACTOR_CHECK;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const registered = async (app: string) =>
    (
      await x<{ n: number }>(
        sql`select count(*)::int as n from app_databases where app_node_id = ${app}`,
      )
    )[0]!.n;

  /** A published app with MCP access on, homed in the member's workspace,
   *  that nobody used yet: it has no app_databases row. */
  const app = async (key: string): Promise<string> => {
    const id = randomUUID();
    const build = JSON.stringify({
      storageKey: 'attachments/aa/bb/test',
      sha256: 'test',
      builtAt: '2026-10-14T00:00:00.000Z',
      esbuildVersion: 'test',
      bytes: 1,
      ok: true,
    });
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${id}, ${owner}, 'app', ${`${tag} ${key}`}, 'apps')`);
    await x(sql`insert into apps (node_id, manifest, published_build, mcp_access)
      values (${id}, ${JSON.stringify({ sqlite: schema })}::jsonb, ${build}::jsonb, true)`);
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${id}, ${ws}, false, true)`);
    });
    return id;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a5-app-data-ro-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_ADMIN_READS;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline', { status: 503 })),
    );
    m = await import('@mantle/db');
    ls = await import('@mantle/mcp-core');
    broker = await import('@mantle/content/app-broker');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const [row] = await x<{ id: string }>(sql`
      insert into workspaces (owner_id, name) values (${owner}, ${`${tag} Shop`}) returning id::text`);
    ws = row!.id;
    // A plain user of the workspace: no Moderator, no private workspace.
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws}, ${member}, false)
      on conflict (workspace_id, login_id) do update set moderator = false`);
    apps.read = await app('read');
    apps.control = await app('control');
    // The box's checks on, as an operator switches them (the box mode is
    // read from the catalog per statement), and this process's actor check.
    process.env.MANTLE_ACTOR_CHECK = 'on';
    await x(sql`select mantle_set_actor_check('on')`);
    await x(sql`select mantle_set_edit_check('on')`);
  }, 240_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a read-only OAuth connection reads an app nobody used yet; its registry row is made', async () => {
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const prepared = await ls.prepareCallerTools({
      role: 'member',
      anchorId: owner,
      loginId: member,
      via: 'oauth',
      write: false,
    });
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(server, prepared);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 'a5-app-data-ro', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    try {
      expect(await registered(apps.read)).toBe(0);
      const listed = (await c.listTools()).tools.map((t) => t.name);
      expect(listed).toEqual(expect.arrayContaining(['app_data_schema', 'app_data_query']));
      const s = (await c.callTool({
        name: 'app_data_schema',
        arguments: { app_id: apps.read },
      })) as Reply;
      expect(s.isError ?? false, text(s)).toBe(false);
      expect(text(s)).toContain('"items"');
      expect(await registered(apps.read)).toBe(1);
      const q = (await c.callTool({
        name: 'app_data_query',
        arguments: { app_id: apps.read, sql: 'select count(*) as n from items' },
      })) as Reply;
      expect(q.isError ?? false, text(q)).toBe(false);
      expect(text(q)).toContain('"row_count": 1');
    } finally {
      await c.close();
    }
    expect(m.takeActorMisses()).toEqual([]);
  });

  it('the same provisioning without the name, as a read-only login, is refused', async () => {
    const scope = { kind: 'user' as const, loginId: member, ws: [ws], modWs: [] };
    const run = () =>
      m.runAsActor(m.loginActor(member, 'ro'), () =>
        m.withTurnScope(scope, () =>
          m.asSystem(
            () => broker.appDbTableDetails(owner, apps.control, { callerKey: member, schema }),
            'app-data',
          ),
        ),
      );
    const err = (await run().then(
      () => null,
      (e: unknown) => e,
    )) as { code?: string; cause?: { code?: string; detail?: string } } | null;
    expect(err, 'the unnamed provisioning ran').not.toBeNull();
    expect({ code: err!.cause?.code ?? err!.code, detail: err!.cause?.detail }).toEqual({
      code: '42501',
      detail: 'ro_actor',
    });
    expect(await registered(apps.control)).toBe(0);
    m.takeActorMisses();
  });
});
