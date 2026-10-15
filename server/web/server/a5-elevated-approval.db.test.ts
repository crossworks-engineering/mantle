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
 * runs leaves one audit row naming its approver. Only the model's provider
 * and the connector's remote server are stood in.
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
  session: null as unknown,
  /** The connector's remote calls (tool name, input). */
  remote: [] as Array<{ tool: string; input: Record<string, unknown> }>,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.session),
  ownerCaller: vi.fn(() => h.session),
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
  let dir = '';
  const tag = `a5ea${randomUUID().slice(0, 6)}`;
  const owner = randomUUID(); // the anchor
  const asker = randomUUID(); // an Admin user, in Team but no Moderator there
  const mod = randomUUID(); // an Admin user, a Moderator of Team
  const other = randomUUID(); // an Admin user, not in Team
  const emailOf = (login: string) => `${tag}-${login.slice(0, 8)}@example.invalid`;
  const SLUG = 'mcp_crm_update';
  let adminWs = '';
  let teamWs = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** A connector write queued for `asker` in Team, elevated. */
  const queue = async () =>
    (
      await x<{ id: string }>(sql`insert into pending_tool_calls
          (owner_id, tool_slug, args, login_id, workspace_id, elevated)
        values (${owner}, ${SLUG}, ${JSON.stringify({ id: 'c-1' })}::jsonb, ${asker}, ${teamWs},
                ${JSON.stringify({ elevated: true, reason: 'r' })}::jsonb)
        returning id::text`)
    )[0]!.id;
  const statusOf = async (id: string) =>
    (
      await x<{ s: string; error: string | null }>(
        sql`select status::text as s, error from pending_tool_calls where id = ${id}`,
      )
    )[0]!;
  const auditRows = async () => {
    await m.callAuditsSettled();
    return x<{ actor_email: string; detail: Record<string, unknown> }>(
      sql`select actor_email, detail from audit_log
           where action = 'api.write' and detail ? 'tool' order by created_at`,
    );
  };

  /** The web: PATCH /api/pending/:id signed in as `login`. */
  const web = async (login: string, id: string) => {
    h.session = {
      id: owner,
      email: emailOf(login),
      actor: { id: login, email: emailOf(login), displayName: null, isOwner: login === owner },
    };
    const route = await import('@/app/api/pending/[id]/route');
    const { appAnswerOf } = await import('./app-error');
    // As behind app.onError: a refusal of the rule is a domain error (403).
    const res = await m.runAsActor(m.loginActor(login, login === owner ? 'owner' : 'rw'), () =>
      appAnswerOf(
        route.PATCH(
          new Request('http://x/api/pending', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'approve' }),
          }),
          { params: Promise.resolve({ id }) },
        ),
        'http://x/api/pending',
        'PATCH',
      ),
    );
    return { ran: res.status === 200, status: res.status, text: await res.text() };
  };

  /** MCP: pending_approve on `login`'s own OAuth connection. */
  const mcp = async (login: string, id: string) => {
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
        c.callTool({ name: 'pending_approve', arguments: { id } }),
      )) as Reply;
      return { ran: !(r.isError ?? false), status: r.isError ? 'error' : 'ok', text: text(r) };
    } finally {
      await c.close();
    }
  };

  /** Telegram: a tap on the card, as the chat's login. */
  const telegram = async (login: string, id: string) => {
    const { telegramApprovalHandlers } = await import('@/lib/telegram-approval');
    const r = await telegramApprovalHandlers.onApproval!({
      ownerId: owner,
      loginId: login,
      decision: 'approve',
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
    delete process.env.MANTLE_ADMIN_READS;
    delete process.env.MANTLE_DETACHED_DEV;
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${emailOf(owner)}, 'x', true, 'admin', 'Owner'),
      (${asker}, ${emailOf(asker)}, 'x', false, 'admin', 'Asker'),
      (${mod}, ${emailOf(mod)}, 'x', false, 'admin', 'Mod'),
      (${other}, ${emailOf(other)}, 'x', false, 'admin', 'Other')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
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
      (${teamWs}, ${asker}, false), (${teamWs}, ${mod}, true)`);
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
    m.startCallAudit();
  }, 240_000);

  afterAll(async () => {
    m?.stopCallAudit();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    h.remote = [];
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

  it('who may reject it (A5 step 6c, L3): whoever may approve it, and its asker; nobody else', async () => {
    const { rejectPendingCall } = t;
    const reject = (login: string, id: string) =>
      m.runAsActor(m.loginActor(login, login === owner ? 'owner' : 'rw'), () =>
        rejectPendingCall(owner, id, login),
      );
    // An Admin user with write rights on the connector there: rejected.
    const byMod = await queue();
    expect(await reject(mod, byMod)).toMatchObject({ status: 'rejected' });
    expect((await statusOf(byMod)).s).toBe('rejected');
    // An Admin user without them: not found, still pending.
    const byOther = await queue();
    expect(await reject(other, byOther)).toBeNull();
    expect((await statusOf(byOther)).s).toBe('pending');
    // Its asker withdraws its own call; the owner rejects any.
    const byAsker = await queue();
    expect(await reject(asker, byAsker)).toMatchObject({ status: 'rejected' });
    expect(await reject(owner, byOther)).toMatchObject({ status: 'rejected' });
    expect(h.remote).toEqual([]);
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
