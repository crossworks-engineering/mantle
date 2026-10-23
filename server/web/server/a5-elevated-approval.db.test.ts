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
 *
 * The second lows round (lows-approvals-2) adds: racing approvers held at a
 * barrier after the approval rule (or the re-check) judged them, so both
 * reach the claim (L2), for an elevated row and a stamped one; a stamped
 * call queued by the real tool loop whose surface names another login than
 * its asker, refused with the login error (L3); a member's MCP turn whose
 * call, approved, still spends nothing on the owner's keys and keeps its
 * connection's id (L3, L7), stamped or elevated (L6). The surface each
 * approved call ran on is recorded at its dispatch.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a5-elevated-approval.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  /** The connector's remote calls (tool name, input). */
  remote: [] as Array<{ tool: string; input: Record<string, unknown> }>,
  /** The approval cards sent (chat id, card). */
  cards: [] as Array<{ chat: string; card: Record<string, unknown> }>,
  /** The surface each approved call was dispatched on. */
  surfaces: [] as unknown[],
  /** Racing approvers held after the rule judged them (lows round 2, L2):
   *  each waits until `n` arrived (or 10 s), so all reach the claim. */
  barrier: null as null | { n: number; arrived: number; release: Array<() => void> },
  arrive: async () => {
    const b = h.barrier;
    if (!b) return;
    b.arrived += 1;
    if (b.arrived >= b.n) {
      for (const r of b.release.splice(0)) r();
      return;
    }
    await new Promise<void>((resolve) => {
      b.release.push(resolve);
      setTimeout(resolve, 10_000);
    });
  },
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

// The dispatch an approval runs its call through: the surface, recorded.
vi.mock('../../../packages/tools/src/dispatch-bridge', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/tools/src/dispatch-bridge')>();
  return {
    ...real,
    dispatchViaBridge: ((tool, input, ctx) => {
      h.surfaces.push(ctx.surface);
      return real.dispatchViaBridge(tool, input, ctx);
    }) as typeof real.dispatchViaBridge,
  };
});
// The approval rule and the re-check, each held at the barrier after it
// judged (lows round 2, L2), so racing approvers both reach the claim.
vi.mock('../../../packages/tools/src/pending-approval', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../packages/tools/src/pending-approval')>();
  return {
    ...real,
    elevatedApproval: (async (...a: Parameters<typeof real.elevatedApproval>) => {
      const run = await real.elevatedApproval(...a);
      await h.arrive();
      return run;
    }) as typeof real.elevatedApproval,
    originApproval: (async (...a: Parameters<typeof real.originApproval>) => {
      const run = await real.originApproval(...a);
      await h.arrive();
      return run;
    }) as typeof real.originApproval,
  };
});

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
  const memberMod = randomUUID(); // a member, a Moderator of Team, not in Admin
  const teamAgent = randomUUID();
  const emailOf = (login: string) => `${tag}-${login.slice(0, 8)}@example.invalid`;
  const SLUG = 'mcp_crm_update';
  let adminWs = '';
  let teamWs = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A fixture write to the workspace tables, as the superuser: the app
   *  pools only read them. */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

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
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    await asSuperuser()(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${emailOf(owner)}, 'x', true, 'admin', 'Owner'),
      (${asker}, ${emailOf(asker)}, 'x', false, 'admin', 'Asker'),
      (${mod}, ${emailOf(mod)}, 'x', false, 'admin', 'Mod'),
      (${other}, ${emailOf(other)}, 'x', false, 'admin', 'Other'),
      (${member}, ${emailOf(member)}, 'x', false, 'member', 'Member'),
      (${memberMod}, ${emailOf(memberMod)}, 'x', false, 'member', 'Member Mod')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    teamWs = (
      await su<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${owner}, ${`${tag} Team`}) returning id::text`)
    )[0]!.id;
    // Three more Admin users (the settings area theirs), none a Moderator
    // of Admin; two of them in Team, one a Moderator there.
    for (const login of [asker, mod, other]) {
      await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
        values (${adminWs}, ${login}, false)
        on conflict (workspace_id, login_id) do update set moderator = false`);
    }
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${teamWs}, ${asker}, false), (${teamWs}, ${mod}, true), (${teamWs}, ${member}, false),
      (${teamWs}, ${memberMod}, true)`);
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
    await su(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
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
    h.surfaces = [];
    h.barrier = null;
    // The audit rows of the test before are written after its answer
    // (call-audit.ts): wait for them, or one lands after this delete and is
    // counted as the next test's (a flake on CI: two rows where one ran).
    await m.callAuditsSettled();
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
    await su(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
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
      await su(sql`delete from workspace_resources
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

  /** `login` approves `id` on the shared approval path, as its actor. */
  const approveAs = (login: string, id: string) =>
    m.runAsActor(m.loginActor(login, login === owner ? 'owner' : 'rw'), () =>
      t.approvePendingCall(owner, id, { approverLoginId: login }),
    );

  it('two approvers racing: exactly one claims it and it runs once', async () => {
    const id = await queue();
    // Both held after the rule judged them (lows round 2, L2): both reach
    // the claim, so the claim alone decides (before: one could finish
    // before the other started, and the test passed without overlap).
    h.barrier = { n: 2, arrived: 0, release: [] };
    const [a, b] = await Promise.all([approveAs(owner, id), approveAs(mod, id)]);
    expect(h.barrier.arrived).toBe(2);
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

  /** A call of the connector write queued by the real tool loop in a Team
   *  turn of `login` (its scope's login), on `surface`; its pending id. */
  const queueByTurn = async (login: string, surface: unknown, input: Record<string, unknown>) => {
    const rt = await import('@mantle/runtime/agent');
    const tracing = await import('@mantle/tracing');
    const ex = await import('../../../packages/runtime/src/agent/tool-loop/execute-call');
    const row = await m.asSystem(() => t.resolveTool(owner, SLUG), 'test');
    const pendingIds: string[] = [];
    const res = await m.runAsActor(m.loginActor(login, 'rw'), () =>
      rt.withAgentScope(
        { id: teamAgent, ownerId: owner, workspaceId: teamWs, role: 'responder' },
        () =>
          tracing.startTrace(
            { kind: 'responder_turn', ownerId: owner, agentId: teamAgent, loginId: login },
            () =>
              ex.executeToolCall({
                args: {
                  ownerId: owner,
                  agentId: teamAgent,
                  agentSlug: `${tag}-team`,
                  surface,
                } as never,
                slug: SLUG,
                call: { id: `call-${randomUUID()}`, function: { name: SLUG, arguments: '{}' } },
                tool: row!,
                input,
                argParseError: null,
                argValidation: null,
                argValidationMode: 'off',
                lastUserMessage: undefined,
                pendingIds,
              }),
          ),
        { loginId: login },
      ),
    );
    expect(pendingIds, JSON.stringify(res)).toHaveLength(1);
    return pendingIds[0]!;
  };

  it('lows round 2, L2: two approvers racing on a stamped call, both held after the re-check: one claims it, it runs once', async () => {
    // A Moderator of Team's own call, queued by the real tool loop: not
    // elevated, stamped. The owner and its asker both may decide it.
    const id = await queueByTurn(mod, { kind: 'team', loginId: mod }, { id: 'c-race' });
    const queued = await rowOf(id);
    expect(queued).toMatchObject({ s: 'pending', login: mod, elevated: null });
    expect(queued.origin).toMatchObject({ surface: { kind: 'team', loginId: mod } });
    h.barrier = { n: 2, arrived: 0, release: [] };
    const [a, b] = await Promise.all([approveAs(owner, id), approveAs(mod, id)]);
    expect(h.barrier.arrived).toBe(2);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect((await statusOf(id)).s).toBe('approved');
    expect(h.remote).toEqual([{ tool: 'update', input: { id: 'c-race' } }]);
    expect(await auditRows()).toHaveLength(1);
  });

  it('lows round 2, L3: a stamped call queued by the real tool loop whose surface names another login than its asker: refused with the login error, left pending, nothing ran', async () => {
    // The stamp's surface and its row's asker agree: it runs as its asker.
    const ok = await queueByTurn(mod, { kind: 'team', loginId: mod }, { id: 'c-agree' });
    expect((await telegram(owner, ok)).ran).toBe(true);
    expect(h.surfaces).toEqual([{ kind: 'team', loginId: mod }]);
    // A turn of mod's whose surface names the member: refused on every path.
    const id = await queueByTurn(mod, { kind: 'team', loginId: member }, { id: 'c-other' });
    expect(await rowOf(id)).toMatchObject({ s: 'pending', login: mod, elevated: null });
    for (const approve of Object.values(PATHS)) {
      const r = await approve(owner, id);
      expect(r.ran, r.text).toBe(false);
      expect(r.text).toContain(t.PENDING_SURFACE_LOGIN_ERROR.slice(0, 40));
      expect((await statusOf(id)).s).toBe('pending');
    }
    expect(h.remote).toEqual([{ tool: 'update', input: { id: 'c-agree' } }]);
  });

  /** A member's own MCP connection outside Admin, as the login surface
   *  builds it (ownerKeysOff: it spends nothing on the owner's keys). */
  const memberMcp = (login: string) => ({
    kind: 'owner',
    via: 'mcp',
    loginId: login,
    mcp: {
      via: 'oauth',
      write: true,
      role: 'member',
      oauthClientId: 'client-m',
      ownerKeysOff: true,
    },
  });

  it("lows round 2, L3 and L7: a member's MCP turn's call, approved, still spends nothing on the owner's keys and keeps its connection's id", async () => {
    const id = await queueByTurn(memberMod, memberMcp(memberMod), { id: 'c-mcp' });
    const queued = await rowOf(id);
    expect(queued).toMatchObject({ s: 'pending', login: memberMod, elevated: null });
    expect(queued.origin).toMatchObject({
      surface: { mcp: { via: 'oauth', oauthClientId: 'client-m', ownerKeysOff: true } },
    });
    const r = await telegram(owner, id);
    expect(r.ran, r.text).toBe(true);
    expect(h.surfaces).toEqual([
      {
        kind: 'owner',
        via: 'mcp',
        loginId: memberMod,
        mcp: {
          via: 'oauth',
          write: false,
          oauthClientId: 'client-m',
          ownerKeysOff: true,
          approval: true,
        },
      },
    ]);
    expect(t.ownerKeysOff({ surface: h.surfaces[0] as never })).toBe(true);
    expect(h.remote).toEqual([{ tool: 'update', input: { id: 'c-mcp' } }]);
  });

  it("lows round 2, L6: a member's MCP turn's elevated call, approved by the owner, runs on the approval's surface and still spends nothing on the owner's keys (main: it did)", async () => {
    const id = await queueByTurn(member, memberMcp(member), { id: 'c-elev' });
    expect((await rowOf(id)).elevated).toMatchObject({ elevated: true });
    const r = await telegram(owner, id);
    expect(r.ran, r.text).toBe(true);
    expect(h.surfaces).toEqual([
      { kind: 'owner', via: 'pending', loginId: owner, ownerKeysOff: true },
    ]);
    expect(t.ownerKeysOff({ surface: h.surfaces[0] as never })).toBe(true);
    expect(h.remote).toEqual([{ tool: 'update', input: { id: 'c-elev' } }]);
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
