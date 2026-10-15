/**
 * The approval of an elevated pending call on a real database (A5 step 6d
 * fix round 1; owner decision 1a; docs/actors.md). A connector write a Team
 * user may not make itself (not a Moderator there) was queued for approval
 * with `elevated` set. On every path that approves (the web's
 * PATCH /api/pending/:id, MCP pending_approve on the approver's own
 * connection, a Telegram card's tap), one rule (pending-approval.ts):
 *
 *   approver                                   web    MCP    Telegram
 *   (a) its asker                              403    refused refused
 *   (b) the owner (the anchor)                 runs   runs    runs
 *   (c) another Admin user, a Moderator of
 *       Team where the connector's Write is on runs   runs    runs
 *   (d) another Admin user, not one            403    refused refused
 *
 * A refused approval leaves the call pending and runs nothing; one that
 * runs leaves one audit row naming its approver. The web path is the real
 * app with its gate middleware and a session cookie (lows round: it called
 * the route's handler before, past the middleware).
 *
 * The lows round adds the cells the A5 6d audit found untested: a call
 * queued through the real tool loop (a member's Team turn) and its card
 * routed to the owner's chat, never its asker's; reject on every path; a
 * row with no workspace (judged in Admin); a row that names no asker (the
 * owner's alone); two approvers racing (one runs); the stored result.
 * Only the model's provider, the connector's remote server and Telegram's
 * send are stood in.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a5-elevated-approval.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  /** The connector's remote calls (tool name, input). */
  remote: [] as Array<{ tool: string; input: Record<string, unknown> }>,
  /** The approval cards sent (chat id, card). */
  cards: [] as Array<{ chat: string; card: Record<string, unknown> }>,
}));

// Telegram's send: the card a queued call pushes, recorded.
vi.mock('@mantle/telegram', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  accountById: vi.fn(async (id: string) => ({ id })),
  sendApprovalCard: vi.fn(async (_a: unknown, chat: string, card: Record<string, unknown>) => {
    h.cards.push({ chat, card });
  }),
}));
// The connector's remote server.
vi.mock('../../../packages/tools/src/mcp-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpCallRemoteTool: vi.fn(
    async (_o: string, _g: string, _m: unknown, tool: string, input: Record<string, unknown>) => {
      h.remote.push({ tool, input });
      return { text: '{"updated":true}', secrets: [] };
    },
  ),
}));

type Reply = { isError?: boolean; content?: { text?: string }[] };
const text = (r: unknown) =>
  ((r as Reply | null)?.content ?? []).map((p) => p.text ?? '').join(' ');

describe.skipIf(!URL)('the approval of an elevated pending call (A5 step 6d fix round 1)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let ls: typeof import('@mantle/mcp-core');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const tag = `a5ea${randomUUID().slice(0, 6)}`;
  const owner = randomUUID(); // the anchor
  const asker = randomUUID(); // an Admin user, in Team but no Moderator there
  const mod = randomUUID(); // an Admin user, a Moderator of Team
  const other = randomUUID(); // an Admin user, not in Team
  const member = randomUUID(); // a member, in Team but no Moderator there
  const teamAgent = randomUUID();
  const emailOf = (login: string) => `${tag}-${login.slice(0, 8)}@example.invalid`;
  const SLUG = 'mcp_crm_update';
  let adminWs = '';
  let teamWs = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A connector write queued for `by` (default its asker) in `ws`
   *  (default Team), elevated. */
  const queue = async (by: string | null = asker, ws: string | null = teamWs) =>
    (
      await x<{ id: string }>(sql`insert into pending_tool_calls
          (owner_id, tool_slug, args, login_id, workspace_id, elevated)
        values (${owner}, ${SLUG}, ${JSON.stringify({ id: 'c-1' })}::jsonb, ${by}, ${ws},
                ${JSON.stringify({ elevated: true, reason: 'r' })}::jsonb)
        returning id::text`)
    )[0]!.id;
  const statusOf = async (id: string) =>
    (
      await x<{ s: string; error: string | null }>(
        sql`select status::text as s, error from pending_tool_calls where id = ${id}`,
      )
    )[0]!;
  const rowOf = async (id: string) =>
    (
      await x<{
        s: string;
        error: string | null;
        result: unknown;
        decided: boolean;
        executed: boolean;
        login: string | null;
        ws: string | null;
        elevated: unknown;
        origin: unknown;
      }>(
        sql`select status::text as s, error, result, decided_at is not null as decided,
                   executed_at is not null as executed, login_id::text as login,
                   workspace_id::text as ws, elevated, origin
              from pending_tool_calls where id = ${id}`,
      )
    )[0]!;
  const auditRows = async () => {
    await m.callAuditsSettled();
    return x<{ actor_email: string; detail: Record<string, unknown> }>(
      sql`select actor_email, detail from audit_log
           where action = 'api.write' and detail ? 'tool' order by created_at`,
    );
  };

  type Decision = 'approve' | 'reject';

  /** The web: PATCH /api/pending/:id signed in as `login`, through the real
   *  app and its gate middleware (a refusal of the rule is a domain error:
   *  403 through app.onError). */
  const web = async (login: string, id: string, decision: Decision = 'approve') => {
    const res = await app.request(`/api/pending/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieOf(login) },
      body: JSON.stringify({ decision }),
    });
    return { ran: res.status === 200, status: res.status, text: await res.text() };
  };

  /** MCP: pending_approve (or pending_reject) on `login`'s own OAuth
   *  connection. */
  const mcp = async (login: string, id: string, decision: Decision = 'approve') => {
    const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
    const { Client } = await import('@modelcontextprotocol/client');
    const prepared = await ls.prepareCallerTools({
      role: 'admin',
      anchorId: owner,
      loginId: login,
      via: 'oauth',
      write: true,
      oauthClientId: 'c1',
    });
    const server = new McpServer({ name: 'test', version: '0' });
    ls.registerPreparedTools(server, prepared);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: tag, version: '0' });
    await Promise.all([server.connect(a), c.connect(b)]);
    try {
      const r = (await m.runAsActor(m.loginActor(login, login === owner ? 'owner' : 'rw'), () =>
        c.callTool({ name: `pending_${decision}`, arguments: { id } }),
      )) as Reply;
      return { ran: !(r.isError ?? false), status: r.isError ? 'error' : 'ok', text: text(r) };
    } finally {
      await c.close();
    }
  };

  /** Telegram: a tap on the card, as the chat's login. */
  const telegram = async (login: string, id: string, decision: Decision = 'approve') => {
    const { telegramApprovalHandlers } = await import('@/lib/telegram-approval');
    const r = await telegramApprovalHandlers.onApproval!({
      ownerId: owner,
      loginId: login,
      decision,
      pendingId: id,
    });
    return { ran: r.ok, status: r.ok ? 'ok' : 'refused', text: r.text };
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a5-elevated-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a5-elevated-approval-secret-at-least-32-chars';
    delete process.env.MANTLE_ADMIN_READS;
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${emailOf(owner)}, 'x', true, 'admin', 'Owner'),
      (${asker}, ${emailOf(asker)}, 'x', false, 'admin', 'Asker'),
      (${mod}, ${emailOf(mod)}, 'x', false, 'admin', 'Mod'),
      (${other}, ${emailOf(other)}, 'x', false, 'admin', 'Other'),
      (${member}, ${emailOf(member)}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    teamWs = (
      await x<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Team`}) returning id::text`)
    )[0]!.id;
    // Three more Admin users (the settings area theirs), none a Moderator
    // of Admin; two of them in Team, one a Moderator there.
    for (const login of [asker, mod, other]) {
      await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
        values (${adminWs}, ${login}, false)
        on conflict (workspace_id, login_id) do update set moderator = false`);
    }
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${teamWs}, ${asker}, false), (${teamWs}, ${mod}, true), (${teamWs}, ${member}, false)`);
    // Team's assistant, whose turn queues the member's call.
    await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${teamAgent}, ${owner}, ${`${tag}-team`}, 'Team', 'fake/model', 'p', 'responder', ${teamWs})`);
    // A bot with a chat paired to the owner and one to the asker.
    const account = (
      await x<{ id: string }>(sql`insert into telegram_accounts (user_id, bot_username, branch_path)
        values (${owner}, ${`${tag}_bot`}, 'telegram') returning id::text`)
    )[0]!.id;
    await x(sql`insert into telegram_chats
        (account_id, user_id, telegram_chat_id, chat_type, allowlist_status, login_id) values
      (${account}, ${owner}, 'chat-owner', 'private', 'allowed', ${owner}),
      (${account}, ${owner}, 'chat-asker', 'private', 'allowed', ${asker})`);
    // The connector, a resource of Team with its Write on, and its write
    // tool, which waits for approval.
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, integration, enabled)
      values (${owner}, 'crm', 'CRM', ${`{${SLUG}}`}::text[],
              ${JSON.stringify({ mcp: { url: 'https://crm.example.test/mcp' } })}::jsonb, true)`);
    await x(sql`insert into tools (owner_id, slug, name, description, input_schema, handler,
                                   requires_confirm, enabled)
      values (${owner}, ${SLUG}, 'CRM update', 'Update a CRM record.',
              ${JSON.stringify({ type: 'object', properties: { id: { type: 'string' } } })}::jsonb,
              ${JSON.stringify({ kind: 'mcp', group: 'crm', toolName: 'update' })}::jsonb,
              true, true)`);
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${teamWs}, 'connector', 'crm', true)`);
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (login) => `mantle_session=${tokens.buildSessionCookie(login).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    m.startCallAudit();
  }, 240_000);

  afterAll(async () => {
    m?.stopCallAudit();
    const bridge = (globalThis as { __mantleRealtime?: { stop?: (() => Promise<void>) | null } })
      .__mantleRealtime;
    await bridge?.stop?.();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    h.remote = [];
    h.cards = [];
    await x(sql`delete from audit_log`);
  });

  const PATHS = { web, mcp, telegram } as const;

  for (const [name, approve] of Object.entries(PATHS)) {
    describe(`on the ${name} path`, () => {
      it('(a) its asker may not approve it: refused, still pending, nothing ran', async () => {
        const id = await queue();
        const r = await approve(asker, id);
        expect(r.ran, r.text).toBe(false);
        expect(r.text).toContain(t.ELEVATED_SELF_APPROVAL_ERROR.slice(0, 60));
        if (name === 'web') expect(r.status).toBe(403);
        expect((await statusOf(id)).s).toBe('pending');
        expect(h.remote).toEqual([]);
        expect(await auditRows()).toEqual([]);
      });

      it("(b) the owner approves it: it runs with the owner's rights, its row names the approver", async () => {
        const id = await queue();
        const r = await approve(owner, id);
        expect(r.ran, r.text).toBe(true);
        expect(await statusOf(id)).toEqual({ s: 'approved', error: null });
        expect(h.remote).toEqual([{ tool: 'update', input: { id: 'c-1' } }]);
        const rows = await auditRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.actor_email).toBe(emailOf(owner));
        expect(rows[0]!.detail).toMatchObject({ approver: owner });
      });

      it('(c) an Admin user with write rights on the connector there approves it: it runs as them', async () => {
        const id = await queue();
        const r = await approve(mod, id);
        expect(r.ran, r.text).toBe(true);
        expect(await statusOf(id)).toEqual({ s: 'approved', error: null });
        expect(h.remote).toHaveLength(1);
        const rows = await auditRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.actor_email).toBe(emailOf(mod));
        expect(rows[0]!.detail).toMatchObject({ approver: mod });
      });

      it('(d) an Admin user without write rights there: refused, still pending, nothing ran', async () => {
        const id = await queue();
        const r = await approve(other, id);
        expect(r.ran, r.text).toBe(false);
        expect(r.text).toContain(t.ELEVATED_APPROVER_ERROR.slice(0, 60));
        if (name === 'web') expect(r.status).toBe(403);
        expect((await statusOf(id)).s).toBe('pending');
        expect(h.remote).toEqual([]);
      });
    });
  }

  for (const [name, decide] of Object.entries(PATHS)) {
    it(`who may reject it on the ${name} path (A5 step 6c, 6d L3): whoever may approve it, and its asker; nobody else`, async () => {
      // An Admin user with write rights on the connector there: rejected.
      const byMod = await queue();
      expect((await decide(mod, byMod, 'reject')).ran).toBe(true);
      expect((await statusOf(byMod)).s).toBe('rejected');
      // An Admin user without them: refused, still pending.
      const byOther = await queue();
      expect((await decide(other, byOther, 'reject')).ran).toBe(false);
      expect((await statusOf(byOther)).s).toBe('pending');
      // Its asker withdraws its own call; the owner rejects any.
      const byAsker = await queue();
      expect((await decide(asker, byAsker, 'reject')).ran).toBe(true);
      expect((await statusOf(byAsker)).s).toBe('rejected');
      expect((await decide(owner, byOther, 'reject')).ran).toBe(true);
      expect((await statusOf(byOther)).s).toBe('rejected');
      expect(h.remote).toEqual([]);
    });
  }

  it('a row with no workspace is judged in Admin: a Moderator of Team may not approve it, the owner may', async () => {
    // Admin holds the connector with its Write on, for this cell.
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${adminWs}, 'connector', 'crm', true)`);
    try {
      const id = await queue(asker, null);
      const r = await telegram(mod, id);
      expect(r.ran, r.text).toBe(false);
      expect(r.text).toContain(t.ELEVATED_APPROVER_ERROR.slice(0, 60));
      expect((await statusOf(id)).s).toBe('pending');
      const o = await telegram(owner, id);
      expect(o.ran, o.text).toBe(true);
      expect(await statusOf(id)).toEqual({ s: 'approved', error: null });
      expect(h.remote).toHaveLength(1);
    } finally {
      await x(sql`delete from workspace_resources
        where workspace_id = ${adminWs} and type = 'connector' and ref_id = 'crm'`);
    }
  });

  it('a row that names no asker is the owner’s alone (6d L2), on every path', async () => {
    for (const approve of Object.values(PATHS)) {
      const id = await queue(null);
      const r = await approve(mod, id);
      expect(r.ran, r.text).toBe(false);
      expect(r.text).toContain(t.ELEVATED_NO_ASKER_ERROR.slice(0, 40));
      expect((await statusOf(id)).s).toBe('pending');
      expect((await approve(owner, id)).ran).toBe(true);
      expect((await statusOf(id)).s).toBe('approved');
    }
    expect(h.remote).toHaveLength(3);
  });

  it('two approvers racing: exactly one claims it and it runs once', async () => {
    const id = await queue();
    const asLogin = (login: string) =>
      m.runAsActor(m.loginActor(login, login === owner ? 'owner' : 'rw'), () =>
        t.approvePendingCall(owner, id, { approverLoginId: login }),
      );
    const [a, b] = await Promise.all([asLogin(owner), asLogin(mod)]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    // The summary names its asker (lows round: a screen hides Approve for it).
    expect((a ?? b)!.loginId).toBe(asker);
    expect((await statusOf(id)).s).toBe('approved');
    expect(h.remote).toHaveLength(1);
    expect(await auditRows()).toHaveLength(1);
  });

  it('an approved call stores its result: the output, when it ran, no error', async () => {
    const id = await queue();
    expect((await mcp(mod, id)).ran).toBe(true);
    expect(await rowOf(id)).toMatchObject({
      s: 'approved',
      error: null,
      result: { updated: true },
      decided: true,
      executed: true,
    });
  });

  it("a member's connector write queued by the real tool loop: elevated, stamped, its card to the owner's chat; a Moderator of Team runs it", async () => {
    const rt = await import('@mantle/runtime/agent');
    const tracing = await import('@mantle/tracing');
    const ex = await import('../../../packages/runtime/src/agent/tool-loop/execute-call');
    const row = await m.asSystem(() => t.resolveTool(owner, SLUG), 'test');
    const input = { id: 'c-queued' };
    const pendingIds: string[] = [];
    await m.runAsActor(m.loginActor(member, 'rw'), () =>
      rt.withAgentScope(
        { id: teamAgent, ownerId: owner, workspaceId: teamWs, role: 'responder' },
        () =>
          tracing.startTrace(
            { kind: 'responder_turn', ownerId: owner, agentId: teamAgent, loginId: member },
            () =>
              ex.executeToolCall({
                args: {
                  ownerId: owner,
                  agentId: teamAgent,
                  agentSlug: `${tag}-team`,
                  surface: { kind: 'team', loginId: member },
                } as never,
                slug: SLUG,
                call: { id: 'call-q', function: { name: SLUG, arguments: JSON.stringify(input) } },
                tool: row!,
                input,
                argParseError: null,
                argValidation: null,
                argValidationMode: 'off',
                lastUserMessage: undefined,
                pendingIds,
              }),
          ),
        { loginId: member },
      ),
    );
    expect(pendingIds).toHaveLength(1);
    const id = pendingIds[0]!;
    const queued = await rowOf(id);
    expect(queued).toMatchObject({ s: 'pending', login: member, ws: teamWs });
    expect(queued.elevated).toMatchObject({ elevated: true });
    expect(queued.origin).toMatchObject({ surface: { kind: 'team', loginId: member } });
    // The card goes to the owner's chat, never its asker's, with the reason.
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    expect(h.cards[0]!.chat).toBe('chat-owner');
    expect(h.cards[0]!.card).toMatchObject({ pendingId: id, toolSlug: SLUG });
    expect(typeof h.cards[0]!.card['elevated']).toBe('string');
    // Its asker may not approve it; a Moderator of Team does, and it runs.
    expect((await web(member, id)).ran).toBe(false);
    const r = await web(mod, id);
    expect(r.ran, r.text).toBe(true);
    expect(h.remote).toEqual([{ tool: 'update', input }]);
  });

  it("a call that is not elevated keeps main's rule: its asker approves its own", async () => {
    const id = (
      await x<{ id: string }>(sql`insert into pending_tool_calls
          (owner_id, tool_slug, args, login_id, workspace_id)
        values (${owner}, ${SLUG}, '{}'::jsonb, ${mod}, ${teamWs}) returning id::text`)
    )[0]!.id;
    const r = await telegram(mod, id);
    expect(r.ran, r.text).toBe(true);
    expect((await statusOf(id)).s).toBe('approved');
    // Another login's call it may not decide: not found, as before.
    const theirs = await queue();
    await x(sql`update pending_tool_calls set elevated = null where id = ${theirs}`);
    expect((await telegram(other, theirs)).ran).toBe(false);
    expect((await statusOf(theirs)).s).toBe('pending');
  });
});
