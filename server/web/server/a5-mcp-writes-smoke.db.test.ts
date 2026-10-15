/**
 * The owner MCP surface's writes and read-path writes on a real database,
 * with the actor check and the edit check on (workspaces arch A5 step 4
 * fix round 1, M2; docs/actors.md).
 *
 * Since step 4 every HTTP MCP call runs as the login (the gate's callActor:
 * login(rw) for a write, login(ro) for a read), never the request's
 * system(http:no-login) as before; inside the login's turn scope a write
 * goes to the write role, with the per-table edit check where the actor
 * check is on. This runs, through registerPreparedTools as /api/mcp serves
 * it, one write of each registration kind for an Admin OAuth rw login and
 * for a member rw login granted Write on the items (a builtin write and a
 * create, the hand-written folder and file writes, responder_turn_record,
 * a connector's write row), and the read tools that write on the side, as
 * login(ro): read_result in query mode (its chunks), recall_match (the
 * prompt embeddings), page_get on a page whose blocks have no ids yet (the
 * block id backfill) and app_data_query (the app's database). Each must
 * succeed where it did before step 4, and a member's write it may not make
 * must be refused, as before: an item it only reads, and a folder rename
 * with Write but not manage (the database's subtree rewrite asks manage,
 * 0282; it did on main too, run with this file). That refusal reads the one
 * mapper's words: before this round the reply carried the SQL and its
 * params (mcp-defs.ts folder_rename and file_rename caught the error and
 * replied its text). A peer read is not here: it needs
 * a second brain; its last-contact stamp is best-effort (read-tool-writes
 * .test.ts).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a5-mcp-writes-smoke.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** One vector for every text: no embedder, no network. */
const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));

/** A connector's remote server: every call it was asked to make. */
const remote = vi.hoisted(() => ({ calls: [] as { toolName: string; input: unknown }[] }));
vi.mock('../../../packages/tools/src/mcp-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpCallRemoteTool: async (
    _o: string,
    _group: string,
    _mcp: unknown,
    toolName: string,
    input: Record<string, unknown>,
  ) => {
    remote.calls.push({ toolName, input });
    return { text: JSON.stringify({ updated: 1 }), isError: false, secrets: [] };
  },
}));

type Reply = { isError?: boolean; content?: { text?: string }[] };
const text = (r: unknown) =>
  ((r as Reply | null)?.content ?? []).map((p) => p.text ?? '').join(' ');

describe.skipIf(!URL)('MCP writes and read-path writes as the login (A5 step 4, M2)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let ls: typeof import('@mantle/mcp-core');
  let content: typeof import('@mantle/content');
  let f: typeof import('@mantle/files');
  let dir = '';
  const tag = `a5mw${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const member = randomUUID();
  let adminWs = '';
  let projWs = '';
  let modWs = '';
  const ids = {
    adminNote: '',
    adminFolder: '',
    adminFile: '',
    adminPage: '',
    memberNote: '',
    roNote: '',
    memberFolder: '',
    modFolder: '',
    roFolder: '',
    memberFile: '',
    memberPage: '',
    app: '',
  };
  const results = { admin: `tr_${tag}a`, member: `tr_${tag}m` };
  const adminAgent = `${tag}-assistant`;
  const suiteMode = process.env.MANTLE_ACTOR_CHECK;

  /** A fixture only the superuser may run (a box mode, a table, a trigger):
   *  the app's pool may log in as the runtime role (arch A9). */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** Make with the create home `ws`, as the system. */
  const makeIn = <T>(ws: string, fn: () => Promise<T>): Promise<T> =>
    m.asSystem(() => m.withCreateHome({ createWs: ws, privateWs: null, quiet: true }, fn), 'test');

  /** Home `id` in `ws` alone, with or without Write for its plain users. */
  const homeIn = async (id: string, ws: string, write: boolean) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${id}, ${ws}, ${write}, true)`);
    });
  };

  const note = async (ws: string, title: string, write: boolean) => {
    const row = await makeIn(ws, () =>
      content.createNote(owner, { title: `${tag} ${title}`, content: `${title} body` }),
    );
    await homeIn(row.id, ws, write);
    return row.id;
  };
  const folder = async (ws: string, slug: string, write: boolean) => {
    const row = await makeIn(ws, () =>
      f.createFolder({ ownerId: owner, parentPath: 'files', slug: `${tag}-${slug}` }),
    );
    await homeIn(row.id, ws, write);
    return row.id;
  };
  const file = async (ws: string, name: string, write: boolean) => {
    const row = await makeIn(ws, () =>
      f.upsertFile({
        ownerId: owner,
        parentPath: 'files',
        filename: `${tag}-${name}.txt`,
        bytes: Buffer.from(`${name} bytes`),
      }),
    );
    await homeIn(row.id, ws, write);
    return row.id;
  };
  /** A page whose blocks have no ids yet (made before block ids). */
  const legacyPage = async (ws: string, title: string, write: boolean) => {
    const row = await makeIn(ws, () => content.createPage(owner, { title: `${tag} ${title}` }));
    await homeIn(row.id, ws, write);
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `${title} words` }] }],
    };
    await x(sql`update pages set doc = ${JSON.stringify(doc)}::jsonb where node_id = ${row.id}`);
    return row.id;
  };
  const blockIds = async (page: string) =>
    (
      await x<{ id: string | null }>(
        sql`select doc #>> '{content,0,attrs,id}' as id from pages where node_id = ${page}`,
      )
    )[0]?.id ?? null;
  const settle = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 50 && !(await done()); i += 1) {
      await new Promise((ok) => setTimeout(ok, 100));
    }
    return done();
  };

  /** A published app with MCP access on, homed in `ws`, that nobody used. */
  const app = async (ws: string): Promise<string> => {
    const id = randomUUID();
    const schema = {
      schemaSql: 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT);',
      schemaVersion: 1,
    };
    const build = JSON.stringify({
      storageKey: 'attachments/aa/bb/test',
      sha256: 'test',
      builtAt: '2026-10-14T00:00:00.000Z',
      esbuildVersion: 'test',
      bytes: 1,
      ok: true,
    });
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${id}, ${owner}, 'app', ${`${tag} app`}, 'apps')`);
    await x(sql`insert into apps (node_id, manifest, published_build, mcp_access)
      values (${id}, ${JSON.stringify({ sqlite: schema })}::jsonb, ${build}::jsonb, true)`);
    await homeIn(id, ws, false);
    return id;
  };

  /** An MCP client on the one surface for a login, as /api/mcp serves it. */
  const connect = async (role: 'admin' | 'member', loginId: string) => {
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const prepared = await ls.prepareCallerTools({
      role,
      anchorId: owner,
      loginId,
      via: 'oauth',
      write: true,
    });
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(server, prepared);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: tag, version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    const listed = new Set((await c.listTools()).tools.map((t) => t.name));
    const call = async (name: string, args: Record<string, unknown>) => {
      expect(listed.has(name), `${name} is listed`).toBe(true);
      const r = (await c.callTool({ name, arguments: args }).catch((err: unknown) => ({
        isError: true,
        content: [{ text: `protocol: ${String(err)}` }],
      }))) as Reply;
      return { ok: !(r.isError ?? false), text: text(r) };
    };
    return { call, close: () => c.close() };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a5-mcp-writes-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_DETACHED_DEV;
    delete process.env.MANTLE_ADMIN_READS;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline', { status: 503 })),
    );
    m = await import('@mantle/db');
    ls = await import('@mantle/mcp-core');
    content = await import('@mantle/content');
    f = await import('@mantle/files');
    content.registerRecallEmbedder(async (_o, texts) => texts.map(() => VEC));
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    const [admin] = await x<{ id: string }>(sql`
      select id::text from workspaces where owner_id = ${owner} and is_admin`);
    adminWs = admin!.id;
    const ws = async (name: string) =>
      (
        await x<{ id: string }>(sql`
          insert into workspaces (owner_id, name) values (${owner}, ${`${tag} ${name}`})
          returning id::text`)
      )[0]!.id;
    projWs = await ws('Proj');
    modWs = await ws('Mod');
    // The member: a plain user of Proj (Write on the items granted it), a
    // Moderator of Mod (the connector's workspace), with a private one.
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${projWs}, ${member}, false), (${modWs}, ${member}, true)
      on conflict (workspace_id, login_id) do update set moderator = excluded.moderator`);
    await x(sql`select "public"."mantle_ws_private_workspace"(${member}::uuid)`);
    await m.asSystem(() => f.ensureFilesRootBranch(owner), 'test');

    ids.adminNote = await note(adminWs, 'admin note', true);
    ids.adminFolder = await folder(adminWs, 'admin-folder', true);
    ids.adminFile = await file(adminWs, 'admin-file', true);
    ids.adminPage = await legacyPage(adminWs, 'admin page', true);
    ids.memberNote = await note(projWs, 'member note', true);
    ids.roNote = await note(projWs, 'read only note', false);
    ids.memberFolder = await folder(projWs, 'member-folder', true);
    ids.modFolder = await folder(modWs, 'mod-folder', false);
    ids.roFolder = await folder(projWs, 'ro-folder', false);
    ids.memberFile = await file(projWs, 'member-file', true);
    ids.memberPage = await legacyPage(projWs, 'member page', true);
    ids.app = await app(projWs);

    // Two spilled tool results: an Admin one (no login, no workspace) and
    // the member's own, in Proj.
    const body = Array.from({ length: 40 }, (_, i) => `line ${i} of ${tag}`).join('\n');
    await x(sql`insert into tool_results (id, owner_id, tool_slug, content, bytes)
      values (${results.admin}, ${owner}, 'web_fetch', ${body}, ${body.length})`);
    await x(sql`insert into tool_results (id, owner_id, tool_slug, content, bytes, workspace_id, login_id)
      values (${results.member}, ${owner}, 'web_fetch', ${body}, ${body.length}, ${projWs}, ${member})`);

    // The Admin assistant, for responder_turn_record.
    const [agent] = await m.systemDb
      .insert(m.agents)
      .values({
        ownerId: owner,
        slug: adminAgent,
        name: adminAgent,
        model: 'test/model',
        systemPrompt: 'p',
        role: 'assistant' as never,
        workspaceId: adminWs,
        memoryConfig: { chunk_limit: 0, content_hit_limit: 0, corpus_map_limit: 0 },
      })
      .returning();
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${adminWs}, 'assistant', ${agent!.id}, true) on conflict do nothing`);

    // A connector of Mod with one write tool (unmarked: a write).
    await m.systemDb.insert(m.toolGroups).values({
      ownerId: owner,
      slug: 'mcp-crm',
      name: 'CRM',
      toolSlugs: ['mcp_crm_contacts_update'],
      integration: { mcp: { url: 'https://example.invalid/mcp' } } as never,
      enabled: true,
    });
    await m.systemDb.insert(m.tools).values({
      ownerId: owner,
      slug: 'mcp_crm_contacts_update',
      name: 'contacts_update',
      description: 'Update a CRM contact.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      handler: { kind: 'mcp', group: 'mcp-crm', toolName: 'contacts_update' },
      requiresConfirm: false,
      enabled: true,
    } as never);
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${modWs}, 'connector', 'mcp-crm', true) on conflict do nothing`);

    // The box's checks on, as an operator switches them, and this process's.
    process.env.MANTLE_ACTOR_CHECK = 'on';
    await su(sql`select mantle_set_actor_check('on')`);
    await su(sql`select mantle_set_edit_check('on')`);
    m.takeActorMisses();
  }, 240_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('an Admin OAuth rw login: each kind of write, and the reads that write on the side', async () => {
    const c = await connect('admin', owner);
    try {
      // A builtin create and a builtin write.
      const made = await c.call('note_create', { title: `${tag} made by admin`, content: 'x' });
      expect(made.ok, made.text).toBe(true);
      const upd = await c.call('note_update', { id: ids.adminNote, content: 'changed by admin' });
      expect(upd.ok, upd.text).toBe(true);
      // The hand-written definitions.
      const ren = await c.call('folder_rename', {
        folder_id: ids.adminFolder,
        new_name: `${tag}-admin-renamed`,
      });
      expect(ren.ok, ren.text).toBe(true);
      const desc = await c.call('folder_describe', {
        folder_id: ids.adminFolder,
        description: 'described by admin',
      });
      expect(desc.ok, desc.text).toBe(true);
      const fren = await c.call('file_rename', {
        file_id: ids.adminFile,
        new_stem: `${tag}-admin-file-renamed`,
      });
      expect(fren.ok, fren.text).toBe(true);
      const rec = await c.call('responder_turn_record', {
        message: `${tag} asked over MCP`,
        reply: 'answered over MCP',
        model: 'test-model',
        agent_slug: adminAgent,
      });
      expect(rec.ok, rec.text).toBe(true);

      // The reads (login(ro)) and their side writes.
      const rr = await c.call('read_result', { handle: results.admin, query: 'line 3' });
      expect(rr.ok, rr.text).toBe(true);
      const [chunked] = await x<{ chunked: boolean; n: number }>(sql`
        select chunked, (select count(*)::int from tool_result_chunks where result_id = ${results.admin}) as n
          from tool_results where id = ${results.admin}`);
      expect(chunked).toMatchObject({ chunked: true });
      expect(chunked!.n).toBeGreaterThan(0);

      const pg = await c.call('page_get', { id: ids.adminPage });
      expect(pg.ok, pg.text).toBe(true);
      expect(await settle(async () => (await blockIds(ids.adminPage)) !== null)).toBe(true);

      // A Recall map with one prompt whose vector is missing, published.
      const map = await c.call('recall_map_create', {
        title: `${tag} map`,
        enter_when: 'Testing the A5 smoke',
      });
      expect(map.ok, map.text).toBe(true);
      const slug = (JSON.parse(map.text) as { map: string }).map;
      const card = await c.call('recall_card_put', {
        map: slug,
        title: `${tag} prompt`,
        body: 'a prompt body',
        use_when: 'When the smoke test asks',
      });
      expect(card.ok, card.text).toBe(true);
      await x(sql`update recall_nodes set kind = 'prompt', prompt_pending = false, embedding = null
        where title = ${`${tag} prompt`}`);
      await x(sql`update recall_maps set published = true where slug = ${slug}`);
      const match = await c.call('recall_match', { need: 'the smoke test asks' });
      expect(match.ok, match.text).toBe(true);
      const embedded = async () =>
        (
          await x<{ n: number }>(sql`select count(*)::int as n from recall_nodes
            where title = ${`${tag} prompt`} and embedding is not null`)
        )[0]!.n === 1;
      expect(await settle(embedded)).toBe(true);
    } finally {
      await c.close();
    }
    const [n] = await x<{ title: string; data: string }>(
      sql`select title, data::text from nodes where id = ${ids.adminNote}`,
    );
    expect(n!.data).toContain('changed by admin');
    expect(m.takeActorMisses()).toEqual([]);
  });

  it('a member rw login with Write granted: each kind of write; the reads that write on the side', async () => {
    const c = await connect('member', member);
    try {
      const made = await c.call('note_create', { title: `${tag} made by member`, content: 'x' });
      expect(made.ok, made.text).toBe(true);
      const upd = await c.call('note_update', { id: ids.memberNote, content: 'changed by member' });
      expect(upd.ok, upd.text).toBe(true);
      // A rename moves the folder's subtree: the database asks manage of it
      // (0282), so a Moderator renames; Write on the folder describes it.
      const ren = await c.call('folder_rename', {
        folder_id: ids.modFolder,
        new_name: `${tag}-member-renamed`,
      });
      expect(ren.ok, ren.text).toBe(true);
      const desc = await c.call('folder_describe', {
        folder_id: ids.memberFolder,
        description: 'described by member',
      });
      expect(desc.ok, desc.text).toBe(true);
      const fren = await c.call('file_rename', {
        file_id: ids.memberFile,
        new_stem: `${tag}-member-file-renamed`,
      });
      expect(fren.ok, fren.text).toBe(true);
      remote.calls.length = 0;
      const conn = await c.call('mcp_crm_contacts_update', { q: 'ada' });
      expect(conn.ok, conn.text).toBe(true);
      expect(remote.calls).toEqual([{ toolName: 'contacts_update', input: { q: 'ada' } }]);

      // The reads (login(ro)) and their side writes.
      const rr = await c.call('read_result', { handle: results.member, query: 'line 3' });
      expect(rr.ok, rr.text).toBe(true);
      const [chunked] = await x<{ chunked: boolean }>(
        sql`select chunked from tool_results where id = ${results.member}`,
      );
      expect(chunked).toEqual({ chunked: true });
      const pg = await c.call('page_get', { id: ids.memberPage });
      expect(pg.ok, pg.text).toBe(true);
      expect(await settle(async () => (await blockIds(ids.memberPage)) !== null)).toBe(true);
      const match = await c.call('recall_match', { need: 'anything at all' });
      expect(match.ok, match.text).toBe(true);
      const q = await c.call('app_data_query', {
        app_id: ids.app,
        sql: 'select count(*) as n from items',
      });
      expect(q.ok, q.text).toBe(true);
    } finally {
      await c.close();
    }
    expect(m.takeActorMisses()).toEqual([]);
  });

  it('a member’s write it may not make is refused, as before; nothing changes', async () => {
    const before = await x<{ title: string; path: string; data: string }>(sql`
      select title, path::text, data::text from nodes
       where id in (${ids.roNote}, ${ids.roFolder}, ${ids.memberFolder}) order by id`);
    const c = await connect('member', member);
    try {
      const upd = await c.call('note_update', { id: ids.roNote, content: 'not allowed' });
      expect(upd.ok, upd.text).toBe(false);
      expect(upd.text).toMatch(/You cannot change this item in your workspaces/);
      const ren = await c.call('folder_rename', {
        folder_id: ids.roFolder,
        new_name: `${tag}-not-allowed`,
      });
      expect(ren.ok, ren.text).toBe(false);
      expect(ren.text).toMatch(/You cannot change this item in your workspaces/);
      // Write without manage: the database refuses the rename (0282), as it
      // did before step 4, in the one mapper's words, never the SQL.
      const moved = await c.call('folder_rename', {
        folder_id: ids.memberFolder,
        new_name: `${tag}-write-only`,
      });
      expect(moved.ok, moved.text).toBe(false);
      expect(moved.text).toMatch(/^folder_rename failed: /);
      expect(moved.text).not.toMatch(/Failed query|params:|mantle_subtree|ltree/);
    } finally {
      await c.close();
    }
    const after = await x<{ title: string; path: string; data: string }>(sql`
      select title, path::text, data::text from nodes
       where id in (${ids.roNote}, ${ids.roFolder}, ${ids.memberFolder}) order by id`);
    expect(after).toEqual(before);
    m.takeActorMisses();
  });
});
