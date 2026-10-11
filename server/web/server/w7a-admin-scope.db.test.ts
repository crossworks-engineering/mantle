/**
 * W7a: what the Admin assistant and the Admin MCP surface read in their
 * scope, and the rollback switch, on a migrated scratch database.
 *
 *  - The Admin assistant (a turn scope of Admin) does NOT read an item that
 *    lives only in another user's private workspace (by id, by list, by its
 *    tools); it DOES read Admin items, the Journal, the "About the user"
 *    block, entity names and its own history (the conversation context it
 *    builds says so: the arms that were skipped below Admin are on).
 *  - A turn that answers no login (a heartbeat, a run) acts for the owner:
 *    its scope's login is the anchor, its rows' stamp names no login.
 *  - The Admin MCP surface reads the login's own workspaces: an Admin user
 *    reads its own private item there, not another user's.
 *  - MANTLE_ADMIN_READS=system: both paths behave as before (the system
 *    pool, every item).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7a-admin-scope.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('W7a: the Admin assistant and the Admin MCP read in their scope', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let c: typeof import('@mantle/content');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const mem = randomUUID(); // a member: its private workspace
  const tag = `w7as${randomUUID().slice(0, 6)}`;
  let adminWs = '';
  let adminPage = '';
  let privatePage = '';
  let ownerPrivatePage = '';
  let agent: import('@mantle/db').Agent;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn);
  const makeIn = <T>(home: string, fn: () => Promise<T>) =>
    sys(() => m.withCreateHome({ createWs: home, privateWs: null, quiet: true }, fn));
  const privateFor = async (login: string) =>
    (
      await x<{ ws: string }>(
        sql`select "public"."mantle_ws_private_workspace"(${login}::uuid)::text as ws`,
      )
    )[0]!.ws;
  const inAdminTurn = <T>(fn: () => Promise<T>, loginId?: string) =>
    rt.withAgentScope({ id: agent.id, audience: 'admin', workspaceId: adminWs }, fn, {
      ownerLoginId: loginId ?? null,
    });
  const nodeRead = (id: string) =>
    t.dispatchTool(
      {
        slug: 'node_read',
        handler: { kind: 'builtin', ref: 'node_read' },
        inputSchema: {},
      } as unknown as import('@mantle/db').Tool,
      { node_id: id },
      { ownerId: owner, surface: { kind: 'web', loginId: owner } },
    );
  const seesNode = async (id: string) =>
    (await m.db.select({ id: m.nodes.id }).from(m.nodes).where(eq(m.nodes.id, id))).length === 1;
  const mcpCall = async (loginId: string, name: string, args: Record<string, unknown>) => {
    const ls = await import('@mantle/mcp-core');
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(
      server,
      await ls.prepareCallerTools({
        role: 'admin',
        anchorId: owner,
        loginId,
        via: 'oauth',
        write: true,
      }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    await client.close();
    return { isError: res.isError === true, text: res.content?.map((p) => p.text).join('') ?? '' };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7a-scope-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_ADMIN_READS;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the W7a test', { status: 503 })),
    );
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    t = await import('@mantle/tools');
    rt = await import('@mantle/runtime/agent');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${mem}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    adminPage = (await makeIn(adminWs, () => c.createPage(owner, { title: `${tag} admin page` })))
      .id;
    privatePage = (
      await makeIn(await privateFor(mem), () =>
        c.createPage(owner, { title: `${tag} member private page` }),
      )
    ).id;
    ownerPrivatePage = (
      await makeIn(await privateFor(owner), () =>
        c.createPage(owner, { title: `${tag} owner private page` }),
      )
    ).id;
    // The Admin assistant, its history, a Journal entry, an entity.
    const [row] = await m.systemDb
      .insert(m.agents)
      .values({
        ownerId: owner,
        slug: `${tag}-admin`,
        name: 'Admin assistant',
        model: 'test/model',
        systemPrompt: 'p',
        workspaceId: adminWs,
        memoryConfig: { chunk_limit: 0, content_hit_limit: 0, corpus_map_limit: 0 },
      })
      .returning();
    agent = row!;
    await sys(() =>
      rt.recordTurn({
        ownerId: owner,
        agentId: agent.id,
        loginId: owner,
        direction: 'inbound',
        text: `${tag} remember the blue kettle`,
        channel: 'web',
      }),
    );
    await sys(() => c.createJournal(owner, { body: `${tag} the owner keeps bees`, kind: 'fact' }));
    await x(
      sql`insert into entities (owner_id, kind, name) values (${owner}, 'person', ${`${tag} Ada`})`,
    );
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.MANTLE_ADMIN_READS;
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the Admin assistant reads Admin items, never another user’s private workspace', async () => {
    const seen = await inAdminTurn(async () => {
      const s = m.currentScope();
      return {
        kind: s.kind,
        ws: 'ws' in s ? s.ws : [],
        admin: await seesNode(adminPage),
        memberPrivate: await seesNode(privatePage),
        ownerPrivate: await seesNode(ownerPrivatePage),
        list: (await c.listPages(owner)).map((p) => p.id),
        read: await nodeRead(privatePage),
        readAdmin: await nodeRead(adminPage),
      };
    }, owner);
    expect(seen.kind).toBe('assistant');
    expect(seen.ws).toEqual([adminWs]);
    expect(seen.admin).toBe(true);
    expect(seen.memberPrivate).toBe(false);
    // The Admin assistant reads Admin, not the owner's own private workspace.
    expect(seen.ownerPrivate).toBe(false);
    expect(seen.list).toContain(adminPage);
    expect(seen.list).not.toContain(privatePage);
    expect(seen.read.ok).toBe(false);
    expect(seen.readAdmin.ok).toBe(true);
  });

  it('the Admin assistant keeps the Journal, About the user, entity names and its history', async () => {
    const ctx = await rt.loadConversationContext({
      ownerId: owner,
      agent,
      inboundText: `${tag} what about the kettle and Ada?`,
      ownerLoginId: owner,
    });
    const history = ctx.history.map((h) => h.text).join('\n');
    expect(history).toContain('blue kettle');
    const inScope = await inAdminTurn(async () => ({
      holdsAdmin: await m.scopeHoldsAdmin(),
      entity: (
        await m.db
          .select({ name: m.entities.name })
          .from(m.entities)
          .where(eq(m.entities.ownerId, owner))
      ).map((e) => e.name),
      identity: await c.buildIdentityContext(owner, agent.slug),
    }));
    expect(inScope.holdsAdmin).toBe(true);
    expect(inScope.entity).toContain(`${tag} Ada`);
    expect(inScope.identity).toContain('keeps bees');
  });

  it('a turn that answers no login acts for the owner; its stamp names none', async () => {
    const seen = await rt.withAgentScope(
      { id: agent.id, audience: 'admin', workspaceId: adminWs },
      async () => {
        const s = m.currentScope();
        return {
          login: 'loginId' in s ? s.loginId : null,
          mod: 'modWs' in s ? s.modWs : [],
          stamp: m.currentTurnStamp(),
        };
      },
    );
    expect(seen.login).toBe(owner);
    expect(seen.mod).toEqual([adminWs]);
    expect(seen.stamp).toEqual({ workspaceId: adminWs, loginId: null });
  });

  it('the Admin MCP surface reads the login’s own workspaces only', async () => {
    const own = await mcpCall(owner, 'node_read', { node_id: ownerPrivatePage });
    expect(own.isError, own.text.slice(0, 200)).toBe(false);
    const other = await mcpCall(owner, 'node_read', { node_id: privatePage });
    expect(other.isError).toBe(true);
    const admin = await mcpCall(owner, 'node_read', { node_id: adminPage });
    expect(admin.isError, admin.text.slice(0, 200)).toBe(false);
  });

  it('MANTLE_ADMIN_READS=system: both paths read as before', async () => {
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      const seen = await inAdminTurn(async () => ({
        kind: m.currentScope().kind,
        memberPrivate: await seesNode(privatePage),
        stamp: m.currentTurnStamp(),
      }));
      expect(seen.kind).toBe('system');
      expect(seen.memberPrivate).toBe(true);
      expect(seen.stamp).toEqual({ workspaceId: adminWs, loginId: null });
      expect(await rt.agentTurnScoped({ audience: 'admin', workspaceId: adminWs })).toBe(false);
      const other = await mcpCall(owner, 'node_read', { node_id: privatePage });
      expect(other.isError, other.text.slice(0, 200)).toBe(false);
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
    expect(await rt.agentTurnScoped({ audience: 'admin', workspaceId: adminWs })).toBe(true);
  });
});
