/**
 * The W7 integration fix 3, on a migrated scratch database: the anchor, two
 * more Admin logins (L the maker, C the firer), a login with the admin role
 * that is a user of the Team workspace only (O), and a member of Team.
 *
 *  F1. The house style and the purpose are the anchor's only; the brand
 *      keys need the settings area; neither restamps a heartbeat. A
 *      heartbeat whose maker changes (a restamp, a PATCH) starts again from
 *      an empty state. A fire that answers a login other than the anchor
 *      never reaches the anchor's Telegram chat.
 *  F2. heartbeat_update_state returns the state to the heartbeat's maker
 *      only; anyone else learns the keys it patched.
 *  F3. The stage poll shows the caller's own running turn only.
 *  L1. Under MANTLE_ADMIN_READS=system only a login that holds Admin goes
 *      to the system pool; an admin role outside Admin stays in its scope.
 *  L2. The traces list and the activity list show the caller's own traces
 *      (the anchor: its own and the system's).
 *  L3. Under the rollback switch heartbeat_fire answers the real caller
 *      (its maker only, W7 integration fix 4).
 *  L4. The brand writers under /api/profile need the settings area.
 *
 * Only the model, its key, Telegram and the outside hosts are faked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7-int-fix3.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRoute } from './run-route';
import { teamWorkspaceSql } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  session: null as unknown,
  sent: [] as Array<{ chatId: string; text: string }>,
  /** The chats paired to each login (W7d: telegram_chats.login_id). */
  paired: {} as Record<string, string[]>,
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const ownerCaller = real.ownerCaller as () => unknown;
  return {
    ...real,
    getOwnerOr401: vi.fn(async () => h.session),
    // The reader a converted handler calls (A4 step 3b): the pipeline's
    // answer through runRoute; the same stand-in for a handler called
    // directly (outside a routed request the real reader throws).
    ownerCaller: vi.fn(() => {
      try {
        return ownerCaller();
      } catch {
        return h.session;
      }
    }),
  };
});
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async () => 'sk-fake'),
}));
vi.mock('@mantle/telegram', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  accountById: vi.fn(async () => ({ id: 'acct', botToken: 'x', enabled: true })),
  pairedChatOf: vi.fn(async (a: { loginId: string; telegramChatId: string }) =>
    h.paired[a.loginId]?.includes(a.telegramChatId)
      ? { id: 'chat', accountId: 'acct', telegramChatId: a.telegramChatId }
      : null,
  ),
  sendMessage: vi.fn(async (_a: unknown, chatId: string, text: string) => {
    h.sent.push({ chatId, text });
    return [1];
  }),
}));
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chat = async () => ({ text: 'fired, done', model: 'fake/model' });
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'openrouter', adapterName: 'fake-chat', chat })),
  };
});

describe.skipIf(!URL)('W7 integration fix 3', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let hbs: typeof import('@mantle/runtime/heartbeats');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const maker = randomUUID(); // L: a user of Admin
  const firer = randomUUID(); // C: a user of Admin
  const outsider = randomUUID(); // O: admin role, a user of Team only
  const tag = `w7f3${randomUUID().slice(0, 6)}`;
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
  const newAgent = async (slug: string) => {
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
      })
      .returning();
    return row!;
  };
  const newHeartbeat = async (
    slug: string,
    agentSlug: string,
    by: string | null,
    surface: Record<string, unknown> = { kind: 'web' },
  ) => {
    await x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                   schedule_kind, schedule, surface, state, created_by)
      values (${owner}, ${slug}, 'Check', ${agentSlug}, ${`${tag}-check`},
              'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
              ${JSON.stringify(surface)}::jsonb,
              ${JSON.stringify({ secret: `${tag} state of ${slug}` })}::jsonb, ${by})`);
    const [row] = await m.systemDb
      .select()
      .from(m.heartbeats)
      .where(sql`${m.heartbeats.slug} = ${slug}`);
    return row!;
  };
  const row = async (hbId: string) =>
    (
      await x<{ by: string | null; state: Record<string, unknown> }>(
        sql`select created_by::text as by, state from heartbeats where id = ${hbId}`,
      )
    )[0]!;
  const lastFire = async (hbId: string) =>
    (
      await x<{ by: string | null; disposition: string }>(sql`
        select answered_by::text as by, disposition::text as disposition
          from heartbeat_fires where heartbeat_id = ${hbId} order by fired_at desc limit 1`)
    )[0]!;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7-int-fix3-'));
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
    hbs = await import('@mantle/runtime/heartbeats');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${maker}, ${`${tag}-l@example.invalid`}, 'x', false, 'admin', 'Maker'),
      (${firer}, ${`${tag}-c@example.invalid`}, 'x', false, 'admin', 'Firer'),
      (${outsider}, ${`${tag}-x@example.invalid`}, 'x', false, 'admin', 'Outsider')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    // A Team as a brain switched before 0286 has it (a new brain has none).
    await x(sql.raw(teamWorkspaceSql(owner)));
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    teamWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and name = 'Team' and not is_admin`)
    )[0]!.id;
    for (const login of [maker, firer]) {
      await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                  values (${adminWs}, ${login}, false)
                  on conflict (workspace_id, login_id) do update set moderator = false`);
    }
    // O keeps its admin role but is no user of Admin (taken out of it).
    await x(
      sql`delete from workspace_users where workspace_id = ${adminWs} and login_id = ${outsider}`,
    );
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${outsider}, false) on conflict do nothing`);
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
    h.sent.length = 0;
    delete process.env.MANTLE_ADMIN_READS;
    for (const login of [maker, firer]) await setAreas(login, {});
  });

  // ── F1 ─────────────────────────────────────────────────────────────────

  it("F1: the house style and the purpose are the anchor's only, the brand needs the settings area, nothing restamps", async () => {
    const hb = await newHeartbeat(`${tag}-hb-prefs`, agent.slug, null);
    // Through the full pipeline (runRoute, A4 step 3b): the gate answers
    // the login from its session cookie, the handler reads it.
    let who = maker;
    const put = (body: Record<string, unknown>) =>
      runRoute(who, 'PUT', '/api/profile', { timezone: 'UTC', ...body });
    const current = (
      (await (await runRoute(who, 'GET', '/api/profile')).json()) as {
        preferences: { houseStyle?: string; purpose?: string };
      }
    ).preferences;
    // An unchanged value is no change.
    const same = await put({
      houseStyle: current.houseStyle ?? '',
      purpose: current.purpose ?? '',
    });
    expect(same.status, await same.clone().text()).toBe(200);
    // L holds the settings area, and still may not change the prompt text.
    for (const body of [{ houseStyle: `${tag} style` }, { purpose: `${tag} purpose` }]) {
      const refused = await put(body);
      expect(refused.status, JSON.stringify(body)).toBe(403);
      expect(await refused.text()).toMatch(/houseStyle|purpose/);
    }
    // The brand: with the settings area yes, without it no.
    expect((await put({ siteName: `${tag} site` })).status).toBe(200);
    await setAreas(maker, { settings: false });
    expect((await put({ siteName: `${tag} other` })).status).toBe(403);
    // The anchor changes the house style.
    who = owner;
    expect((await put({ houseStyle: `${tag} style` })).status).toBe(200);
    // No save made any heartbeat another login's.
    expect((await row(hb.id)).by).toBeNull();
    const moved = await x<{ n: number }>(
      sql`select count(*)::int as n from heartbeats where owner_id = ${owner} and created_by = ${maker}`,
    );
    expect(moved[0]!.n).toBe(0);
  });

  it('F1: a restamp to another login empties the state; one already its own keeps it', async () => {
    const own = await newAgent(`${tag}-restamp`);
    const theirs = await newHeartbeat(`${tag}-hb-rs-c`, own.slug, firer);
    const mine = await newHeartbeat(`${tag}-hb-rs-l`, own.slug, maker);
    const anchors = await newHeartbeat(`${tag}-hb-rs-o`, own.slug, null);
    expect(await t.restampHeartbeatMakers(owner, maker, { agentSlug: own.slug })).toBe(3);
    expect(await row(theirs.id)).toEqual({ by: maker, state: {} });
    expect(await row(anchors.id)).toEqual({ by: maker, state: {} });
    expect(await row(mine.id)).toEqual({
      by: maker,
      state: { secret: `${tag} state of ${mine.slug}` },
    });
  });

  it("F1: a PATCH by another login makes the heartbeat its own with an empty state; its maker's PATCH keeps it", async () => {
    const hb = await newHeartbeat(`${tag}-hb-patch`, agent.slug, maker);
    const route = await import('@/app/api/heartbeats/[id]/route');
    as(maker);
    const kept = await route.PATCH(json({ name: 'Mine still' }, 'PATCH'), params('id', hb.id));
    expect(kept.status, await kept.clone().text()).toBe(200);
    expect(await row(hb.id)).toEqual({
      by: maker,
      state: { secret: `${tag} state of ${hb.slug}` },
    });
    as(firer);
    const res = await route.PATCH(json({ name: 'Taken over' }, 'PATCH'), params('id', hb.id));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await row(hb.id)).toEqual({ by: firer, state: {} });
    // The anchor's change makes it the anchor's, empty again.
    await x(sql`update heartbeats set state = '{"c": 1}'::jsonb where id = ${hb.id}`);
    as(owner);
    expect((await route.PATCH(json({ name: 'Back' }, 'PATCH'), params('id', hb.id))).status).toBe(
      200,
    );
    expect(await row(hb.id)).toEqual({ by: null, state: {} });
  });

  it("F1: a fire that answers another login never reaches the anchor's Telegram chat", async () => {
    // The chat is the anchor's (W7d: paired to the anchor login).
    h.paired = { [owner]: ['424242'] };
    const surface = { kind: 'telegram', chat_id: '424242' };
    const theirs = await newHeartbeat(`${tag}-hb-tg-l`, agent.slug, maker, surface);
    const fired = await hbs.tickFire(theirs);
    expect(fired.disposition, fired.error).toBe('fired_undelivered');
    expect((await lastFire(theirs.id)).by).toBe(maker);
    expect(h.sent).toEqual([]);

    const anchors = await newHeartbeat(`${tag}-hb-tg-o`, agent.slug, null, surface);
    const ok = await hbs.tickFire(anchors);
    expect(ok.disposition, ok.error).toBe('fired');
    expect(h.sent).toEqual([{ chatId: '424242', text: 'fired, done' }]);
  });

  // ── F2 ─────────────────────────────────────────────────────────────────

  it('F2: heartbeat_update_state returns the state to the maker only', async () => {
    const tool = hbs.HEARTBEAT_TOOLS.find((d) => d.slug === 'heartbeat_update_state')!;
    const update = async (login: string, slug: string, patch: Record<string, unknown>) => {
      const res = await m.withTurnScope(
        adminTurn(login),
        () =>
          tool.handler(
            { slug, patch },
            { ownerId: owner, surface: { kind: 'web', loginId: login } },
          ),
        { writes: true },
      );
      if (!res.ok) throw new Error(res.error);
      return res.output as Record<string, unknown>;
    };
    const hb = await newHeartbeat(`${tag}-hb-upd`, agent.slug, maker);
    const secret = `${tag} state of ${hb.slug}`;
    // The anchor patches L's heartbeat: it learns its own keys only.
    const anchors = await update(owner, hb.slug, { a: 1 });
    expect(anchors.state).toBeUndefined();
    expect(anchors.patched_keys).toEqual(['a']);
    expect(JSON.stringify(anchors)).not.toContain(secret);
    // L, the maker, reads its whole state back.
    const mine = await update(maker, hb.slug, { b: 2 });
    expect(mine.state).toEqual({ secret, a: 1, b: 2 });
    // C takes it over: it starts from its own patch, never L's keys.
    const taken = await update(firer, hb.slug, { c: 3 });
    expect(taken.state).toEqual({ c: 3 });
    expect(await row(hb.id)).toEqual({ by: firer, state: { c: 3 } });
  });

  // ── F3 ─────────────────────────────────────────────────────────────────

  it("F3: the stage poll shows the caller's own running turn only", async () => {
    const ownTrace = randomUUID();
    const makersTrace = randomUUID();
    await x(sql`insert into traces (id, owner_id, kind, status, started_at, login_id) values
      (${ownTrace}, ${owner}, 'responder_turn', 'running', now() - interval '30 seconds', null),
      (${makersTrace}, ${owner}, 'responder_turn', 'running', now() - interval '10 seconds', ${maker})`);
    await x(sql`insert into trace_steps (trace_id, ordinal, name, kind, status) values
      (${ownTrace}, 0, 'spill_result:x', 'compute', 'running'),
      (${makersTrace}, 0, 'openrouter_chat', 'llm_call', 'running')`);
    // Through the full pipeline (runRoute, A4 step 3b).
    const label = async (login: string) =>
      (
        (await (await runRoute(login, 'GET', '/api/assistant/turn/stage')).json()) as {
          label: string | null;
        }
      ).label;
    try {
      expect(await label(owner)).toBe('Reading more results…');
      expect(await label(maker)).toBe('Thinking…');
      expect(await label(firer)).toBeNull();
    } finally {
      await x(sql`update traces set status = 'success' where id in (${ownTrace}, ${makersTrace})`);
    }
  });

  // ── L1 ─────────────────────────────────────────────────────────────────

  it('L1: under the rollback switch only a login that holds Admin reads on the system pool', async () => {
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      const { runMcpCall } = await import('@mantle/mcp-core');
      const seen = (login: string) =>
        runMcpCall(login, 'search_nodes', async () => ({
          scope: m.currentWorkspaceScope(),
          gate: m.currentGateScope(),
        }));
      // L, an Admin user: the system pool, its gate scope set.
      expect(await seen(maker)).toMatchObject({ scope: null, gate: { loginId: maker } });
      // O has the admin role only: it stays in its own scope (Team).
      const o = (await seen(outsider)) as { scope: { loginId: string; ws: string[] } | null };
      expect(o.scope).toMatchObject({ loginId: outsider });
      expect(o.scope!.ws).toContain(teamWs);
      expect(o.scope!.ws).not.toContain(adminWs);
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
    // What the session guard asks (session.ts): the Admin workspace, not the role.
    expect(await m.loginHoldsAdmin(maker)).toBe(true);
    expect(await m.loginHoldsAdmin(owner)).toBe(true);
    expect(await m.loginHoldsAdmin(outsider)).toBe(false);
  });

  // ── L2 ─────────────────────────────────────────────────────────────────

  it("L2: the traces list and the activity list show the caller's own traces", async () => {
    const ids = { own: randomUUID(), system: randomUUID(), makers: randomUUID() };
    await x(sql`insert into traces (id, owner_id, kind, status, login_id) values
      (${ids.own}, ${owner}, 'manual', 'success', ${owner}),
      (${ids.system}, ${owner}, 'manual', 'success', null),
      (${ids.makers}, ${owner}, 'manual', 'success', ${maker})`);
    const traces = await import('@/app/api/traces/route');
    const journey = await import('@/app/api/debug/journey/route');
    const listed = async (login: string) => {
      as(login);
      const list = await (await traces.GET(new Request('http://x/api/traces'))).text();
      const activity = await (await journey.GET(new Request('http://x/api/debug/journey'))).text();
      return { list, activity };
    };
    const anchor = await listed(owner);
    for (const text of [anchor.list, anchor.activity]) {
      expect(text).toContain(ids.own);
      expect(text).toContain(ids.system);
      expect(text).not.toContain(ids.makers);
    }
    const l = await listed(maker);
    for (const text of [l.list, l.activity]) {
      expect(text).toContain(ids.makers);
      expect(text).not.toContain(ids.own);
      expect(text).not.toContain(ids.system);
    }
    const c = await listed(firer);
    for (const id of Object.values(ids)) {
      expect(c.list).not.toContain(id);
      expect(c.activity).not.toContain(id);
    }
  });

  // ── L3 ─────────────────────────────────────────────────────────────────

  it('L3: under the rollback switch heartbeat_fire answers the real caller, its maker only', async () => {
    const tool = hbs.HEARTBEAT_TOOLS.find((d) => d.slug === 'heartbeat_fire')!;
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      // An Admin login's MCP call: its gate scope names it. C fires its own
      // heartbeat; L's is not C's to fire (W7 integration fix 4).
      const viaGate = await newHeartbeat(`${tag}-hb-l3-gate`, agent.slug, firer);
      const res = await m.withGateScope(await m.loginScopeFor(firer), () =>
        tool.handler({ slug: viaGate.slug }, { ownerId: owner, surface: { kind: 'web' } }),
      );
      expect(res.ok, res.ok ? '' : res.error).toBe(true);
      expect((await lastFire(viaGate.id)).by).toBe(firer);
      const makers = await newHeartbeat(`${tag}-hb-l3-l`, agent.slug, maker);
      const refused = await m.withGateScope(await m.loginScopeFor(firer), () =>
        tool.handler({ slug: makers.slug }, { ownerId: owner, surface: { kind: 'web' } }),
      );
      expect(refused.ok).toBe(false);
      // A turn on the system pool: its stamp names it.
      const viaStamp = await newHeartbeat(`${tag}-hb-l3-stamp`, agent.slug, firer);
      const res2 = await m.withTurnStamp({ workspaceId: null, loginId: firer }, () =>
        tool.handler({ slug: viaStamp.slug }, { ownerId: owner, surface: { kind: 'web' } }),
      );
      expect(res2.ok, res2.ok ? '' : res2.error).toBe(true);
      expect((await lastFire(viaStamp.id)).by).toBe(firer);
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
  });

  // ── L4 ─────────────────────────────────────────────────────────────────

  it('L4: the brand writers under /api/profile need the settings area; the anchor always may', async () => {
    const writers: Array<[string, 'PUT' | 'DELETE']> = [
      ['color-theme', 'PUT'],
      ['fonts', 'PUT'],
      ['logo', 'PUT'],
      ['logo', 'DELETE'],
      ['avatar', 'PUT'],
      ['backgrounds', 'PUT'],
      ['neat-background', 'PUT'],
      ['default-mode', 'PUT'],
      ['share-neat', 'PUT'],
    ];
    // Through the full pipeline (runRoute, A4 step 3b): /api/profile/<name>.
    const callAs = (login: string, name: string, method: 'PUT' | 'DELETE', body = {}) =>
      runRoute(login, method, `/api/profile/${name}`, body);
    await setAreas(maker, { settings: false });
    for (const [name, method] of writers) {
      const res = await callAs(maker, name, method);
      expect(res.status, `${method} ${name}`).toBe(403);
    }
    // Representative: with the settings area, and as the anchor, it saves.
    await setAreas(maker, {});
    const ok = await callAs(maker, 'color-theme', 'PUT', { colorTheme: 'neutral' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const anchors = await callAs(owner, 'share-neat', 'PUT', { shareNeat: false });
    expect(anchors.status, await anchors.clone().text()).toBe(200);
  });
});
