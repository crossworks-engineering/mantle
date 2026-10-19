/**
 * App data over a login's own MCP, end to end on a real migrated Postgres
 * (team apps M1 audit, low 6 and medium 1):
 *
 *  - through the one MCP surface every login has since W7b
 *    (registerPreparedTools: the login's scope per call, the builtin with
 *    the surface the route stamps), on the box's brain of a scratch database
 *    of its own, migrated to workspaces, so row security applies for real;
 *  - the Team grant decides (workspaces W5b2): an app placed in a folder
 *    Team holds takes the folder's grant (S6) and is reached, its data
 *    written by the grant's Write switch;
 *  - a peer bound to a member acts as that member, narrowed by its own
 *    Write switch only (plan 7.6; the per-login switches went in W7b).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/app-data-mcp.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedScratchDatabase, superuserExec } from '@mantle/db/test-support';
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
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | null = null;
  const anchor = randomUUID();
  let team = '';
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
  type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
  /** The tools the one surface registers for the member's key. */
  const surfaceFor = (write: boolean) => {
    const out = new Map<string, Handler>();
    const fake = {
      registerTool: (name: string, _c: unknown, handler: Handler) => void out.set(name, handler),
    };
    ls.registerPreparedTools(fake as never, {
      kind: 'owner',
      caller: caller(write),
      view: { holdsAdmin: false, areas: new Set() },
      privateWs: null,
      connectors: [],
    });
    return out;
  };
  const text = (r: unknown) =>
    ((r as { content?: { text?: string }[] }).content ?? []).map((p) => p.text ?? '').join('\n');
  const run = async (slug: string, args: Record<string, unknown>, write = true) => {
    const tool = surfaceFor(write).get(slug);
    if (!tool) throw new Error(`${slug} is not on the surface`);
    return (await tool(args, {})) as { isError?: boolean; content?: { text?: string }[] };
  };

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

  /** Grant `node` to Team, Write as given (a folder passes it on). */
  const grantTeam = (node: string, write: boolean) =>
    m.withSubtreeHeads(node, [], (tx) =>
      tx.execute(m.sql`insert into item_grants (node_id, workspace_id, write)
        values (${node}, ${team}, ${write})
        on conflict (node_id, workspace_id) do update set write = excluded.write`),
    );
  const ungrantTeam = (node: string) =>
    m.withSubtreeHeads(node, [], (tx) =>
      tx.execute(m.sql`delete from item_grants where node_id = ${node} and workspace_id = ${team}`),
    );

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'app-data-mcp-'));
    process.env.APP_DB_DIR = dir;
    m = await import('@mantle/db');
    sql = (m.systemDb as unknown as { $client: typeof sql }).$client;
    // The viewer roles are the cluster's (set up once for the test run): a
    // scratch database never resets them.
    content = await import('@mantle/content');
    ls = await import('@mantle/mcp-core');
    auth = await import('./mcp-auth');
    ({ hashToken } = await import('@mantle/content/peers-crypto'));
    await sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${anchor}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Olive Owner'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Mia Member')`;
    await sql`insert into spaces (id, kind, login_id) values (${anchor}, 'brain', ${anchor})
      on conflict (id) do nothing`;
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    team = (
      await sql<{ id: string }[]>`select id::text as id from workspaces
        where owner_id = ${anchor} and name = 'Team' and not is_admin`
    )[0]!.id;
    // As the superuser: the app pools only read the workspace tables.
    await superuserExec(
      scratch.url,
      m.sql`insert into workspace_users (workspace_id, login_id) values (${team}, ${member})
        on conflict do nothing`,
    );
  }, 180_000);

  afterAll(async () => {
    if (m) await m.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('query and write run through the real login path, by the Team grant', async () => {
    const id = await publishedApp('team app');
    await grantTeam(id, true);
    const wrote = await run('app_data_write', {
      app_id: id,
      sql: 'INSERT INTO items (name) VALUES (?)',
      params: ['e2e'],
    });
    expect(wrote.isError ?? false, text(wrote)).toBe(false);
    const read = await run('app_data_query', { app_id: id, sql: 'SELECT name FROM items' });
    expect(read.isError ?? false, text(read)).toBe(false);
    expect(JSON.parse(text(read)).rows).toEqual([{ name: 'e2e' }]);
    // The same call once Team no longer holds it: the app is not there.
    await ungrantTeam(id);
    const hidden = await run('app_data_query', { app_id: id, sql: 'SELECT 1' });
    expect(text(hidden)).toMatch(/No such app on your MCP connection/);
  });

  it('an app placed in a folder Team holds takes its grant, and its Write switch', async () => {
    await sql`insert into nodes (id, owner_id, type, title, path)
      values (${folder}, ${anchor}, 'branch', ${`${tag} folder`}, ${`apps.${label}`}::ltree)`;
    await grantTeam(folder, true);
    const id = await publishedApp('in shared folder');
    await m.withHeads([id, folder], 'update', (tx) =>
      tx.execute(m.sql`update nodes set path = ${`apps.${label}`}::ltree where id = ${id}`),
    );
    const [n] = await sql<Row[]>`select ${team}::uuid = any(read_ws) as reads from nodes
      where id = ${id}`;
    expect(n?.reads).toBe(true);
    const listed = await run('app_data_list', {});
    const app = (
      JSON.parse(text(listed)) as { apps: { app_id: string; access: string }[] }
    ).apps.find((a) => a.app_id === id);
    expect(app).toMatchObject({ access: 'read_write' });
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
    // The folder's Write switch off: the app reads only.
    await grantTeam(folder, false);
    const ro = (
      JSON.parse(text(await run('app_data_list', {}))) as {
        apps: { app_id: string; access: string }[];
      }
    ).apps.find((a) => a.app_id === id);
    expect(ro).toMatchObject({ access: 'read' });
  });

  it('a peer bound to a member acts as the member, narrowed by its own Write switch', async () => {
    await sql`insert into nodes (id, owner_id, type, title, path)
      values (${peerNode}, ${anchor}, 'mantle_peer', ${`${tag} peer`}, 'peers')`;
    await sql`insert into mantle_peers
        (id, owner_id, node_id, display_name, base_url, inbound_token_hash, status, enabled,
         acts_as_login_id, write_enabled)
      values (${peerId}, ${anchor}, ${peerNode}, ${`${tag} peer`}, 'https://peer.example.invalid',
              ${hashToken(peerToken)}, 'active', true, ${member}, true)`;
    const resolve = () =>
      auth.resolveMcpCaller(
        new Request('http://localhost/api/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${peerToken}` },
        }),
      );
    // No per-login switch since W7b: the peer acts as the member, and writes
    // while its own Write switch is on.
    expect(await resolve()).toMatchObject({ role: 'member', via: 'peer', write: true });
    // The peer's own Write off still wins (it narrows, plan 7.6).
    await sql`update mantle_peers set write_enabled = false where id = ${peerId}`;
    expect(await resolve()).toMatchObject({ write: false });
  });
});
