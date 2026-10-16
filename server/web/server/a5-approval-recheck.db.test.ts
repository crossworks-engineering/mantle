/**
 * The approval re-check on a real database (workspaces arch A5 step 6c;
 * docs/actors.md). Record, move, compare: every cell of the matrix below
 * was recorded on main (a5-approval-recheck.main.json) before the re-check
 * existed; each cell the step changed is named in
 * a5-approval-recheck.changes.json with its new answer and the reason. A
 * cell that differs from main and is not named there fails, and so does a
 * named change that no longer happens.
 *
 * Each cell queues a call through the REAL queue path (the tool loop's
 * executeToolCall in a Team assistant's turn, through the gate's queue-time
 * check), changes the asker's rights, then approves it on one path:
 *
 *   askers     an Admin user who moderates Team, a member who moderates
 *              Team, a member who does not (its connector write queues
 *              elevated: 6d's rule, unchanged)
 *   approvers  the owner, the asker itself, another Admin user
 *   paths      web (PATCH /api/pending/:id through the real app and its
 *              gate middleware, a session cookie), MCP pending_approve on
 *              the approver's own OAuth connection, a Telegram card's tap,
 *              a batch (approvePendingCall from no scope)
 *   rights     none, lost workspace (out of Team), lost moderator, lost
 *              item (the note homed elsewhere; the connector no longer
 *              Team's), gained (a Moderator of another workspace too, and an
 *              Admin user a Moderator of Admin)
 *   tools      a connector write (requires_confirm), note_update (its row
 *              set to requires_confirm)
 *
 * What a cell records: the path's answer, the row's status and error after,
 * and for a call that ran the scope it ran in (the connector's remote call
 * reads it) or whether the note changed. Only the model's provider (none is
 * called), the embedder and the connector's remote server are stood in. No
 * owner session is minted on a real brain: the logins are rows of a
 * scratch database.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/a5-approval-recheck.db.test.ts
 *   A5_RECHECK_RECORD=main …   writes a5-approval-recheck.main.json (on main only)
 *   A5_RECHECK_RECORD=now …    writes a5-approval-recheck.now.json (to name changes)
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_URL = process.env.MANTLE_TEST_DATABASE_URL;
/** `main`: write the main file (on main only); `now`: write what this tree
 *  answers beside it, to name the changes from (never checked in). */
const RECORD = process.env.A5_RECHECK_RECORD;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_FILE = path.join(HERE, 'a5-approval-recheck.main.json');
const CHANGES_FILE = path.join(HERE, 'a5-approval-recheck.changes.json');

const h = vi.hoisted(() => ({
  /** The connector's remote calls: the scope and actor each ran in. */
  remote: [] as Array<{ scope: unknown; actor: unknown }>,
}));

const VEC = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
vi.mock('@mantle/embeddings', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  embed: vi.fn(async () => VEC),
  embedBatch: vi.fn(async (_o: string, texts: unknown[]) => texts.map(() => VEC)),
}));
// The connector's remote server: records where the call ran.
vi.mock('../../../packages/tools/src/mcp-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpCallRemoteTool: vi.fn(async () => {
    const viewer = await import('@mantle/db/viewer');
    const db = await import('@mantle/db');
    // The remote call runs on the system pool (asSystem 'connector-call'):
    // the scope it left, and the actor the gate bound for the call.
    h.remote.push({
      scope: viewer.scopeLeftForSystem() ?? viewer.currentWorkspaceScope(),
      actor: db.currentCaller()?.actor ?? null,
    });
    return { text: '{"updated":true}', secrets: [] };
  }),
}));

type Reply = { isError?: boolean; content?: { text?: string }[] };
const text = (r: unknown) =>
  ((r as Reply | null)?.content ?? []).map((p) => p.text ?? '').join(' ');

const ASKERS = ['adminUser', 'member', 'memberPlain'] as const;
const APPROVERS = ['owner', 'self', 'other'] as const;
const PATHS = ['web', 'mcp', 'telegram', 'batch'] as const;
const RIGHTS = ['none', 'lostWorkspace', 'lostModerator', 'lostItem', 'gained'] as const;
const TOOLS = ['connector', 'note'] as const;

describe.skipIf(!DB_URL)('the approval re-check (A5 step 6c): the recorded matrix', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  /** The suite's own actor check mode, put back after (checks on below). */
  let suiteMode: string | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let ls: typeof import('@mantle/mcp-core');
  let rt: typeof import('@mantle/runtime/agent');
  let tracing: typeof import('@mantle/tracing');
  let ex: typeof import('../../../packages/runtime/src/agent/tool-loop/execute-call');
  let app: import('hono').Hono;
  let cookieOf: (id: string) => string;
  let dir = '';
  const tag = `a5rc${randomUUID().slice(0, 6)}`;
  const id = {
    owner: randomUUID(),
    adminUser: randomUUID(),
    member: randomUUID(),
    memberPlain: randomUUID(),
    other: randomUUID(),
  };
  const emailOf = (login: string) => `${tag}-${login.slice(0, 8)}@example.invalid`;
  const SLUG = 'mcp_crm_update';
  const teamAgent = randomUUID();
  let adminWs = '';
  let teamWs = '';
  let elseWs = '';
  let noteId = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  /** The workspaces the matrix does not make itself (a login's private
   *  workspace, the brain's own), by id: read before a cell is named. */
  const privateOf = new Map<string, string>();
  const readPrivate = async () => {
    for (const r of await x<{ ws: string; login: string }>(
      sql`select workspace_id::text as ws, login_id::text as login from private_workspaces`,
    )) {
      privateOf.set(r.ws, `private:${label(r.login)}`);
    }
    // Any other workspace (the brain's built-in Team, made with the brain)
    // by its name.
    for (const r of await x<{ ws: string; name: string }>(
      sql`select id::text as ws, name from workspaces where owner_id = ${id.owner}`,
    )) {
      if (!privateOf.has(r.ws)) privateOf.set(r.ws, `ws:${r.name.replace(tag, '').trim()}`);
    }
  };

  /** A uuid as the matrix names it. */
  const label = (v: unknown): string => {
    const s = String(v ?? '').toLowerCase();
    for (const [k, u] of Object.entries(id)) if (u === s) return k;
    if (s === adminWs) return 'admin';
    if (s === teamWs) return 'team';
    if (s === elseWs) return 'else';
    if (s === noteId) return 'note';
    const own = privateOf.get(s);
    return own ?? s;
  };
  /** A text with its ids named and its dashes plain, cut short. */
  const short = (s: string | null | undefined) =>
    s == null
      ? null
      : s
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) =>
            label(u),
          )
          // A product text's dash, written plain in the recorded files.
          .replace(/[\u2013\u2014]/g, '-')
          .slice(0, 90);

  /** Queue `tool` for `asker` in a Team assistant turn, through the tool
   *  loop's own queue path. The pending row's id. */
  const queue = async (asker: (typeof ASKERS)[number], tool: (typeof TOOLS)[number], n: string) => {
    const login = id[asker];
    const slug = tool === 'connector' ? SLUG : 'note_update';
    const input =
      tool === 'connector' ? { id: `c-${n}` } : { id: noteId, content: `changed in cell ${n}` };
    const row = await m.asSystem(() => t.resolveTool(id.owner, slug), 'test');
    const surface =
      asker === 'adminUser' ? { kind: 'web', loginId: login } : { kind: 'team', loginId: login };
    const pendingIds: string[] = [];
    const res = await m.runAsActor(m.loginActor(login, 'rw'), () =>
      rt.withAgentScope(
        { id: teamAgent, ownerId: id.owner, workspaceId: teamWs, role: 'responder' },
        () =>
          tracing.startTrace(
            { kind: 'responder_turn', ownerId: id.owner, agentId: teamAgent, loginId: login },
            () =>
              ex.executeToolCall({
                args: {
                  ownerId: id.owner,
                  agentId: teamAgent,
                  agentSlug: `${tag}-team`,
                  surface,
                } as never,
                slug,
                call: {
                  id: `call-${n}`,
                  function: { name: slug, arguments: JSON.stringify(input) },
                },
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
    // A call the queue-time check refuses is never queued: the cell says so.
    if (!res.ok || pendingIds.length !== 1) return { refused: short(JSON.stringify(res)) };
    return { pending: pendingIds[0]! };
  };

  /** Put every right back as the matrix starts it. */
  const reset = async () => {
    await x(sql`delete from workspace_users where workspace_id in (${teamWs}, ${elseWs})`);
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${teamWs}, ${id.adminUser}, true), (${teamWs}, ${id.member}, true),
      (${teamWs}, ${id.memberPlain}, false)`);
    await x(sql`update workspace_users set moderator = false
      where workspace_id = ${adminWs} and login_id <> ${id.owner}`);
    await x(sql`delete from workspace_resources where workspace_id = ${teamWs} and ref_id = 'crm'`);
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${teamWs}, 'connector', 'crm', true)`);
    await homeNote(teamWs);
  };
  const homeNote = (ws: string) =>
    m.withHeads([noteId], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${noteId}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${noteId}, ${ws}, true)`);
    });

  /** Change `asker`'s rights after its call was queued. */
  const change = async (
    asker: (typeof ASKERS)[number],
    right: (typeof RIGHTS)[number],
    tool: (typeof TOOLS)[number],
  ) => {
    const login = id[asker];
    switch (right) {
      case 'none':
        return;
      case 'lostWorkspace':
        await x(
          sql`delete from workspace_users where workspace_id = ${teamWs} and login_id = ${login}`,
        );
        return;
      case 'lostModerator':
        await x(sql`update workspace_users set moderator = false
          where workspace_id = ${teamWs} and login_id = ${login}`);
        return;
      case 'lostItem':
        if (tool === 'note') await homeNote(elseWs);
        else await x(sql`delete from workspace_resources where workspace_id = ${teamWs}`);
        return;
      case 'gained':
        await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
          values (${elseWs}, ${login}, true) on conflict do nothing`);
        if (asker === 'adminUser') {
          await x(sql`update workspace_users set moderator = true
            where workspace_id = ${adminWs} and login_id = ${login}`);
        }
        return;
    }
  };

  /** Approve `pending` as `login` on `via`: the path's answer. */
  const approve = async (via: (typeof PATHS)[number], login: string, pending: string) => {
    const role = login === id.member || login === id.memberPlain ? 'member' : 'admin';
    const actor = m.loginActor(login, login === id.owner ? 'owner' : 'rw');
    if (via === 'web') {
      const res = await app.request(`/api/pending/${pending}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: cookieOf(login) },
        body: JSON.stringify({ decision: 'approve' }),
      });
      const body = await res.text();
      let error: string | null;
      try {
        error = (JSON.parse(body) as { error?: string }).error ?? null;
      } catch {
        error = body;
      }
      return `web ${res.status}${error ? ` ${short(error)}` : ''}`;
    }
    if (via === 'mcp') {
      const { McpServer, InMemoryTransport } = await import('@modelcontextprotocol/server');
      const { Client } = await import('@modelcontextprotocol/client');
      const prepared = await ls.prepareCallerTools({
        role,
        anchorId: id.owner,
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
        const r = (await m.runAsActor(actor, () =>
          c.callTool({ name: 'pending_approve', arguments: { id: pending } }),
        )) as Reply;
        return r.isError ? `mcp error ${short(text(r))}` : 'mcp ok';
      } catch (err) {
        return `mcp throw ${short(err instanceof Error ? err.message : String(err))}`;
      } finally {
        await c.close();
      }
    }
    if (via === 'telegram') {
      const { telegramApprovalHandlers } = await import('@/lib/telegram-approval');
      const r = await telegramApprovalHandlers.onApproval!({
        ownerId: id.owner,
        loginId: login,
        decision: 'approve',
        pendingId: pending,
      });
      return `telegram ${r.ok ? 'ok' : 'refused'} ${short(r.text)}`;
    }
    // A batch: approvePendingCall from no scope, naming its approver.
    try {
      const row = await m.runAsActor(actor, () =>
        t.approvePendingCall(id.owner, pending, { approverLoginId: login }),
      );
      return row ? 'batch ok' : 'batch not-found';
    } catch (err) {
      return `batch throw ${short(err instanceof Error ? err.message : String(err))}`;
    }
  };

  /** Where the call ran, as the connector's remote call saw it. */
  const ranIn = (r: { scope: unknown; actor: unknown }) => {
    const s = r.scope as { kind: string; loginId: string | null; ws: string[]; modWs: string[] };
    const a = r.actor as { kind: string; loginId?: string; mode?: string } | null;
    const who = a ? `${a.kind}${a.loginId ? `:${label(a.loginId)}` : ''}` : 'none';
    if (!s) return `ran unscoped as ${who}`;
    const ws = s.ws.map(label).sort().join('+');
    const mod = s.modWs.map(label).sort().join('+') || '-';
    return `ran in ${s.kind}:${label(s.loginId)} ws ${ws} mod ${mod} as ${who}`;
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(DB_URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'a5-recheck-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET = 'a5-approval-recheck-secret-at-least-32-chars';
    delete process.env.MANTLE_DETACHED_DEV;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline in the approval re-check test', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    ls = await import('@mantle/mcp-core');
    rt = await import('@mantle/runtime/agent');
    tracing = await import('@mantle/tracing');
    ex = await import('../../../packages/runtime/src/agent/tool-loop/execute-call');
    const content = await import('@mantle/content');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${id.owner}, ${emailOf(id.owner)}, 'x', true, 'admin', 'Owner'),
      (${id.adminUser}, ${emailOf(id.adminUser)}, 'x', false, 'admin', 'Admin user'),
      (${id.member}, ${emailOf(id.member)}, 'x', false, 'member', 'Member'),
      (${id.memberPlain}, ${emailOf(id.memberPlain)}, 'x', false, 'member', 'Member plain'),
      (${id.other}, ${emailOf(id.other)}, 'x', false, 'admin', 'Other')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${id.owner}, 'brain', ${id.owner})
      on conflict (id) do nothing`);
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${id.owner} and is_admin and archived_at is null`)
    )[0]!.id;
    teamWs = (
      await x<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${id.owner}, ${`${tag} Team`}) returning id::text`)
    )[0]!.id;
    elseWs = (
      await x<{ id: string }>(sql`insert into workspaces (owner_id, name)
        values (${id.owner}, ${`${tag} Else`}) returning id::text`)
    )[0]!.id;
    for (const login of [id.adminUser, id.other]) {
      await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
        values (${adminWs}, ${login}, false)
        on conflict (workspace_id, login_id) do update set moderator = false`);
    }
    await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${teamAgent}, ${id.owner}, ${`${tag}-team`}, 'Team', 'fake/model', 'p', 'responder', ${teamWs})`);
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, integration, enabled)
      values (${id.owner}, 'crm', 'CRM', ${`{${SLUG}}`}::text[],
              ${JSON.stringify({ mcp: { url: 'https://crm.example.test/mcp' } })}::jsonb, true)`);
    await x(sql`insert into tools (owner_id, slug, name, description, input_schema, handler,
                                   requires_confirm, enabled)
      values (${id.owner}, ${SLUG}, 'CRM update', 'Update a CRM record.',
              ${JSON.stringify({ type: 'object', properties: { id: { type: 'string' } } })}::jsonb,
              ${JSON.stringify({ kind: 'mcp', group: 'crm', toolName: 'update' })}::jsonb,
              true, true)`);
    await m.asSystem(() => t.seedBuiltinTools(id.owner), 'test');
    await x(sql`update tools set requires_confirm = true
      where owner_id = ${id.owner} and slug = 'note_update'`);
    noteId = (
      await m.asSystem(
        () => content.createNote(id.owner, { title: `${tag} note`, content: 'body' }),
        'test',
      )
    ).id;
    const tokens = await import('../lib/auth/tokens');
    cookieOf = (login) => `mantle_session=${tokens.buildSessionCookie(login).value}`;
    const { createApp } = await import('./app');
    app = await createApp();
    m.startCallAudit();
    // Both checks on, as every box since the pre-check removal
    // (docs/actors.md, "Pre-check deletion"): a tool's write to an item the
    // scope may not change is the database's to refuse now. This process's
    // actor check on (a login's scoped write on the write role, its check
    // on) and the scratch database's edit check on.
    suiteMode = process.env.MANTLE_ACTOR_CHECK;
    process.env.MANTLE_ACTOR_CHECK = 'on';
    await (
      await import('@mantle/db/test-support')
    ).superuserExec(scratch!.url, "select mantle_set_edit_check('on')");
  }, 240_000);

  afterAll(async () => {
    if (suiteMode === undefined) delete process.env.MANTLE_ACTOR_CHECK;
    else process.env.MANTLE_ACTOR_CHECK = suiteMode;
    vi.unstubAllGlobals();
    m?.stopCallAudit();
    const bridge = (globalThis as { __mantleRealtime?: { stop?: (() => Promise<void>) | null } })
      .__mantleRealtime;
    await bridge?.stop?.();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('every cell answers as recorded on main, or as its named change', async () => {
    const table: Record<string, string> = {};
    let n = 0;
    for (const asker of ASKERS) {
      for (const approver of APPROVERS) {
        for (const via of PATHS) {
          for (const right of RIGHTS) {
            for (const tool of TOOLS) {
              n += 1;
              await reset();
              const queued = await queue(asker, tool, String(n));
              const key = `${asker}|${approver}|${via}|${right}|${tool}`;
              if (queued.pending === undefined) {
                table[key] = `queue refused: ${queued.refused}`;
                continue;
              }
              const pending = queued.pending;
              await change(asker, right, tool);
              h.remote = [];
              const before = tool === 'note' ? await noteBody() : null;
              const login = approver === 'self' ? id[asker] : id[approver];
              const answer = await approve(via, login, pending);
              const [row] = await x<{ s: string; error: string | null }>(
                sql`select status::text as s, error from pending_tool_calls where id = ${pending}`,
              );
              await readPrivate();
              const ran =
                tool === 'connector'
                  ? h.remote.map(ranIn).join('; ') || 'not run'
                  : (await noteBody()) !== before
                    ? 'note changed'
                    : 'note unchanged';
              table[key] =
                `${answer} => ${row!.s}${row!.error ? ` (${short(row!.error)})` : ''}; ${ran}`;
              // Leave nothing pending for the next cell's approver.
              await x(sql`update pending_tool_calls set status = 'expired'
                where id = ${pending} and status = 'pending'`);
            }
          }
        }
      }
    }
    if (RECORD === 'main' || RECORD === 'now') {
      const file = RECORD === 'main' ? MAIN_FILE : MAIN_FILE.replace('.main.', '.now.');
      writeFileSync(file, `${JSON.stringify(table, null, 2)}\n`);
      return;
    }
    const main = JSON.parse(readFileSync(MAIN_FILE, 'utf8')) as Record<string, string>;
    const changes = JSON.parse(readFileSync(CHANGES_FILE, 'utf8')) as {
      reasons: Record<string, string>;
      cells: Record<string, { now: string; why: string }>;
    };
    const expected: Record<string, string> = {};
    for (const key of Object.keys(main)) expected[key] = changes.cells[key]?.now ?? main[key]!;
    expect(table).toEqual(expected);
    for (const [key, c] of Object.entries(changes.cells)) {
      expect(main[key], `${key} is no change`).not.toBe(c.now);
      expect(changes.reasons[c.why], `${key} names a reason`).toBeTruthy();
    }
  }, 900_000);

  it("the owner's MCP approval reads the row on the system pool: an asker who left the workspace is refused, though Admin holds the connector (fix round 1)", async () => {
    // Member M moderates Team, the connector's Write on there; it asks for a
    // crm write, then is removed from Team. Admin holds crm with Write, so
    // the owner's own MCP scope could run it: before the fix the owner's
    // scope read no row (0254's rule shows a login only its own), the call
    // went unjudged and ran there.
    await reset();
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${adminWs}, 'connector', 'crm', true) on conflict do nothing`);
    try {
      const queued = await queue('member', 'connector', 'own-mcp');
      expect(queued.pending).toBeDefined();
      await change('member', 'lostWorkspace', 'connector');
      h.remote = [];
      const answer = await approve('mcp', id.owner, queued.pending!);
      const [row] = await x<{ s: string }>(
        sql`select status::text as s from pending_tool_calls where id = ${queued.pending!}`,
      );
      expect(answer).toMatch(/^mcp error .*no longer has the workspace it was asked in/);
      expect(row!.s).toBe('pending');
      expect(h.remote).toEqual([]);
      await x(sql`update pending_tool_calls set status = 'expired' where id = ${queued.pending!}`);
    } finally {
      await x(
        sql`delete from workspace_resources where workspace_id = ${adminWs} and ref_id = 'crm'`,
      );
    }
  }, 120_000);

  it("an approved call runs on its asker's surface: app_create's author is its asker, not its approver (fix round 1, L2)", async () => {
    await reset();
    await x(sql`update tools set requires_confirm = true
      where owner_id = ${id.owner} and slug = 'app_create'`);
    const row = await m.asSystem(() => t.resolveTool(id.owner, 'app_create'), 'test');
    const title = `${tag} authored`;
    const pendingIds: string[] = [];
    const res = await m.runAsActor(m.loginActor(id.adminUser, 'rw'), () =>
      rt.withAgentScope(
        { id: teamAgent, ownerId: id.owner, workspaceId: teamWs, role: 'responder' },
        () =>
          tracing.startTrace(
            {
              kind: 'responder_turn',
              ownerId: id.owner,
              agentId: teamAgent,
              loginId: id.adminUser,
            },
            () =>
              ex.executeToolCall({
                args: {
                  ownerId: id.owner,
                  agentId: teamAgent,
                  agentSlug: `${tag}-team`,
                  surface: { kind: 'web', loginId: id.adminUser },
                } as never,
                slug: 'app_create',
                call: {
                  id: 'call-author',
                  function: { name: 'app_create', arguments: JSON.stringify({ name: title }) },
                },
                tool: row!,
                input: { name: title },
                argParseError: null,
                argValidation: null,
                argValidationMode: 'off',
                lastUserMessage: undefined,
                pendingIds,
              }),
          ),
        { loginId: id.adminUser },
      ),
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(pendingIds).toHaveLength(1);
    expect(await approve('batch', id.owner, pendingIds[0]!)).toBe('batch ok');
    const [app] = await x<{ author: string | null }>(
      sql`select a.author_login_id::text as author from apps a join nodes n on n.id = a.node_id
          where n.owner_id = ${id.owner} and n.title = ${title}`,
    );
    expect(app?.author).toBe(id.adminUser);
  }, 120_000);

  const noteBody = async () =>
    (await x<{ c: string | null }>(sql`select data::text as c from nodes where id = ${noteId}`))[0]
      ?.c ?? null;
});
