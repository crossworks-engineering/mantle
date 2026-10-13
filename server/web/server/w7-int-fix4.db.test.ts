/**
 * The W7 integration fix 4, on a migrated scratch database: the anchor, two
 * more Admin logins (L the maker, C another user of Admin) and the Team
 * workspace's assistant.
 *
 *  F2. Only a heartbeat's maker (created_by; null the anchor) fires it: Fire
 *      now answers anyone else 403 and heartbeat_fire refuses them. The
 *      maker and the anchor (for its own heartbeats) fire as before, the
 *      fire answering the maker; the anchor's chat still fires a Team
 *      assistant's heartbeat it made (the M5 path).
 *  F3. Under the rollback switch heartbeat_update_state names the real
 *      caller: another login's patch makes the heartbeat its own and starts
 *      it from an empty state.
 *  F4. A heartbeat fire's trace is stamped with the login it answered, and
 *      the live activity lists only the traces the reader may read.
 *
 * (F1, the onboarding purpose and persona steps, is in
 * app/api/onboarding/purpose-route.test.ts; F5, 0270's repair, in
 * packages/db/src/workspaces-user-threads-orphan.db.test.ts.)
 *
 * Only the model, its key and the outside hosts are faked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7-int-fix4.db.test.ts
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

describe.skipIf(!URL)('W7 integration fix 4', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let hbs: typeof import('@mantle/runtime/heartbeats');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const maker = randomUUID(); // L: a user of Admin
  const other = randomUUID(); // C: a user of Admin
  const tag = `w7f4${randomUUID().slice(0, 6)}`;
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
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
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
  const fires = async (hbId: string) =>
    x<{ by: string | null; trace: string | null }>(sql`
      select answered_by::text as by, trace_id::text as trace
        from heartbeat_fires where heartbeat_id = ${hbId} order by fired_at desc`);
  const fireNow = async (login: string, hbId: string) => {
    as(login);
    const route = await import('@/app/api/heartbeats/[id]/fire/route');
    return route.POST(new Request('http://x/'), params(hbId));
  };
  const fireTool = async (login: string, slug: string) => {
    const tool = hbs.HEARTBEAT_TOOLS.find((d) => d.slug === 'heartbeat_fire')!;
    return m.withTurnScope(
      adminTurn(login),
      () => tool.handler({ slug }, { ownerId: owner, surface: { kind: 'web', loginId: login } }),
      { writes: true },
    );
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7-int-fix4-'));
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
    hbs = await import('@mantle/runtime/heartbeats');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${maker}, ${`${tag}-l@example.invalid`}, 'x', false, 'admin', 'Maker'),
      (${other}, ${`${tag}-c@example.invalid`}, 'x', false, 'admin', 'Other')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    teamWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and name = 'Team' and not is_admin`)
    )[0]!.id;
    for (const login of [maker, other]) {
      await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                  values (${adminWs}, ${login}, false)
                  on conflict (workspace_id, login_id) do update set moderator = false`);
    }
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${teamWs}, ${owner}, true)
      on conflict (workspace_id, login_id) do update set moderator = true`);
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

  beforeEach(() => {
    h.session = null;
    h.scope = null;
    delete process.env.MANTLE_ADMIN_READS;
  });

  // ── F2 ─────────────────────────────────────────────────────────────────

  it('F2: Fire now by a login that is not the maker is a 403, and nothing fires', async () => {
    const hb = await newHeartbeat(`${tag}-hb-now-l`, agent.slug, maker);
    for (const login of [other, owner]) {
      const res = await fireNow(login, hb.id);
      expect(res.status, login).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/set up this heartbeat/);
    }
    // The anchor's own heartbeat is not L's to fire either.
    const anchors = await newHeartbeat(`${tag}-hb-now-o`, agent.slug, null);
    expect((await fireNow(maker, anchors.id)).status).toBe(403);
    expect(h.scope).toBeNull();
    expect(await fires(hb.id)).toEqual([]);
    expect(await fires(anchors.id)).toEqual([]);
  });

  it('F2: the maker and the anchor (its own heartbeat) Fire now; the fire answers the maker', async () => {
    const hb = await newHeartbeat(`${tag}-hb-now-l2`, agent.slug, maker);
    const res = await fireNow(maker, hb.id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: maker, ws: [adminWs] });
    expect((await fires(hb.id))[0]!.by).toBe(maker);

    const anchors = await newHeartbeat(`${tag}-hb-now-o2`, agent.slug, null);
    const own = await fireNow(owner, anchors.id);
    expect(own.status, await own.clone().text()).toBe(200);
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: owner, ws: [adminWs] });
    expect((await fires(anchors.id))[0]!.by).toBeNull();
  });

  it('F2: heartbeat_fire refuses a login that is not the maker; the maker and the anchor fire', async () => {
    const hb = await newHeartbeat(`${tag}-hb-tool-l`, agent.slug, maker);
    const refused = await fireTool(other, hb.slug);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.error).toMatch(/set up this heartbeat/);
    const anchorRefused = await fireTool(owner, hb.slug);
    expect(anchorRefused.ok).toBe(false);
    expect(await fires(hb.id)).toEqual([]);

    const res = await fireTool(maker, hb.slug);
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect((await fires(hb.id))[0]!.by).toBe(maker);

    const anchors = await newHeartbeat(`${tag}-hb-tool-o`, agent.slug, null);
    expect((await fireTool(maker, anchors.slug)).ok).toBe(false);
    const own = await fireTool(owner, anchors.slug);
    expect(own.ok, own.ok ? '' : own.error).toBe(true);
    expect((await fires(anchors.id)).map((f) => f.by)).toEqual([null]);
  });

  it("F2: the anchor's chat fires a Team assistant's heartbeat it made (M5)", async () => {
    const team = await newAgent(`${tag}-team`, { workspaceId: teamWs, role: 'responder' });
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${teamWs}, 'assistant', ${team.id}, true) on conflict do nothing`);
    const hb = await newHeartbeat(`${tag}-hb-team`, team.slug, null);
    const res = await fireTool(owner, hb.slug);
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect((res as { output: { disposition: string } }).output.disposition).toBe('fired');
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: null, ws: [teamWs] });
    expect((await fires(hb.id))[0]!.by).toBeNull();
  });

  it("W7e: a non-anchor Admin login firing a null-maker Team assistant's heartbeat is refused (M5 negative)", async () => {
    const team = await newAgent(`${tag}-team-neg`, { workspaceId: teamWs, role: 'responder' });
    await x(sql`insert into workspace_resources (workspace_id, type, ref_id, write)
      values (${teamWs}, 'assistant', ${team.id}, true) on conflict do nothing`);
    const hb = await newHeartbeat(`${tag}-hb-team-neg`, team.slug, null);
    for (const login of [maker, other]) {
      const res = await fireTool(login, hb.slug);
      expect(res.ok, login).toBe(false);
      const now = await fireNow(login, hb.id);
      expect(now.status, login).toBe(403);
    }
    expect(h.scope).toBeNull();
    expect(await fires(hb.id)).toEqual([]);
  });

  it("W7e: a skipped fire's trace names the login it answers, as a fired one does", async () => {
    const hb = await newHeartbeat(`${tag}-hb-skip`, agent.slug, maker);
    await x(sql`update heartbeats set earliest_at = now() + interval '1 day' where id = ${hb.id}`);
    const [row] = await m.systemDb
      .select()
      .from(m.heartbeats)
      .where(sql`${m.heartbeats.id} = ${hb.id}`);
    const out = await hbs.tickFire(row!);
    expect(out.disposition).toBe('skipped_earliest');
    const [fire] = await fires(hb.id);
    expect(fire!.by).toBe(maker);
    const [trace] = await x<{ login: string | null; status: string }>(sql`
      select login_id::text as login, status from traces where id = ${fire!.trace}`);
    expect(trace).toEqual({ login: maker, status: 'skipped' });
    // The anchor's own heartbeat: its skip names no login (the anchor's).
    const own = await newHeartbeat(`${tag}-hb-skip-o`, agent.slug, null);
    await x(sql`update heartbeats set earliest_at = now() + interval '1 day' where id = ${own.id}`);
    const [ownRow] = await m.systemDb
      .select()
      .from(m.heartbeats)
      .where(sql`${m.heartbeats.id} = ${own.id}`);
    await hbs.tickFire(ownRow!);
    const [ownFire] = await fires(own.id);
    const [ownTrace] = await x<{ login: string | null }>(sql`
      select login_id::text as login from traces where id = ${ownFire!.trace}`);
    expect(ownTrace).toEqual({ login: null });
  });

  // ── F3 ─────────────────────────────────────────────────────────────────

  it("F3: under the rollback switch another login's state patch moves the heartbeat and clears its state", async () => {
    const tool = hbs.HEARTBEAT_TOOLS.find((d) => d.slug === 'heartbeat_update_state')!;
    const hb = await newHeartbeat(`${tag}-hb-upd`, agent.slug, maker);
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      const res = await m.withGateScope(await m.loginScopeFor(other), () =>
        tool.handler(
          { slug: hb.slug, patch: { c: 3 } },
          { ownerId: owner, surface: { kind: 'web' } },
        ),
      );
      expect(res.ok, res.ok ? '' : res.error).toBe(true);
      // C is the maker now: it reads back its own patch, never L's keys.
      expect((res as { output: { state?: unknown } }).output.state).toEqual({ c: 3 });
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
    const [row] = await x<{ by: string | null; state: Record<string, unknown> }>(
      sql`select created_by::text as by, state from heartbeats where id = ${hb.id}`,
    );
    expect(row).toEqual({ by: other, state: { c: 3 } });
  });

  // ── F4 ─────────────────────────────────────────────────────────────────

  it("F4: a fire's trace is stamped with the login it answered; the live activity is the reader's", async () => {
    const theirs = await newHeartbeat(`${tag}-hb-tr-l`, agent.slug, maker);
    expect((await hbs.tickFire(theirs)).disposition).toBe('fired');
    const makersTrace = (await fires(theirs.id))[0]!.trace!;
    const anchors = await newHeartbeat(`${tag}-hb-tr-o`, agent.slug, null);
    expect((await hbs.tickFire(anchors)).disposition).toBe('fired');
    const anchorsTrace = (await fires(anchors.id))[0]!.trace!;
    const stamp = async (id: string) =>
      (
        await x<{ l: string | null }>(sql`select login_id::text as l from traces where id = ${id}`)
      )[0]!.l;
    expect(await stamp(makersTrace)).toBe(maker);
    expect(await stamp(anchorsTrace)).toBeNull();

    const ids = { own: randomUUID(), system: randomUUID(), makers: randomUUID() };
    await x(sql`insert into traces (id, owner_id, kind, status, login_id) values
      (${ids.own}, ${owner}, 'manual', 'success', ${owner}),
      (${ids.system}, ${owner}, 'manual', 'success', null),
      (${ids.makers}, ${owner}, 'manual', 'success', ${maker})`);
    const traces = await import('@/app/api/traces/route');
    const activity = await import('@/app/api/activity/route');
    const seen = async (login: string) => {
      as(login);
      const list = await (await traces.GET(new Request('http://x/api/traces'))).text();
      const live = await (await activity.GET()).text();
      return { list, live };
    };
    const l = await seen(maker);
    for (const text of [l.list, l.live]) {
      expect(text).toContain(ids.makers);
      expect(text).not.toContain(ids.own);
      expect(text).not.toContain(ids.system);
    }
    expect(l.list).toContain(makersTrace);
    expect(l.list).not.toContain(anchorsTrace);
    const anchor = await seen(owner);
    for (const text of [anchor.list, anchor.live]) {
      expect(text).toContain(ids.own);
      expect(text).toContain(ids.system);
      expect(text).not.toContain(ids.makers);
    }
    expect(anchor.list).toContain(anchorsTrace);
    expect(anchor.list).not.toContain(makersTrace);
    const c = await seen(other);
    for (const id of [...Object.values(ids), makersTrace, anchorsTrace]) {
      expect(c.list).not.toContain(id);
      expect(c.live).not.toContain(id);
    }
  });
});
