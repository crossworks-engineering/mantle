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
 *  - W7a fix round 1, on MCP as a second Admin login L (Admin, not a
 *    Moderator, its keys area off) and as the anchor:
 *    H1: sandbox_import, peer_file_copy and email_page (includeLink) on
 *    another user's private file or page are refused or not found and
 *    nothing leaves (no outbound call, no link); sandbox_export onto a
 *    same-named file the scope cannot edit is refused and the file is
 *    unchanged.
 *    M1: ask_responder's nested Admin turn (no login named) answers L, not
 *    the anchor: L's areas (keys off), and it still reads Admin.
 *    M2: update tools on a Read-only shared item are refused in an Admin
 *    turn and on MCP, the item unchanged; on an editable item they work.
 *    M3: run_terminal needs the settings area.
 *    L1, L2, L5: process_extraction, the owner preferences and
 *    unsupersedeNode never reach outside the scope.
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
  const second = randomUUID(); // L: a second Admin login, no Moderator, keys off
  const tag = `w7as${randomUUID().slice(0, 6)}`;
  let adminWs = '';
  let adminPage = '';
  let privatePage = '';
  let ownerPrivatePage = '';
  let roPage = ''; // the member's, shared to Admin with Read only
  let roNote = '';
  let memFile = ''; // the member's private file
  let takenFile = ''; // the member's, in the sandbox exports folder
  const takenName = `${tag}-taken.txt`;
  /** Every outbound request the code made (the stub answers them). */
  const outbound: string[] = [];
  let agent: import('@mantle/db').Agent;

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn, 'test');
  const makeIn = <T>(home: string, fn: () => Promise<T>) =>
    sys(() => m.withCreateHome({ createWs: home, privateWs: null, quiet: true }, fn));
  const privateFor = async (login: string) =>
    (
      await x<{ ws: string }>(
        sql`select "public"."mantle_ws_private_workspace"(${login}::uuid)::text as ws`,
      )
    )[0]!.ws;
  const inAdminTurn = <T>(fn: () => Promise<T>, loginId?: string) =>
    rt.withAgentScope({ id: agent.id, workspaceId: adminWs }, fn, {
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
  const homeIn = (id: string, ws: string) =>
    sys(() =>
      m.withHeads([id], 'update', async (tx) => {
        await tx.execute(sql`delete from item_grants where node_id = ${id}`);
        await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                             values (${id}, ${ws}, true)`);
      }),
    );
  const readOnlyIn = (id: string, ws: string) =>
    sys(() =>
      m.withHeads([id], 'update', async (tx) => {
        await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                             values (${id}, ${ws}, false) on conflict do nothing`);
      }),
    );
  const nodeState = async (id: string) =>
    JSON.stringify(
      await x(sql`select title, data, updated_at, superseded_by, superseded_reason, salience,
                         (select count(*) from shares s where s.node_id = n.id) as shares
                    from nodes n where id = ${id}`),
    );
  const dispatchAs = (slug: string, input: Record<string, unknown>) =>
    t.dispatchTool(
      {
        slug,
        handler: { kind: 'builtin', ref: slug },
        inputSchema: {},
      } as unknown as import('@mantle/db').Tool,
      input,
      { ownerId: owner, surface: { kind: 'web', loginId: owner } },
    );
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
    // The sandbox daemon is wired (its calls are stubbed): the sandbox
    // tools run up to the point where they would send bytes out.
    process.env.SANDBOXD_URL = 'http://sandboxd.invalid';
    process.env.SANDBOXD_TOKEN = 'w7a-sandboxd-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input instanceof Request ? input.url : input);
        outbound.push(url);
        // A sandbox export answers bytes: sandbox_export then writes a file.
        if (url.includes('sandboxd.invalid') && url.endsWith('/export')) {
          return new Response('bytes from the sandbox', { status: 200 });
        }
        return new Response('offline in the W7a test', { status: 503 });
      }),
    );
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    t = await import('@mantle/tools');
    rt = await import('@mantle/runtime/agent');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${mem}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member'),
      (${second}, ${`${tag}-l@example.invalid`}, 'x', false, 'admin', 'Second Admin')`);
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
    // L: a user of Admin, not a Moderator there, its keys area off.
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator, limits)
                values (${adminWs}, ${second}, false, ${JSON.stringify({ areas: { keys: false } })}::jsonb)
                on conflict (workspace_id, login_id)
                do update set moderator = false, limits = excluded.limits`);
    // The member's items: a page and a note shared to Admin with Read only,
    // a private file, and a file in the sandbox exports folder.
    const memWs = await privateFor(mem);
    roPage = (await makeIn(memWs, () => c.createPage(owner, { title: `${tag} read-only page` })))
      .id;
    roNote = (
      await makeIn(memWs, () =>
        c.createNote(owner, { title: `${tag} read-only note`, content: 'kept' }),
      )
    ).id;
    await readOnlyIn(roPage, adminWs);
    await readOnlyIn(roNote, adminWs);
    const files = await import('@mantle/files');
    await sys(() => files.ensureFilesRootBranch(owner));
    memFile = (
      await makeIn(memWs, () =>
        files.upsertFile({
          ownerId: owner,
          parentPath: 'files',
          filename: `${tag}-member-secret.txt`,
          bytes: Buffer.from('the member secret'),
        }),
      )
    ).id;
    const exportsPath = await sys(() => files.ensureAutoFiledFolder(owner, 'sandbox-exports'));
    takenFile = (
      await makeIn(memWs, () =>
        files.upsertFile({
          ownerId: owner,
          parentPath: exportsPath,
          filename: takenName,
          bytes: Buffer.from('the member export'),
        }),
      )
    ).id;
    await homeIn(takenFile, memWs);
    await sys(() =>
      c.createSandboxRow({
        id: randomUUID(),
        ownerId: owner,
        name: `${tag}-box`,
        image: 'test/image',
        status: 'running',
        containerId: 'c1',
      }),
    );
    // L's own sandbox: a login works only in the sandboxes it made (W7a fix
    // round 2), the anchor in every one.
    await sys(() =>
      c.createSandboxRow({
        id: randomUUID(),
        ownerId: owner,
        name: `${tag}-lbox`,
        image: 'test/image',
        status: 'running',
        containerId: 'c2',
        createdBy: second,
      }),
    );
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
    delete process.env.SANDBOXD_URL;
    delete process.env.SANDBOXD_TOKEN;
    delete process.env.MANTLE_MCP_TERMINAL;
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

  it('an MCP call that runs the Admin assistant (ask_responder) narrows to its scope', async () => {
    const mcp = await import('@mantle/mcp-core');
    const seen = await m.runInRequestSlot(() =>
      mcp.runInOwnerMcpScope(owner, 'ask_responder', async () => {
        const outer = m.currentScope();
        const inner = await rt.withAgentScope(
          { id: agent.id, workspaceId: adminWs },
          async () => m.currentScope(),
          { ownerLoginId: owner },
        );
        return { outer, inner };
      }),
    );
    expect(seen).toMatchObject({
      outer: { kind: 'user', loginId: owner },
      inner: { kind: 'assistant', loginId: owner, ws: [adminWs] },
    });
    expect((seen as unknown as { outer: { ws: string[] } }).outer.ws.length).toBeGreaterThan(1);
  });

  it('a turn that answers no login acts for the owner; its stamp names none', async () => {
    const seen = await rt.withAgentScope({ id: agent.id, workspaceId: adminWs }, async () => {
      const s = m.currentScope();
      return {
        login: 'loginId' in s ? s.loginId : null,
        mod: 'modWs' in s ? s.modWs : [],
        stamp: m.currentTurnStamp(),
      };
    });
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
      expect(await rt.agentTurnScoped({ workspaceId: adminWs })).toBe(false);
      const other = await mcpCall(owner, 'node_read', { node_id: privatePage });
      expect(other.isError, other.text.slice(0, 200)).toBe(false);
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
    expect(await rt.agentTurnScoped({ workspaceId: adminWs })).toBe(true);
  });
  it('H1: area tools never read another user’s private item, nor overwrite one', async () => {
    const before = {
      file: await nodeState(memFile),
      page: await nodeState(privatePage),
      ro: await nodeState(roPage),
      taken: await nodeState(takenFile),
    };
    for (const login of [second, owner]) {
      outbound.length = 0;
      const box = login === second ? `${tag}-lbox` : `${tag}-box`;
      const imp = await mcpCall(login, 'sandbox_import', {
        sandbox: box,
        file_id: memFile,
      });
      expect(imp.isError, imp.text).toBe(true);
      expect(imp.text).toMatch(/not found/);
      const copy = await mcpCall(login, 'peer_file_copy', { peer: 'any', file_id: memFile });
      expect(copy.isError, copy.text).toBe(true);
      expect(copy.text).toMatch(/not found|no file/);
      const mail = await mcpCall(login, 'email_page', {
        pageId: privatePage,
        to: 'nobody@example.invalid',
        includeLink: true,
      });
      expect(mail.isError, mail.text).toBe(true);
      expect(mail.text).toMatch(/not found/);
      // A page it reads but may not link: refused before anything is sent.
      const roMail = await mcpCall(login, 'email_page', {
        pageId: roPage,
        to: 'nobody@example.invalid',
        includeLink: true,
      });
      expect(roMail.isError, roMail.text).toBe(true);
      expect(roMail.text).toMatch(/Nothing was sent: You cannot change this item/);
      // Nothing left the box: no import, no peer, no mail transport.
      expect(outbound.filter((u) => !u.includes('embed'))).toEqual([]);
      // sandbox_export onto the member's same-named file: refused, unchanged.
      const exp = await mcpCall(login, 'sandbox_export', {
        sandbox: box,
        path: takenName,
        raw: true,
      });
      expect(exp.isError, exp.text).toBe(true);
      expect(exp.text).toMatch(/already exists/);
    }
    expect(await nodeState(memFile)).toBe(before.file);
    expect(await nodeState(privatePage)).toBe(before.page);
    expect(await nodeState(roPage)).toBe(before.ro);
    expect(await nodeState(takenFile)).toBe(before.taken);
    const files = await import('@mantle/files');
    const bytes = await sys(() => files.readFileById({ ownerId: owner, fileId: takenFile }));
    expect(bytes?.bytes.toString('utf8')).toBe('the member export');
  });

  it('M1: ask_responder’s nested Admin turn answers the calling login, with its areas', async () => {
    const mcp = await import('@mantle/mcp-core');
    const seen = await m.runInRequestSlot(() =>
      mcp.runInOwnerMcpScope(second, 'ask_responder', () =>
        // As run-sim-turn calls it: a web surface that names no login.
        rt.withAgentScope({ id: agent.id, workspaceId: adminWs }, async () => {
          const s = m.currentScope();
          return {
            login: 'loginId' in s ? s.loginId : null,
            mod: 'modWs' in s ? s.modWs : [],
            keys: await m.scopeHasArea('keys'),
            settings: await m.scopeHasArea('settings'),
            keyTool: await dispatchAs('api_key_refs', {}),
            reads: await seesNode(adminPage),
          };
        }),
      ),
    );
    expect(seen).toMatchObject({
      login: second,
      mod: [],
      keys: false,
      settings: true,
      reads: true,
    });
    const keyTool = (seen as { keyTool: { ok: boolean; error?: string } }).keyTool;
    expect(keyTool.ok).toBe(false);
    expect(keyTool.error).toMatch(/manages the brain's keys/);
    // Naming another login inside L's scope is refused (never widened).
    await expect(
      m.runInRequestSlot(() =>
        mcp.runInOwnerMcpScope(second, 'ask_responder', () =>
          rt.withAgentScope({ id: agent.id, workspaceId: adminWs }, async () => m.currentScope(), {
            loginId: owner,
          }),
        ),
      ),
    ).rejects.toThrow(/answers the login that called it/);
  });

  it('M2: update tools on a Read-only shared item are refused; on an editable one they work', async () => {
    const before = { page: await nodeState(roPage), note: await nodeState(roNote) };
    const inTurn = await inAdminTurn(
      async () => ({
        page: await dispatchAs('page_update', { id: roPage, title: 'changed' }),
        note: await dispatchAs('note_update', { id: roNote, content: 'changed' }),
        block: await dispatchAs('page_block_append', { page_id: roPage, markdown: 'added' }),
        own: await dispatchAs('page_update', { id: adminPage, title: `${tag} admin page v2` }),
      }),
      owner,
    );
    expect(inTurn.page.ok).toBe(false);
    expect(String(inTurn.page.ok ? '' : inTurn.page.error)).toMatch(/You cannot change this item/);
    expect(inTurn.note.ok).toBe(false);
    expect(inTurn.block.ok).toBe(false);
    expect(inTurn.own.ok, JSON.stringify(inTurn.own).slice(0, 200)).toBe(true);
    for (const login of [owner, second]) {
      const page = await mcpCall(login, 'page_update', { id: roPage, title: 'changed' });
      expect(page.isError, page.text).toBe(true);
      expect(page.text).toMatch(/You cannot change this item/);
      const note = await mcpCall(login, 'note_update', { id: roNote, content: 'changed' });
      expect(note.isError, note.text).toBe(true);
      expect(note.text).toMatch(/You cannot change this item/);
    }
    // The anchor moderates Admin: its own Admin page it edits on MCP.
    const own = await mcpCall(owner, 'page_update', {
      id: adminPage,
      title: `${tag} admin page v3`,
    });
    expect(own.isError, own.text.slice(0, 200)).toBe(false);
    // L reads Admin but moderates nothing: the same edit is refused.
    const notMod = await mcpCall(second, 'page_update', { id: adminPage, title: 'by L' });
    expect(notMod.isError, notMod.text).toBe(true);
    expect(await nodeState(roPage)).toBe(before.page);
    expect(await nodeState(roNote)).toBe(before.note);
  });

  it('M3: run_terminal needs the settings area', async () => {
    process.env.MANTLE_MCP_TERMINAL = '1';
    await x(sql`update workspace_users
                   set limits = ${JSON.stringify({ areas: { keys: false, settings: false } })}::jsonb
                 where workspace_id = ${adminWs} and login_id = ${second}`);
    try {
      // Since W7b a tool the scope may not call is not listed either: the
      // call is refused as an unknown tool, and the gate refuses it anyway.
      const res = await mcpCall(second, 'run_terminal', { command: 'echo w7a' }).catch(
        (err: unknown) => ({ isError: true, text: String(err) }),
      );
      expect(res.isError, res.text).toBe(true);
      expect(res.text).toMatch(/manages the brain's settings|Tool run_terminal not found/);
      const ls = await import('@mantle/mcp-core');
      const gated = (await ls.runInOwnerMcpScope(
        second,
        'run_terminal',
        async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }),
        { adminLogin: true },
      )) as { content?: { text?: string }[] };
      expect(gated.content?.map((p) => p.text).join('')).toMatch(/manages the brain's settings/);
      expect(t.toolAdminArea('run_terminal')).toBe('settings');
      expect(t.ADMIN_ONLY_TOOL_SLUGS.has('run_terminal')).toBe(true);
    } finally {
      delete process.env.MANTLE_MCP_TERMINAL;
      await x(sql`update workspace_users
                     set limits = ${JSON.stringify({ areas: { keys: false } })}::jsonb
                   where workspace_id = ${adminWs} and login_id = ${second}`);
    }
  });

  it('L1, L2, L5: extraction, preferences and unsupersede stay in the scope', async () => {
    // L1: the handler itself reads the node in the scope first.
    const fired = await inAdminTurn(
      () =>
        t
          .getBuiltin('process_extraction')!
          .handler(
            { node_id: privatePage },
            { ownerId: owner, surface: { kind: 'web', loginId: owner } },
          ),
      owner,
    );
    expect(fired.ok).toBe(false);
    expect(String(fired.ok ? '' : fired.error)).toMatch(/not found/);
    // L2: only the brain owner's row is read on the system pool
    // (profile-preferences-owner-exit.test.ts proves which exit is taken);
    // another login's row is read in the scope, where the profiles row rule
    // (0266) shows every row to a scope that holds Admin.
    await x(sql`insert into profiles (user_id, preferences) values
      (${owner}, ${JSON.stringify({ timezone: 'Europe/Berlin' })}::jsonb),
      (${mem}, ${JSON.stringify({ timezone: 'Pacific/Auckland' })}::jsonb)
      on conflict (user_id) do update set preferences = excluded.preferences`);
    const mcp = await import('@mantle/mcp-core');
    const prefs = await m.runInRequestSlot(() =>
      mcp.runInOwnerMcpScope(second, 'set_timezone', async () => ({
        owner: (await c.loadProfilePreferences(owner)).timezone,
        member: (await c.loadProfilePreferences(mem)).timezone,
      })),
    );
    expect(prefs).toEqual({ owner: 'Europe/Berlin', member: 'Pacific/Auckland' });
    // L5: a node the scope does not read is never un-superseded.
    await x(sql`update nodes set superseded_reason = 'outdated', salience = 0.3
                 where id = ${privatePage}`);
    const before = await nodeState(privatePage);
    await expect(inAdminTurn(() => c.unsupersedeNode(owner, privatePage), owner)).rejects.toThrow(
      /not found/,
    );
    expect(await nodeState(privatePage)).toBe(before);
  });
});
