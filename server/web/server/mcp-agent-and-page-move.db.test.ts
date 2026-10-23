/**
 * Two reports from a new brain, on its logins' MCP connections (an OAuth
 * connection each, prepareCallerTools), on a migrated scratch database:
 *
 *  - Asking an in-brain agent over MCP. `invoke_agent` is listed on the MCP
 *    surface for parity, but a delegation hands work from one agent to
 *    another inside that agent's turn: an MCP call names no agent, and the
 *    tool answered "missing parent agent context ... This is a wiring bug"
 *    to every login. It now names the tool that asks an agent from outside
 *    a turn (ask_responder), and ask_responder answers each login kind: the
 *    anchor and a second Admin user with the Admin assistant, a member with
 *    its Team's assistant (the model is a fake: no real model is called).
 *  - Moving a page into a folder of another workspace, by both move tools
 *    (page_move and tree_item_move with kind pages). The share follow-up
 *    after such a move once read node_embeds in the caller's scope, which
 *    no workspace role reads: the move committed, then the call answered a
 *    database error, and a retry by the other tool found the page already
 *    there and answered ok (fixed on main by the tree-bugs round, the
 *    follow-up runs as the system step 'tree-refold'). Both tools move a
 *    page there and answer ok, and back to the top level.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/mcp-agent-and-page-move.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
const PROVIDER = 'mcp-ask-fake';

// The agents' key: a stand-in secret (the scratch database has no sealed key).
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async () => 'sk-test'),
}));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
}));

describe.skipIf(!URL)('MCP: asking an agent, and moving a page by both tools', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let dir = '';
  const tag = `mapm${randomUUID().slice(0, 6)}`;
  const owner = randomUUID();
  const second = randomUUID(); // a second Admin user
  const member = randomUUID(); // a member: Team, its private workspace
  let adminWs = '';
  let teamWs = '';
  const adminSlug = `${tag}-admin`;
  const teamSlug = `${tag}-team`;
  /** What the fake model was asked, per call: the agent's model id. */
  const asked: string[] = [];

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

  /** One call on the login's own MCP surface (an OAuth connection). */
  const mcpCall = async (
    loginId: string,
    role: 'admin' | 'member',
    name: string,
    args: Record<string, unknown>,
  ) => {
    const ls = await import('@mantle/mcp-core');
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const server = new McpServer({ name: tag, version: '0' });
    ls.registerPreparedTools(
      server,
      await ls.prepareCallerTools({ role, anchorId: owner, loginId, via: 'oauth', write: true }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `${tag}-client`, version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const res = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content?: { text?: string }[];
      };
      return {
        isError: res.isError === true,
        text: res.content?.map((p) => p.text ?? '').join('') ?? '',
      };
    } finally {
      await client.close();
    }
  };
  const idIn = (text: string): string => {
    const hit = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text);
    if (!hit) throw new Error(`no id in ${text.slice(0, 200)}`);
    return hit[0];
  };
  const pathOf = async (id: string) =>
    (await x<{ path: string }>(sql`select path::text as path from nodes where id = ${id}`))[0]!
      .path;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'mcp-agent-move-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in this test', { status: 503 })),
    );
    m = await import('@mantle/db');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${second}, ${`${tag}-s@example.invalid`}, 'x', false, 'admin', 'Second Admin'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    // A Team every login is a user of (a Moderator there).
    teamWs = (await su<{ id: string }>(sql.raw(teamWorkspaceSql(owner))))[0]!.id;
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${second}, false) on conflict do nothing`);

    // The model: a fake provider that answers who it is, never a real call.
    const voice = await import('@mantle/voice');
    voice.registerChatAdapter({
      providerId: PROVIDER,
      adapterName: `${tag}-fake-chat`,
      chat: async (o) => {
        asked.push(o.model);
        return { text: `pong from ${o.model}`, model: o.model, tokensIn: 10, tokensOut: 3 };
      },
    });
    const [key] = await x<{ id: string }>(sql`insert into api_keys
      (user_id, service, label, key_enc) values (${owner}, 'openrouter', ${`${tag}-key`},
      decode('00', 'hex')) returning id::text`);
    const agent = async (slug: string, role: string, ws: string) => {
      const [row] = await m.systemDb
        .insert(m.agents)
        .values({
          ownerId: owner,
          slug,
          name: slug,
          provider: PROVIDER,
          model: `${slug}-model`,
          apiKeyId: key!.id,
          systemPrompt: 'Answer in one word.',
          role: role as never,
          workspaceId: ws,
          memoryConfig: { chunk_limit: 0, content_hit_limit: 0, corpus_map_limit: 0 },
        })
        .returning();
      await su(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
        values (${ws}, 'assistant', ${row!.id}, true) on conflict do nothing`);
    };
    await agent(adminSlug, 'assistant', adminWs);
    await agent(teamSlug, 'responder', teamWs);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // ── Asking an agent ───────────────────────────────────────────────────

  it('invoke_agent over MCP names ask_responder, never a wiring bug, and runs nothing', async () => {
    for (const [login, role] of [
      [owner, 'admin'],
      [member, 'member'],
    ] as const) {
      const before = asked.length;
      const res = await mcpCall(login, role, 'invoke_agent', {
        agent_slug: adminSlug,
        prompt: 'What is on my plate today?',
      });
      expect(res.isError, res.text).toBe(true);
      expect(res.text).not.toMatch(/wiring/i);
      expect(res.text).toMatch(/call ask_responder with agent_slug/);
      expect(asked.length).toBe(before);
    }
  }, 120_000);

  it('ask_responder answers the anchor and a second Admin user (the Admin assistant)', async () => {
    for (const login of [owner, second]) {
      for (const args of [{}, { agent_slug: adminSlug }, { read_only: true }]) {
        const res = await mcpCall(login, 'admin', 'ask_responder', { message: 'ping', ...args });
        expect(res.isError, res.text).toBe(false);
        const out = JSON.parse(res.text) as { reply: string; agent: { slug: string } };
        expect(out.agent.slug).toBe(adminSlug);
        expect(out.reply).toBe(`pong from ${adminSlug}-model`);
      }
    }
  }, 180_000);

  it('ask_responder answers a member with its Team assistant; the Admin one is refused in words', async () => {
    const res = await mcpCall(member, 'member', 'ask_responder', {
      message: 'ping',
      agent_slug: teamSlug,
    });
    expect(res.isError, res.text).toBe(false);
    const out = JSON.parse(res.text) as { reply: string; agent: { slug: string } };
    expect(out.agent.slug).toBe(teamSlug);
    expect(out.reply).toBe(`pong from ${teamSlug}-model`);
    // The Admin assistant answers Admin users only: refused with the reason,
    // never a wiring or server fault.
    const admin = await mcpCall(member, 'member', 'ask_responder', {
      message: 'ping',
      agent_slug: adminSlug,
    });
    expect(admin.isError, admin.text).toBe(true);
    expect(admin.text).not.toMatch(/wiring|could not run this request/i);
  }, 180_000);

  // ── Moving a page by both tools ───────────────────────────────────────

  it('page_move and tree_item_move each move a page into another workspace’s folder', async () => {
    for (const [login, role] of [
      [owner, 'admin'],
      [member, 'member'],
    ] as const) {
      const home = role === 'admin' ? adminWs : teamWs;
      const folder = idIn(
        (
          await mcpCall(login, role, 'tree_folder_create', {
            kind: 'pages',
            name: `${tag} to ${role}`,
            workspace: teamWs,
          })
        ).text,
      );
      // The member files its pages from its own private workspace.
      const pageIn = async (title: string) => {
        const made = await mcpCall(login, role, 'page_create', {
          title,
          markdown: 'Body.',
          ...(role === 'admin' ? { workspace: home } : {}),
        });
        expect(made.isError, made.text).toBe(false);
        return idIn(made.text);
      };
      const a = await pageIn(`${tag} ${role} by page_move`);
      const b = await pageIn(`${tag} ${role} by tree_item_move`);
      const into = await pathOf(folder);

      const pm = await mcpCall(login, role, 'page_move', {
        id: a,
        folder_id: folder,
        confirm: true,
      });
      expect(pm.isError, pm.text).toBe(false);
      expect(await pathOf(a)).toMatch(new RegExp(`^${into.replace(/\./g, '\\.')}\\.`));

      const tm = await mcpCall(login, role, 'tree_item_move', {
        kind: 'pages',
        item_ids: [b],
        folder_id: folder,
        confirm: true,
      });
      expect(tm.isError, tm.text).toBe(false);
      expect(await pathOf(b)).toMatch(new RegExp(`^${into.replace(/\./g, '\\.')}\\.`));

      // And back out to the top level, each by the other tool.
      const back1 = await mcpCall(login, role, 'page_move', {
        id: b,
        to_top_level: true,
        confirm: true,
      });
      expect(back1.isError, back1.text).toBe(false);
      const back2 = await mcpCall(login, role, 'tree_item_move', {
        kind: 'pages',
        item_ids: [a],
        folder_id: null,
        confirm: true,
      });
      expect(back2.isError, back2.text).toBe(false);
      for (const id of [a, b]) expect(await pathOf(id)).not.toContain(into);
    }
  }, 300_000);
});
