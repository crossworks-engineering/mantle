/**
 * App data over a login's own MCP (team apps Phase 1, plan page b6dd688e) on
 * a real, migrated Postgres and real SQLite files:
 *
 *  - reach: only apps with MCP access on, published, at the login's level,
 *    of this brain; never admin level, a draft, or MCP access off;
 *  - read or write: the Write switch and the browser's rule (Informational,
 *    a public app, the client level);
 *  - query: read-only, `:host_me_*` filled for the caller;
 *  - write: rows only (no DDL), an hourly `pre_mcp_write` snapshot first,
 *    the SQL and the changes in the access log;
 *  - none of it off a login's own MCP connection.
 *
 * The lookups run on the admin pool here: the rule is in the query (as the
 * member-apps tests prove theirs). Row security on the team role is keyed on
 * the box's one brain, which this test's brain is not; the team-role case
 * only proves the lookup's columns are granted.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-app-data.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginMcpChannel, ToolHandlerContext } from './types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('app data over a login MCP', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let admin: Parameters<Db['ensureViewerRoles']>[0];
  let content: typeof import('@mantle/content');
  let broker: typeof import('@mantle/content/app-broker');
  let tools: typeof import('./builtins-app-data');
  let dir = '';
  const anchor = randomUUID();
  const other = randomUUID();
  const member = randomUUID();
  const client = randomUUID();
  const tag = anchor.slice(0, 8);
  const ids: Record<string, string> = {};
  const GREEN = {
    storageKey: 'attachments/aa/bb/test',
    sha256: 'test',
    builtAt: '2026-10-08T00:00:00.000Z',
    esbuildVersion: 'test',
    bytes: 1,
    ok: true,
  };
  const schema = {
    schemaSql: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, by_id TEXT);',
    schemaVersion: 1,
  };

  const mcp = (write: boolean): LoginMcpChannel => ({ via: 'key', write, keyId: 'key-1' });
  const asMember = (write = true): ToolHandlerContext => ({
    ownerId: anchor,
    surface: { kind: 'team', loginId: member, contactName: 'Pat Member', mcp: mcp(write) },
  });
  const asClient = (write = true): ToolHandlerContext => ({
    ownerId: anchor,
    surface: { kind: 'client', loginId: client, contactName: 'Cam Client', mcp: mcp(write) },
  });
  const call = (slug: string, input: Record<string, unknown>, ctx: ToolHandlerContext) =>
    tools.LOGIN_APP_DATA_TOOLS.find((t) => t.slug === slug)!.handler(input, ctx);
  const out = <T>(r: Awaited<ReturnType<typeof call>>) => {
    if (!r.ok) throw new Error(r.error);
    return r.output as T;
  };
  type ListOut = { apps: { app_id: string; access: string; tables?: string[] }[] };

  /** A published app at `level` with one row, MCP access as given. */
  async function app(
    key: string,
    owner: string,
    level: string,
    opts: { mcp?: boolean; informational?: boolean; publish?: boolean } = {},
  ) {
    const a = await content.createApp(owner, { title: `${tag} ${key}` });
    await content.writeDraftFile(owner, a.id, 'App.tsx', 'export default () => "x";');
    await content.setManifest(owner, a.id, { sqlite: schema });
    await content.setDraftBuild(owner, a.id, GREEN);
    if (opts.publish !== false) {
      await content.publishApp(owner, a.id, { note: 'v1', actor: 'owner' });
    }
    await broker.appDbExec(owner, a.id, "INSERT INTO items (name) VALUES ('seed')", [], schema);
    await admin`update nodes set audience = ${level} where id = ${a.id}`;
    await admin`update apps set mcp_access = ${opts.mcp !== false},
      data_read_only = ${opts.informational === true} where node_id = ${a.id}`;
    ids[key] = a.id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'app-data-db-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    content = await import('@mantle/content');
    broker = await import('@mantle/content/app-broker');
    tools = await import('./builtins-app-data');
    await admin`insert into auth.users (id, email, password_hash, role, display_name) values
      (${anchor}, ${`ad-${tag}-o@example.invalid`}, 'x', 'admin', null),
      (${other}, ${`ad-${tag}-x@example.invalid`}, 'x', 'admin', null),
      (${member}, ${`ad-${tag}-m@example.invalid`}, 'x', 'member', 'Pat Member'),
      (${client}, ${`ad-${tag}-c@example.invalid`}, 'x', 'client', 'Cam Client')`;
    await admin`insert into spaces (id, kind, login_id) values
      (${anchor}, 'brain', ${anchor}), (${other}, 'brain', ${other})`;
    await app('a team', anchor, 'team');
    await app('b team mcp off', anchor, 'team', { mcp: false });
    await app('c team informational', anchor, 'team', { informational: true });
    await app('d admin', anchor, 'admin');
    await app('e client', anchor, 'client');
    await app('f public', anchor, 'public');
    await app('g draft only', anchor, 'team', { publish: false });
    await app('h other brain', other, 'team');
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from nodes where owner_id in (${anchor}, ${other})`;
    await admin`delete from spaces where login_id in (${anchor}, ${other}, ${member}, ${client})`;
    await admin`delete from auth.users where id in (${anchor}, ${other}, ${member}, ${client})`;
    await m.closeDb();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('runs on a login MCP connection only', async () => {
    const noMcp = { ownerId: anchor, surface: { kind: 'team', loginId: member } } as const;
    const owner = { ownerId: anchor, surface: { kind: 'owner', via: 'mcp' } } as const;
    for (const ctx of [noMcp, owner, { ownerId: anchor }] as ToolHandlerContext[]) {
      for (const t of tools.LOGIN_APP_DATA_TOOLS) {
        const r = await t.handler({ app_id: ids['a team'], sql: 'SELECT 1' }, ctx);
        expect(r.ok, t.slug).toBe(false);
        expect(!r.ok && r.error, t.slug).toMatch(/own MCP connection/);
      }
    }
  });

  it('a member reaches the published apps at their levels with MCP access on, nothing else', async () => {
    const list = out<ListOut>(await call('app_data_list', {}, asMember()));
    const byId = new Map(list.apps.map((a) => [a.app_id, a]));
    expect([...byId.keys()].sort()).toEqual(
      [ids['a team'], ids['c team informational'], ids['e client'], ids['f public']].sort(),
    );
    expect(byId.get(ids['a team']!)).toMatchObject({ access: 'read_write', tables: ['items'] });
    expect(byId.get(ids['c team informational']!)?.access).toBe('read');
    expect(byId.get(ids['e client']!)?.access).toBe('read_write');
    expect(byId.get(ids['f public']!)?.access).toBe('read');
    // Write off: everything reads only.
    const ro = out<ListOut>(await call('app_data_list', {}, asMember(false)));
    expect(new Set(ro.apps.map((a) => a.access))).toEqual(new Set(['read']));
  });

  it('a client reaches client-level apps only', async () => {
    const list = out<ListOut>(await call('app_data_list', {}, asClient()));
    expect(list.apps.map((a) => a.app_id)).toEqual([ids['e client']]);
    for (const key of ['a team', 'f public']) {
      const r = await call('app_data_query', { app_id: ids[key], sql: 'SELECT 1' }, asClient());
      expect(r.ok, key).toBe(false);
    }
  });

  it('every unreachable app answers the same not found', async () => {
    for (const key of ['b team mcp off', 'd admin', 'g draft only', 'h other brain']) {
      for (const slug of ['app_data_schema', 'app_data_query', 'app_data_write']) {
        const r = await call(
          slug,
          { app_id: ids[key], sql: "INSERT INTO items (name) VALUES ('x')" },
          asMember(),
        );
        expect(r.ok, `${slug} ${key}`).toBe(false);
        expect(!r.ok && r.error, `${slug} ${key}`).toMatch(/No such app on your MCP connection/);
      }
    }
    const [row] = await admin`select count(*)::int as n from node_snapshots
      where node_id = ${ids['b team mcp off']!} and trigger = 'pre_mcp_write'`;
    expect(row?.n).toBe(0);
  });

  it('schema: tables, columns and row counts', async () => {
    const res = out<{
      schema_version: number;
      tables: { name: string; rows: number; columns: { name: string; primary_key: boolean }[] }[];
    }>(await call('app_data_schema', { app_id: ids['a team'] }, asMember()));
    expect(res.schema_version).toBe(1);
    expect(res.tables).toHaveLength(1);
    expect(res.tables[0]).toMatchObject({ name: 'items', rows: 1 });
    expect(res.tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'name', 'by_id']);
    expect(res.tables[0]!.columns[0]!.primary_key).toBe(true);
  });

  it('query: read-only, with the caller filled into :host_me_*', async () => {
    const res = out<{ rows: { me: string; name: string; kind: string }[] }>(
      await call(
        'app_data_query',
        {
          app_id: ids['a team'],
          sql: 'SELECT :host_me_id AS me, :host_me_name AS name, :host_me_kind AS kind',
        },
        asMember(),
      ),
    );
    expect(res.rows[0]?.me).toMatch(/^u_/);
    expect(res.rows[0]).toMatchObject({ name: 'Pat Member', kind: 'member' });
    const write = await call(
      'app_data_query',
      { app_id: ids['a team'], sql: "INSERT INTO items (name) VALUES ('sneak')" },
      asMember(),
    );
    expect(write.ok).toBe(false);
    const [n] = await broker.appDbQuery(
      anchor,
      ids['a team']!,
      "SELECT count(*) AS n FROM items WHERE name = 'sneak'",
    );
    expect(n?.n).toBe(0);
  });

  it('write: refused without the Write switch, on an informational or public app, and for DDL', async () => {
    const insert = "INSERT INTO items (name) VALUES ('nope')";
    const off = await call(
      'app_data_write',
      { app_id: ids['a team'], sql: insert },
      asMember(false),
    );
    expect(!off.ok && off.error).toMatch(/read-only/);
    for (const key of ['c team informational', 'f public']) {
      const r = await call('app_data_write', { app_id: ids[key], sql: insert }, asMember());
      expect(!r.ok && r.error, key).toMatch(/read-only for you/);
    }
    for (const sql of [
      'CREATE TABLE z (x)',
      'DROP TABLE items',
      'ALTER TABLE items ADD COLUMN y',
      'SELECT 1',
    ]) {
      const r = await call('app_data_write', { app_id: ids['a team'], sql }, asMember());
      expect(!r.ok && r.error, sql).toMatch(/INSERT, UPDATE, DELETE or REPLACE/);
    }
    // A schema change hidden behind a write word: the engine refuses it.
    const hidden = await call(
      'app_data_write',
      { app_id: ids['a team'], sql: 'WITH x AS (SELECT 1) CREATE TABLE z (x)' },
      asMember(),
    );
    expect(hidden.ok).toBe(false);
    const tables = await broker.appDbSchema(anchor, ids['a team']!);
    expect(tables.map((t) => t.name)).toEqual(['items']);
  });

  it('write: a snapshot first (once an hour), then the rows, logged with SQL and changes', async () => {
    const id = ids['a team']!;
    const first = out<{ changes: number }>(
      await call(
        'app_data_write',
        {
          app_id: id,
          sql: 'INSERT INTO items (name, by_id) VALUES (?, :host_me_id)',
          params: ['one'],
        },
        asMember(),
      ),
    );
    expect(first.changes).toBe(1);
    await call(
      'app_data_write',
      { app_id: id, sql: "UPDATE items SET name = 'two' WHERE name = 'one'" },
      asMember(),
    );
    const snaps = await admin`select trigger, actor, db_path from node_snapshots
      where node_id = ${id} and trigger = 'pre_mcp_write'`;
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ actor: 'mcp' });
    expect(snaps[0]?.db_path).toBeTruthy();
    const rows = await broker.appDbQuery(anchor, id, "SELECT by_id FROM items WHERE name = 'two'");
    expect(String(rows[0]?.by_id)).toMatch(/^u_/);

    // The log is written best effort, after the answer: give it a moment.
    await new Promise((r) => setTimeout(r, 300));
    const logs = await admin`select actor_id, detail from app_access_log
      where app_node_id = ${id} and kind = 'db' and detail->>'via' = 'mcp'
        and detail->>'op' = 'exec' and detail->>'refused' is null
      order by created_at`;
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0]?.actor_id).toBe(member);
    expect(logs[0]?.detail).toMatchObject({
      role: 'member',
      connection: 'key',
      keyId: 'key-1',
      changes: 1,
    });
    expect(String(logs[0]?.detail.sql)).toContain('INSERT INTO items');
    expect(String(logs[0]?.detail.me)).toMatch(/^u_/);
  });

  it('a client writes a client app and marks it client-written', async () => {
    const id = ids['e client']!;
    const res = out<{ changes: number }>(
      await call(
        'app_data_write',
        { app_id: id, sql: "DELETE FROM items WHERE name = 'seed'" },
        asClient(),
      ),
    );
    expect(res.changes).toBe(1);
    const [reg] =
      await admin`select client_written_at from app_databases where app_node_id = ${id}`;
    expect(reg?.client_written_at).toBeTruthy();
  });

  it('the lookup runs on the team and client roles (its columns are granted)', async () => {
    // A column the role may not read fails the query (42501), so getting an
    // answer at all is the proof.
    await expect(
      m.withViewer('team', () => content.listMcpDataApps(anchor, 'member')),
    ).resolves.toBeInstanceOf(Array);
    const one = await m.withViewer('client', () =>
      content.getMcpDataApp(anchor, 'client', ids['e client']!),
    );
    expect(one === null || one.id === ids['e client']).toBe(true);
  });
});
