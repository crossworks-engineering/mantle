/**
 * App data over a login's own MCP, end to end on a real migrated Postgres
 * (team apps M1 audit, low 6 and medium 1):
 *
 *  - through the real login path (callLoginTool: withViewer at the login's
 *    level, dispatchTool, the surface the route stamps), on the box's brain
 *    so row security applies for real;
 *  - an admin-level app inside a folder shared with the team is reached at
 *    team level, as the browser runs it;
 *  - a peer bound to a member acts under that member's MCP and Write
 *    switches (resolveMcpCaller).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/app-data-mcp.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestAnchor } from '@mantle/db/test-support';
import type { McpCaller } from '@mantle/mcp-core';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('app data over a login MCP, end to end', () => {
  let m: typeof import('@mantle/db');
  let sql: Parameters<typeof m.ensureViewerRoles>[0];
  let content: typeof import('@mantle/content');
  let ls: typeof import('@mantle/mcp-core');
  let auth: typeof import('./mcp-auth');
  let hashToken: typeof import('@mantle/content/peers-crypto').hashToken;
  let dir = '';
  let anchor = '';
  const tag = `adm-${randomUUID().slice(0, 8)}`;
  const member = randomUUID();
  const label = `adm${randomUUID().slice(0, 8)}`;
  const folder = randomUUID();
  const peerNode = randomUUID();
  const peerId = randomUUID();
  const peerToken = `mtlpeer_${randomUUID().replace(/-/g, '')}`;
  const appIds: string[] = [];
  const GREEN = {
    storageKey: 'attachments/aa/bb/test',
    sha256: 'test',
    builtAt: '2026-10-08T00:00:00.000Z',
    esbuildVersion: 'test',
    bytes: 1,
    ok: true,
  };
  const schema = {
    schemaSql: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT);',
    schemaVersion: 1,
  };

  const caller = (write = true): McpCaller & { role: 'member' } => ({
    role: 'member',
    anchorId: anchor,
    loginId: member,
    displayName: 'Mia Member',
    via: 'key',
    keyId: 'key-e2e',
    write,
  });
  const toolRow = (slug: string) =>
    ({
      slug,
      description: '',
      inputSchema: {},
      handler: { kind: 'builtin', ref: slug },
      requiresConfirm: false,
    }) as unknown as import('@mantle/db').Tool;
  const text = (r: unknown) =>
    ((r as { content?: { text?: string }[] }).content ?? []).map((p) => p.text ?? '').join('\n');
  const run = (slug: string, args: Record<string, unknown>, write = true) =>
    ls.callLoginTool(caller(write), toolRow(slug), args, 'team', false);

  async function publishedApp(title: string): Promise<string> {
    const a = await content.createApp(anchor, { title: `${tag} ${title}` });
    await content.writeDraftFile(anchor, a.id, 'App.tsx', 'export default () => "x";');
    await content.setManifest(anchor, a.id, { sqlite: schema });
    await content.setDraftBuild(anchor, a.id, GREEN);
    await content.publishApp(anchor, a.id, { note: 'v1', actor: 'owner' });
    await sql`update apps set mcp_access = true where node_id = ${a.id}`;
    appIds.push(a.id);
    return a.id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'app-data-mcp-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    await m.ensureViewerRoles(sql, process.env.MANTLE_MASTER_KEY);
    content = await import('@mantle/content');
    ls = await import('@mantle/mcp-core');
    auth = await import('./mcp-auth');
    ({ hashToken } = await import('@mantle/content/peers-crypto'));
    anchor = await ensureTestAnchor(sql);
    await sql`insert into auth.users (id, email, password_hash, role, display_name)
      values (${member}, ${`${tag}-m@example.invalid`}, 'x', 'member', 'Mia Member')`;
  }, 120_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from mantle_peers where id = ${peerId}`;
    if (appIds.length) await sql`delete from nodes where id in ${sql(appIds)}`;
    await sql`delete from nodes where id in (${folder}, ${peerNode})`;
    await sql`delete from mcp_login_access where login_id = ${member}`;
    await sql`delete from spaces where login_id = ${member}`;
    await sql`delete from auth.users where id = ${member}`;
    await m.closeDb();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('query and write run through the real login path, on the team role', async () => {
    const id = await publishedApp('team app');
    await sql`update nodes set audience = 'team' where id = ${id}`;
    const wrote = await run('app_data_write', {
      app_id: id,
      sql: 'INSERT INTO items (name) VALUES (?)',
      params: ['e2e'],
    });
    expect(wrote.isError ?? false, text(wrote)).toBe(false);
    const read = await run('app_data_query', { app_id: id, sql: 'SELECT name FROM items' });
    expect(read.isError ?? false, text(read)).toBe(false);
    expect(JSON.parse(text(read)).rows).toEqual([{ name: 'e2e' }]);
    // The same call above the login's level: an admin app is not there.
    await sql`update nodes set audience = 'admin' where id = ${id}`;
    const hidden = await run('app_data_query', { app_id: id, sql: 'SELECT 1' });
    expect(text(hidden)).toMatch(/No such app on your MCP connection/);
  });

  it('an admin-level app inside a folder shared with the team is reached at team level', async () => {
    await sql`insert into nodes (id, owner_id, type, title, path, audience)
      values (${folder}, ${anchor}, 'branch', ${`${tag} folder`}, ${`apps.${label}`}::ltree, 'admin')`;
    await sql`update nodes set share_level = 'team' where id = ${folder}`;
    const id = await publishedApp('in shared folder');
    await sql`update nodes set path = ${`apps.${label}`}::ltree, audience = 'admin' where id = ${id}`;
    const [n] = await sql<Row[]>`select inherited_level from nodes where id = ${id}`;
    expect(n?.inherited_level).toBe('team');
    const listed = await run('app_data_list', {});
    const app = (
      JSON.parse(text(listed)) as { apps: { app_id: string; level: string; access: string }[] }
    ).apps.find((a) => a.app_id === id);
    expect(app).toMatchObject({ level: 'team', access: 'read_write' });
    const read = await run('app_data_query', {
      app_id: id,
      sql: 'SELECT count(*) AS n FROM items',
    });
    expect(read.isError ?? false, text(read)).toBe(false);
    // The list call itself is logged (M1 audit, low 1).
    await new Promise((r) => setTimeout(r, 300));
    const [logged] = await sql<Row[]>`select count(*)::int as n from app_access_log
      where app_node_id = ${id} and actor_id = ${member} and detail->>'op' = 'list'`;
    expect(Number(logged?.n)).toBeGreaterThan(0);
  });

  it("a peer bound to a member acts under the member's MCP and Write switches", async () => {
    await sql`insert into nodes (id, owner_id, type, title, path)
      values (${peerNode}, ${anchor}, 'mantle_peer', ${`${tag} peer`}, 'peers')`;
    await sql`insert into mantle_peers
        (id, owner_id, node_id, display_name, base_url, inbound_token_hash, status, enabled,
         acts_as_login_id, acts_as_role, write_enabled)
      values (${peerId}, ${anchor}, ${peerNode}, ${`${tag} peer`}, 'https://peer.example.invalid',
              ${hashToken(peerToken)}, 'active', true, ${member}, 'member', true)`;
    const resolve = () =>
      auth.resolveMcpCaller(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${peerToken}` },
        }),
      );
    // The member's MCP switch off (no row, or off): the peer is refused.
    expect(await resolve()).toBeNull();
    await sql`insert into mcp_login_access (login_id, enabled, write_enabled)
              values (${member}, false, true)`;
    expect(await resolve()).toBeNull();
    // MCP on, the member's Write off: the peer reads only, whatever its own.
    await sql`update mcp_login_access set enabled = true, write_enabled = false
              where login_id = ${member}`;
    expect(await resolve()).toMatchObject({ role: 'member', via: 'peer', write: false });
    // Both on: the peer writes.
    await sql`update mcp_login_access set write_enabled = true where login_id = ${member}`;
    expect(await resolve()).toMatchObject({ role: 'member', via: 'peer', write: true });
    // The peer's own Write off still wins.
    await sql`update mantle_peers set write_enabled = false where id = ${peerId}`;
    expect(await resolve()).toMatchObject({ write: false });
  });
});
