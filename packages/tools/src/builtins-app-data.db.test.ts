/**
 * App data over a login's own MCP (team apps Phase 1, plan page b6dd688e) on
 * a real, migrated Postgres and real SQLite files:
 *
 *  - reach: only apps with MCP access on, published, of this brain: for a
 *    member one the Team workspace holds (its grant; workspaces W5b2); never
 *    an app
 *    only Admin holds, one with only a public link, a draft, or MCP access
 *    off;
 *  - read or write: the login's Write switch and the browser's rule (for a
 *    member the grant's Write switch, Informational being Write off);
 *  - query: read-only, `:host_me_*` filled for the caller;
 *  - write: rows only (no DDL), an hourly `pre_mcp_write` snapshot first,
 *    the SQL and the changes in the access log;
 *  - none of it off a login's own MCP connection.
 *
 * The lookups run on the admin pool here: the rule is in the query (as the
 * member-apps tests prove theirs; on the admin pool the member's workspace is
 * the Team of the app's owner).
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
  let broker: typeof import('@mantle/content/app-broker');
  let tools: typeof import('./builtins-app-data');
  let dir = '';
  const anchor = randomUUID();
  const other = randomUUID();
  const member = randomUUID();
  const client = randomUUID();
  const tag = anchor.slice(0, 8);
  const ids: Record<string, string> = {};
  const ws = { admin: randomUUID(), team: randomUUID(), otherTeam: randomUUID() };
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
  // A member's call runs in its login's scope, as its MCP connection runs
  // every call (mcp-core mcp-scope.ts): its workspaces are Team (a user, no
  // Moderator). With no scope a member reaches nothing (0286: it reached
  // the built-in Team workspace's apps until then).
  const call = (slug: string, input: Record<string, unknown>, ctx: ToolHandlerContext) => {
    const run = () => tools.LOGIN_APP_DATA_TOOLS.find((t) => t.slug === slug)!.handler(input, ctx);
    const surface = ctx.surface as { loginId?: string } | undefined;
    if (surface?.loginId === member) {
      return m.withScope({ kind: 'user', loginId: member, ws: [ws.team], modWs: [] }, run);
    }
    if (surface?.loginId === anchor) {
      return m.withScope({ kind: 'user', loginId: anchor, ws: [ws.admin], modWs: [ws.admin] }, run);
    }
    return run();
  };
  const out = <T>(r: Awaited<ReturnType<typeof call>>) => {
    if (!r.ok) throw new Error(r.error);
    return r.output as T;
  };
  type ListOut = { apps: { app_id: string; access: string; tables?: string[] }[] };

  /**
   * A published app with one row, MCP access as given. `team`: the Team
   * grant ('write': Write on, 'read': Write off, none: only Admin holds it).
   * `client`: written at client level when made (the client portal's rule;
   * the levels are frozen after). `link`: an open public link.
   */
  async function app(
    key: string,
    owner: string,
    opts: {
      team?: 'write' | 'read';
      client?: boolean;
      link?: boolean;
      mcp?: boolean;
      publish?: boolean;
      used?: boolean;
    } = {},
  ) {
    const id = randomUUID();
    await admin`insert into nodes (id, owner_id, type, title, path, audience)
      values (${id}, ${owner}, 'app', ${`${tag} ${key}`}, 'apps', ${opts.client ? 'client' : 'admin'})`;
    const manifest = JSON.stringify({ sqlite: schema });
    const build = JSON.stringify(GREEN);
    await admin`insert into apps (node_id, manifest, published_build, mcp_access)
      values (${id}, ${manifest}::jsonb,
              ${opts.publish === false ? null : build}::jsonb, ${opts.mcp !== false})`;
    if (opts.used !== false) {
      await broker.appDbExec(owner, id, "INSERT INTO items (name) VALUES ('seed')", [], schema);
    }
    const home = owner === anchor ? ws.admin : ws.otherTeam;
    await grant(id, home, false, true);
    if (opts.team && owner === anchor) await grant(id, ws.team, opts.team === 'write');
    if (opts.link) {
      await admin`insert into shares (owner_id, node_id, node_type, token)
        values (${owner}, ${id}, 'app', ${`${tag}-${randomUUID()}`})`;
    }
    ids[key] = id;
  }

  const grant = (node: string, wsId: string, write: boolean, home = false) =>
    m.withHeads([node], 'update', (tx) =>
      tx.execute(m.sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${node}, ${wsId}, ${write}, ${home})`),
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'app-data-db-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await m.ensureViewerRoles(admin, process.env.MANTLE_MASTER_KEY);
    broker = await import('@mantle/content/app-broker');
    tools = await import('./builtins-app-data');
    await admin`insert into auth.users (id, email, password_hash, role, display_name) values
      (${anchor}, ${`ad-${tag}-o@example.invalid`}, 'x', 'admin', null),
      (${other}, ${`ad-${tag}-x@example.invalid`}, 'x', 'admin', null),
      (${member}, ${`ad-${tag}-m@example.invalid`}, 'x', 'member', 'Pat Member')`;
    await admin`insert into spaces (id, kind, login_id) values
      (${anchor}, 'brain', ${anchor}), (${other}, 'brain', ${other})`;
    await admin`insert into workspaces (id, owner_id, name, is_admin, bridge_key) values
      (${ws.admin}, ${anchor}, ${`${tag} Admin`}, true, 'admin'),
      (${ws.team}, ${anchor}, ${`${tag} Team`}, false, null),
      (${ws.otherTeam}, ${other}, ${`${tag} Other team`}, false, null)`;
    await admin`insert into workspace_users (workspace_id, login_id, moderator)
      values (${ws.team}, ${member}, false)`;
    await app('a team', anchor, { team: 'write' });
    await app('b team mcp off', anchor, { team: 'write', mcp: false });
    await app('c team write off', anchor, { team: 'read' });
    await app('d admin', anchor);
    await app('e client', anchor, { client: true });
    await app('f public link', anchor, { link: true });
    await app('g draft only', anchor, { team: 'write', publish: false });
    await app('i team never used', anchor, { team: 'write', used: false });
    await app('h other brain', other);
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from shares where owner_id in (${anchor}, ${other})`;
    await admin`delete from item_grants where node_id in
      (select id from nodes where owner_id in (${anchor}, ${other}))`;
    await admin`delete from nodes where owner_id in (${anchor}, ${other})`;
    await admin`delete from workspaces where owner_id in (${anchor}, ${other})`;
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

  it('a member reaches the published apps Team holds with MCP access on, nothing else', async () => {
    const list = out<ListOut>(await call('app_data_list', {}, asMember()));
    const byId = new Map(list.apps.map((a) => [a.app_id, a]));
    expect([...byId.keys()].sort()).toEqual(
      [ids['a team'], ids['c team write off'], ids['i team never used']].sort(),
    );
    expect(byId.get(ids['a team']!)).toMatchObject({ access: 'read_write', tables: ['items'] });
    // The grant's Write switch off (Informational): read only.
    expect(byId.get(ids['c team write off']!)?.access).toBe('read');
    // Write off: everything reads only.
    const ro = out<ListOut>(await call('app_data_list', {}, asMember(false)));
    expect(new Set(ro.apps.map((a) => a.access))).toEqual(new Set(['read']));
  });

  it('every unreachable app answers the same not found', async () => {
    for (const key of [
      'b team mcp off',
      'd admin',
      'e client',
      'f public link',
      'g draft only',
      'h other brain',
    ]) {
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

  it('schema: an app never used yet shows its declared tables, empty', async () => {
    const res = out<{ schema_version: number; tables: { name: string; rows: number }[] }>(
      await call('app_data_schema', { app_id: ids['i team never used'] }, asMember()),
    );
    expect(res.schema_version).toBe(1);
    expect(res.tables).toEqual([expect.objectContaining({ name: 'items', rows: 0 })]);
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

  it("W8 integration: on the one MCP surface :host_me_kind is the login's real role", async () => {
    const onMcp = (loginId: string, role: 'admin' | 'member'): ToolHandlerContext => ({
      ownerId: anchor,
      surface: { kind: 'owner', via: 'mcp', loginId, mcp: { ...mcp(true), role } },
    });
    const kindOf = async (ctx: ToolHandlerContext) =>
      out<{ rows: { kind: string }[] }>(
        await call(
          'app_data_query',
          { app_id: ids['a team'], sql: 'SELECT :host_me_kind AS kind' },
          ctx,
        ),
      ).rows[0]?.kind;
    expect(await kindOf(onMcp(anchor, 'admin'))).toBe('admin');
    expect(await kindOf(onMcp(member, 'member'))).toBe('member');
  });

  it("write: refused without the login's or the grant's Write switch, and for DDL", async () => {
    const insert = "INSERT INTO items (name) VALUES ('nope')";
    const off = await call(
      'app_data_write',
      { app_id: ids['a team'], sql: insert },
      asMember(false),
    );
    expect(!off.ok && off.error).toMatch(/read-only/);
    const grantOff = await call(
      'app_data_write',
      { app_id: ids['c team write off'], sql: insert },
      asMember(),
    );
    expect(!grantOff.ok && grantOff.error).toMatch(/read-only for you/);
    for (const sql of [
      'CREATE TABLE z (x)',
      'DROP TABLE items',
      'ALTER TABLE items ADD COLUMN y',
      'SELECT 1',
      "VACUUM INTO '/tmp/app-data-escape.sqlite'",
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
    // Past the first-word check, the broker and the engine still refuse a
    // VACUUM INTO on the data-only path (M1 audit, low 3).
    await expect(
      broker.appDbExec(
        anchor,
        ids['a team']!,
        "VACUUM INTO '/tmp/app-data-escape.sqlite'",
        [],
        schema,
        {
          dataOnly: true,
        },
      ),
    ).rejects.toThrow(/not allowed|authoriz/i);
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
});
