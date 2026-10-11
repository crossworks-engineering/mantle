/**
 * The W7 integration fix 2, on a migrated scratch database: the anchor, two
 * more Admin logins (L the maker, C the firer; neither a Moderator of
 * Admin), and a member of the Team workspace.
 *
 *  H1. A fire answers its firer (Fire now, heartbeat_fire; the anchor
 *      included) and the tick its maker: its reply, state and trace are
 *      that login's only, and a heartbeat's state is its maker's only.
 *  H2. A trace reads only for the login its turn answered; the anchor reads
 *      its own and the system's.
 *  M2. The brain's own preferences change only by the anchor or a
 *      settings-area login, which restamps every heartbeat; a changed tool
 *      list of a group restamps its grantees' heartbeats.
 *  M3. A copy or export of an app with its data needs an edit on it.
 *  M5. The anchor fires a Team assistant's heartbeat from its chat: it fires.
 *  M6. Under MANTLE_ADMIN_READS=system the gates still ask the login.
 *  Lows: a turn's open heartbeats are its own login's; a login decides only
 *  its own pending calls; a manifest reset turns the backup off; the
 *  anchor's chat sees the trash of every workspace it moderates.
 *
 * Only the model, its key and the outside hosts are faked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7-int-fix2.db.test.ts
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
  scope: null as unknown,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.session),
}));
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async () => 'sk-fake'),
}));
// The model: records the scope its turn runs in.
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chat = async () => {
    const db = await import('@mantle/db');
    h.scope = db.currentScope();
    return { text: 'fired, done', model: 'fake/model' };
  };
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'openrouter', adapterName: 'fake-chat', chat })),
  };
});

describe.skipIf(!URL)('W7 integration fix 2', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let hbs: typeof import('@mantle/runtime/heartbeats');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const maker = randomUUID(); // L: a user of Admin
  const firer = randomUUID(); // C: a user of Admin
  const member = randomUUID(); // a member of Team
  const tag = `w7f2${randomUUID().slice(0, 6)}`;
  const apiKeyId = randomUUID();
  let adminWs = '';
  let teamWs = '';
  let agent: import('@mantle/db').Agent; // the Admin assistant

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const as = (login: string) => {
    h.session = {
      id: owner,
      email: `${login}@example.invalid`,
      actor: { id: login, email: `${login}@example.invalid`, displayName: null, isOwner: false },
    };
  };
  const params = <K extends string>(key: K, value: string) => ({
    params: Promise.resolve({ [key]: value } as Record<K, string>),
  });
  const json = (body: unknown, method = 'POST') =>
    new Request('http://x/', { method, body: JSON.stringify(body) });
  const setAreas = (login: string, areas: Record<string, boolean>) =>
    x(sql`update workspace_users set limits = ${JSON.stringify({ areas })}::jsonb
           where workspace_id = ${adminWs} and login_id = ${login}`);
  const adminTurn = (login: string) => ({
    kind: 'assistant' as const,
    loginId: login,
    ws: [adminWs],
    modWs: login === owner ? [adminWs] : [],
  });
  const newAgent = async (slug: string, extra: Record<string, unknown> = {}) => {
    const [row] = await m.systemDb
      .insert(m.agents)
      .values({
        ownerId: owner,
        slug,
        name: slug,
        model: 'fake/model',
        provider: 'openrouter',
        apiKeyId,
        systemPrompt: 'p',
        workspaceId: adminWs,
        toolGroupSlugs: [],
        memoryConfig: { chunk_limit: 0, content_hit_limit: 0, corpus_map_limit: 0 },
        ...extra,
      })
      .returning();
    return row!;
  };
  const newHeartbeat = async (slug: string, agentSlug: string, by: string | null) => {
    await x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                   schedule_kind, schedule, surface, state, created_by)
      values (${owner}, ${slug}, 'Check', ${agentSlug}, ${`${tag}-check`},
              'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
              ${JSON.stringify({ kind: 'web' })}::jsonb,
              ${JSON.stringify({ secret: `${tag} state of ${slug}` })}::jsonb, ${by})`);
    const [row] = await m.systemDb
      .select()
      .from(m.heartbeats)
      .where(sql`${m.heartbeats.slug} = ${slug}`);
    return row!;
  };
  const lastFire = async (hbId: string) =>
    (
      await x<{ by: string | null; trace: string | null; reply: string | null }>(sql`
        select answered_by::text as by, trace_id::text as trace, reply_text as reply
          from heartbeat_fires where heartbeat_id = ${hbId} order by fired_at desc limit 1`)
    )[0]!;
  const detailAs = async (login: string, hbId: string) => {
    as(login);
    const detail = await import('@/app/api/heartbeats/[id]/detail/route');
    const res = await detail.GET(new Request('http://x/'), params('id', hbId));
    expect(res.status).toBe(200);
    return (await res.json()) as {
      heartbeat: { state: Record<string, unknown>; stateHidden?: boolean };
      fires: Array<{
        replyText: string | null;
        stateBefore: unknown;
        traceId: string | null;
      }>;
    };
  };
  const traceStatus = async (login: string, traceId: string) => {
    as(login);
    const route = await import('@/app/api/traces/[id]/route');
    return (await route.GET(new Request('http://x/'), params('id', traceId))).status;
  };
  const fireNow = async (login: string, hbId: string) => {
    as(login);
    const route = await import('@/app/api/heartbeats/[id]/fire/route');
    const res = await route.POST(new Request('http://x/'), params('id', hbId));
    expect(res.status, await res.clone().text()).toBe(200);
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7-int-fix2-'));
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
      vi.fn(async () => new Response('{"error":"offline in the W7 test"}', { status: 503 })),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    rt = await import('@mantle/runtime/agent');
    hbs = await import('@mantle/runtime/heartbeats');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${maker}, ${`${tag}-l@example.invalid`}, 'x', false, 'admin', 'Maker'),
      (${firer}, ${`${tag}-c@example.invalid`}, 'x', false, 'admin', 'Firer'),
      (${member}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Member')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    teamWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and bridge_key = 'team'`)
    )[0]!.id;
    for (const login of [maker, firer]) {
      await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                  values (${adminWs}, ${login}, false)
                  on conflict (workspace_id, login_id) do update set moderator = false`);
    }
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${teamWs}, ${member}, false), (${teamWs}, ${owner}, true)
      on conflict (workspace_id, login_id) do update set moderator = excluded.moderator`);
    await x(sql`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`);
    agent = await newAgent(`${tag}-admin`);
    await x(sql`insert into skills (owner_id, slug, name, description)
      values (${owner}, ${`${tag}-check`}, 'Check', 'Check in.')`);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.MANTLE_ADMIN_READS;
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    h.session = null;
    h.scope = null;
    delete process.env.MANTLE_ADMIN_READS;
    for (const login of [maker, firer]) await setAreas(login, {});
  });

  // ── H1 ─────────────────────────────────────────────────────────────────

  it("H1: C fires L's heartbeat: C reads the reply, state and trace; L and the anchor do not", async () => {
    const hb = await newHeartbeat(`${tag}-hb-l`, agent.slug, maker);
    await fireNow(firer, hb.id);
    expect(h.scope).toMatchObject({ loginId: firer });
    const fire = await lastFire(hb.id);
    expect(fire.by).toBe(firer);
    expect(fire.reply).toBe('fired, done');
    const mine = (await detailAs(firer, hb.id)).fires[0]!;
    expect(mine.replyText).toBe('fired, done');
    expect(mine.stateBefore).not.toBeNull();
    expect(mine.traceId).toBe(fire.trace);
    for (const other of [maker, owner]) {
      const theirs = (await detailAs(other, hb.id)).fires[0]!;
      expect(theirs, other).toMatchObject({ replyText: null, stateBefore: null, traceId: null });
    }
  });

  it("H1: the anchor's Fire now on L's heartbeat answers the anchor", async () => {
    const hb = await newHeartbeat(`${tag}-hb-l2`, agent.slug, maker);
    await fireNow(owner, hb.id);
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: owner, ws: [adminWs] });
    expect((await lastFire(hb.id)).by).toBeNull();
    expect((await detailAs(owner, hb.id)).fires[0]!.replyText).toBe('fired, done');
    expect((await detailAs(maker, hb.id)).fires[0]!.replyText).toBeNull();
  });

  it('H1: the tick answers the maker', async () => {
    const hb = await newHeartbeat(`${tag}-hb-l3`, agent.slug, maker);
    const fired = await hbs.tickFire(hb);
    expect(fired.disposition, fired.error).toBe('fired');
    expect((await lastFire(hb.id)).by).toBe(maker);
    expect((await detailAs(maker, hb.id)).fires[0]!.replyText).toBe('fired, done');
    expect((await detailAs(owner, hb.id)).fires[0]!.replyText).toBeNull();
  });

  it("H1: a heartbeat's state shows only to its maker, on the list and in heartbeat_list", async () => {
    const hb = await newHeartbeat(`${tag}-hb-state`, agent.slug, maker);
    const list = await import('@/app/api/heartbeats/route');
    const stateFor = async (login: string) => {
      as(login);
      const body = (await (await list.GET()).json()) as {
        heartbeats: Array<{ id: string; state: Record<string, unknown>; stateHidden?: boolean }>;
      };
      return body.heartbeats.find((r) => r.id === hb.id)!;
    };
    expect((await stateFor(maker)).state).toEqual({ secret: `${tag} state of ${hb.slug}` });
    for (const other of [firer, owner]) {
      expect(await stateFor(other), other).toMatchObject({ state: {}, stateHidden: true });
    }
    const tool = hbs.HEARTBEAT_TOOLS.find((d) => d.slug === 'heartbeat_list')!;
    const listed = async (login: string) => {
      const res = await m.withTurnScope(
        adminTurn(login),
        () =>
          m.asSystem(
            () => tool.handler({ include_state: true, limit: 200 }, { ownerId: owner }),
            'admin-area',
          ),
        { writes: true },
      );
      if (!res.ok) throw new Error(res.error);
      const rows = (res.output as { heartbeats: Array<Record<string, unknown>> }).heartbeats;
      return rows.find((r) => r.id === hb.id)!;
    };
    expect((await listed(maker)).state).toEqual({ secret: `${tag} state of ${hb.slug}` });
    expect(await listed(firer)).toMatchObject({ state: null, state_hidden: true });
    expect(await listed(owner)).toMatchObject({ state: null, state_hidden: true });
  });

  // ── H2 ─────────────────────────────────────────────────────────────────

  it('H2: a trace reads only for the login its turn answered; the anchor its own and the system', async () => {
    const hb = await newHeartbeat(`${tag}-hb-trace`, agent.slug, maker);
    await fireNow(firer, hb.id);
    const theirs = (await lastFire(hb.id)).trace!;
    expect(theirs).toBeTruthy();
    expect(await traceStatus(firer, theirs)).toBe(200);
    expect(await traceStatus(maker, theirs)).toBe(404);
    expect(await traceStatus(owner, theirs)).toBe(404);

    const own = await newHeartbeat(`${tag}-hb-trace-o`, agent.slug, null);
    await fireNow(owner, own.id);
    const anchors = (await lastFire(own.id)).trace!;
    expect(await traceStatus(owner, anchors)).toBe(200);
    expect(await traceStatus(firer, anchors)).toBe(404);

    const system = randomUUID();
    await x(sql`insert into traces (id, owner_id, kind, status)
                values (${system}, ${owner}, 'manual', 'success')`);
    expect(await traceStatus(owner, system)).toBe(200);
    expect(await traceStatus(firer, system)).toBe(404);
  });

  // ── M3 ─────────────────────────────────────────────────────────────────

  it('M3: a read-only member copies an app with its data only while its MCP access is on', async () => {
    const app = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${app}, ${owner}, 'app', ${`${tag} app`}, 'apps')`);
    await x(sql`insert into apps (node_id) values (${app})`);
    await x(sql`insert into item_grants (node_id, workspace_id, write, is_home) values
      (${app}, ${adminWs}, true, true), (${app}, ${teamWs}, false, false)
      on conflict do nothing`);
    const refusal = async (slug: string, input: Record<string, unknown>) =>
      m.withTurnScope(await m.loginScopeFor(member), () =>
        t.toolItemWriteRefusal(slug, input, owner),
      );
    for (const slug of ['app_export', 'app_duplicate']) {
      expect(await refusal(slug, { id: app }), slug).not.toBeNull();
      expect(await refusal(slug, { id: app, with_data: false }), slug).toBeNull();
    }
    await x(sql`update apps set mcp_access = true where node_id = ${app}`);
    expect(await refusal('app_export', { id: app })).toBeNull();
  });

  // ── M5 ─────────────────────────────────────────────────────────────────

  it("M5: the anchor fires the Team assistant's heartbeat from its chat: it fires, by its own rules", async () => {
    const team = await newAgent(`${tag}-team`, { workspaceId: teamWs, role: 'responder' });
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${teamWs}, 'assistant', ${team.id}, true) on conflict do nothing`);
    const hb = await newHeartbeat(`${tag}-hb-team`, team.slug, null);
    const tool = hbs.HEARTBEAT_TOOLS.find((d) => d.slug === 'heartbeat_fire')!;
    const res = await m.withTurnScope(
      adminTurn(owner),
      () =>
        tool.handler(
          { slug: hb.slug },
          { ownerId: owner, surface: { kind: 'web', loginId: owner } },
        ),
      { writes: true },
    );
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect((res as { output: { disposition: string } }).output.disposition).toBe('fired');
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: null, ws: [teamWs] });
    const [row] = await x<{ status: string }>(
      sql`select status::text from heartbeats where id = ${hb.id}`,
    );
    expect(row!.status).toBe('active');
    expect((await lastFire(hb.id)).by).toBeNull();
  });

  // ── M6 ─────────────────────────────────────────────────────────────────

  it('M6: under the rollback switch the gates still ask the login', async () => {
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      // A login outside Admin is refused on the Admin assistant and a helper.
      await expect(rt.withAgentScope(agent, async () => 1, { loginId: member })).rejects.toThrow(
        /not a user of the Admin workspace/,
      );
      const helper = { id: null, ownerId: owner, audience: 'admin', workspaceId: null };
      await expect(
        rt.withAgentScope(helper, async () => 1, { ownerLoginId: member }),
      ).rejects.toThrow(/not a user of the Admin workspace/);
      // The Admin assistant answering an Admin user runs, its gate scope set.
      const seen = await rt.withAgentScope(agent, async () => m.currentGateScope(), {
        ownerLoginId: maker,
      });
      expect(seen).toMatchObject({ loginId: maker, ws: [adminWs] });

      // The Admin tool gate and the areas, over MCP.
      await setAreas(maker, { settings: false });
      const { runInOwnerMcpScope } = await import('@mantle/mcp-core');
      let ran = false;
      const refused = (await runInOwnerMcpScope(maker, 'run_terminal', async () => {
        ran = true;
        return 'ran';
      })) as { isError?: boolean };
      expect(ran).toBe(false);
      expect(refused.isError).toBe(true);

      // The item write check: L is no Moderator of Admin.
      const page = randomUUID();
      await x(sql`insert into nodes (id, owner_id, type, title, path)
                  values (${page}, ${owner}, 'page', ${`${tag} page`}, 'pages')`);
      await x(sql`insert into item_grants (node_id, workspace_id, write, is_home)
                  values (${page}, ${adminWs}, false, true) on conflict do nothing`);
      const write = await runInOwnerMcpScope(maker, 'page_update', () =>
        t.toolItemWriteRefusal('page_update', { id: page }, owner),
      );
      expect(typeof write === 'string' ? write : JSON.stringify(write)).toMatch(/\S/);
      expect(write).not.toBeNull();

      // The sandbox maker rule.
      const box = randomUUID();
      await x(sql`insert into sandboxes (id, owner_id, name, image)
                  values (${box}, ${owner}, ${`${tag}-box`}, 'img')`);
      const { sandboxForLogin } = await import('@/lib/sandboxd');
      expect(await sandboxForLogin({ id: owner, actor: { id: maker } }, box)).toBeNull();
      expect(await sandboxForLogin({ id: owner, actor: { id: owner } }, box)).not.toBeNull();
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
  });

  // ── Lows ───────────────────────────────────────────────────────────────

  it("low: a turn's open heartbeats are its own login's only", async () => {
    const mine = await newHeartbeat(`${tag}-hb-open-l`, agent.slug, maker);
    const anchors = await newHeartbeat(`${tag}-hb-open-o`, agent.slug, null);
    await x(sql`update heartbeats set state = '{"expecting_reply": true}'::jsonb
                 where id in (${mine.id}, ${anchors.id})`);
    const open = async (login: string) =>
      (
        await m.withTurnScope(adminTurn(login), () =>
          hbs.openHeartbeatsForSurface(owner, { kind: 'web' }),
        )
      )
        .map((r) => r.slug)
        .filter((s) => s.startsWith(`${tag}-hb-open`));
    expect(await open(maker)).toEqual([mine.slug]);
    expect(await open(owner)).toEqual([anchors.slug]);
    expect(await open(firer)).toEqual([]);
  });

  it('low: a login other than the anchor decides only its own pending calls', async () => {
    const ids = { mine: randomUUID(), anchors: randomUUID() };
    await x(sql`insert into pending_tool_calls (id, owner_id, tool_slug, login_id) values
      (${ids.mine}, ${owner}, 'email_send', ${maker}),
      (${ids.anchors}, ${owner}, 'email_send', ${owner})`);
    const reject = (id: string) =>
      m.withTurnScope(
        adminTurn(maker),
        () => m.asSystem(() => t.rejectPendingCall(owner, id), 'admin-area'),
        { writes: true },
      );
    expect(await reject(ids.anchors)).toBeNull();
    expect(await reject(ids.mine)).toMatchObject({ status: 'rejected' });
    const [left] = await x<{ status: string }>(
      sql`select status::text from pending_tool_calls where id = ${ids.anchors}`,
    );
    expect(left!.status).toBe('pending');
  });

  it('low: a manifest reset switches the backup off with its host', async () => {
    const { MANIFEST_AGENTS } = await import('@/lib/system-manifest');
    const slug = MANIFEST_AGENTS.find((a) => !a.isPersona && a.systemPrompt)!.slug;
    await newAgent(slug, {
      workspaceId: null,
      backupEnabled: true,
      backupBaseUrl: 'https://192.0.2.11/v1',
      backupViaTailnet: true,
    });
    as(owner);
    const reset = await import('@/app/api/studio/reset/route');
    const res = await reset.POST(json({ slug }));
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await x<Record<string, unknown>>(sql`select backup_enabled, backup_base_url,
        backup_via_tailnet from agents where owner_id = ${owner} and slug = ${slug}`);
    expect(row).toEqual({
      backup_enabled: false,
      backup_base_url: null,
      backup_via_tailnet: false,
    });
  });

  it("low: the anchor's chat sees the trash of every workspace it moderates", async () => {
    const gone = randomUUID();
    await x(sql`insert into node_snapshots (owner_id, node_id, node_kind, seq, trigger, actor, code)
      values (${owner}, ${gone}, 'app', 1, 'pre_delete', 'owner',
              ${JSON.stringify({ meta: { title: `${tag} gone`, homeWs: teamWs } })}::jsonb)`);
    const tool = t.getBuiltin('app_deleted_list')!;
    const ids = async (login: string) => {
      const res = await m.withTurnScope(
        adminTurn(login),
        () => tool.handler({}, { ownerId: owner, surface: { kind: 'web', loginId: login } }),
        { writes: true },
      );
      if (!res.ok) throw new Error(res.error);
      return (res.output as { apps: Array<{ id: string }> }).apps.map((a) => a.id);
    };
    expect(await ids(owner)).toContain(gone);
    expect(await ids(maker)).not.toContain(gone);
  });

  // ── M2 (last: it restamps every heartbeat) ─────────────────────────────

  it("M2: a changed group tool list restamps its grantees' heartbeats to the editor", async () => {
    const group = randomUUID();
    await x(sql`insert into tool_groups (id, owner_id, slug, name, tool_slugs)
                values (${group}, ${owner}, ${`${tag}-grp`}, 'Group', ${'{search_nodes}'}::text[])`);
    const grantee = await newAgent(`${tag}-grantee`, { toolGroupSlugs: [`${tag}-grp`] });
    const hb = await newHeartbeat(`${tag}-hb-grp`, grantee.slug, null);
    as(maker);
    const route = await import('@/app/api/tool-groups/[id]/route');
    const res = await route.PATCH(json({ toolSlugs: [] }, 'PATCH'), params('id', group));
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await x<{ by: string | null }>(
      sql`select created_by::text as by from heartbeats where id = ${hb.id}`,
    );
    expect(row!.by).toBe(maker);
  });

  it("M2: the brain's house style changes only by the anchor or a settings-area login, and restamps every heartbeat", async () => {
    const hb = await newHeartbeat(`${tag}-hb-style`, agent.slug, null);
    const profile = await import('@/app/api/profile/route');
    const put = (body: Record<string, unknown>) =>
      profile.PUT(json({ timezone: 'UTC', ...body }, 'PUT'));
    await setAreas(maker, { settings: false });
    as(maker);
    // An unchanged brain key is no change: a profile save goes through.
    const same = await put({ houseStyle: '' });
    expect(same.status, await same.clone().text()).toBe(200);
    const refused = await put({ houseStyle: `${tag} style` });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/houseStyle/);
    const [before] = await x<{ by: string | null }>(
      sql`select created_by::text as by from heartbeats where id = ${hb.id}`,
    );
    expect(before!.by).toBeNull();
    await setAreas(maker, {});
    expect((await put({ houseStyle: `${tag} style` })).status).toBe(200);
    const rows = await x<{ by: string | null }>(
      sql`select created_by::text as by from heartbeats where owner_id = ${owner}`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.by === maker)).toBe(true);
  });
});
