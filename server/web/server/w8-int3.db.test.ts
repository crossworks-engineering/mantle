/**
 * W8 final round 2, on a migrated scratch database: the Admin assistant (a
 * responder of the Admin workspace, as the manifest ships it) fires its
 * heartbeat under MANTLE_ADMIN_READS=system. Its tool loop was handed no
 * workspace there, so it ran as a responder on no workspace with no login
 * and was refused. It fires now, its gates asking the heartbeat's maker (an
 * Admin user, not a Moderator), never the anchor. With the switch off the
 * fire is unchanged: a turn scope of Admin that answers the maker.
 *
 * W8 final round 3: the Admin assistant's gate scope is reused only when no
 * scope was entered since. On an asSystem exit from a narrower turn scope
 * (a workspace assistant's tool work inside it) the outer Admin gate is still
 * there, and a turn of the Admin assistant answers the login of the scope it
 * left, or is refused, never the outer gate's login.
 *
 * Only the model, its key and the outside hosts are faked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w8-int3.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  scope: null as unknown,
  gate: null as unknown,
}));

vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async () => 'sk-fake'),
}));
// The model: records the scope and the gate scope its turn runs in.
vi.mock('@mantle/voice', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chat = async () => {
    const db = await import('@mantle/db');
    h.scope = db.currentScope();
    h.gate = db.currentGateScope();
    return { text: 'fired, done', model: 'fake/model' };
  };
  return {
    ...actual,
    getChatAdapter: vi.fn(() => ({ providerId: 'openrouter', adapterName: 'fake-chat', chat })),
  };
});

describe.skipIf(!URL)('W8 final round 2: the Admin assistant under the rollback switch', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let hbs: typeof import('@mantle/runtime/heartbeats');
  let rt: typeof import('@mantle/runtime/agent');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const maker = randomUUID(); // a user of Admin, not a Moderator
  const teamOnly = randomUUID(); // a user of the team workspace only
  const tag = `w8f2${randomUUID().slice(0, 6)}`;
  const apiKeyId = randomUUID();
  let adminWs = '';
  let teamWs = '';
  let agentSlug = '';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const newHeartbeat = async (slug: string, by: string | null) => {
    await x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                   schedule_kind, schedule, surface, created_by)
      values (${owner}, ${slug}, 'Check', ${agentSlug}, ${`${tag}-check`},
              'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
              ${JSON.stringify({ kind: 'web' })}::jsonb, ${by})`);
    const [row] = await m.systemDb
      .select()
      .from(m.heartbeats)
      .where(sql`${m.heartbeats.slug} = ${slug}`);
    return row!;
  };
  const lastFire = async (hbId: string) =>
    (
      await x<{ by: string | null; reply: string | null }>(sql`
        select answered_by::text as by, reply_text as reply
          from heartbeat_fires where heartbeat_id = ${hbId} order by fired_at desc limit 1`)
    )[0]!;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w8-int3-'));
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
      vi.fn(async () => new Response('{"error":"offline in the W8 test"}', { status: 503 })),
    );
    m = await import('@mantle/db');
    hbs = await import('@mantle/runtime/heartbeats');
    rt = await import('@mantle/runtime/agent');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${maker}, ${`${tag}-l@example.invalid`}, 'x', false, 'admin', 'Maker'),
      (${teamOnly}, ${`${tag}-t@example.invalid`}, 'x', false, 'member', 'Team')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${adminWs}, ${maker}, false)
                on conflict (workspace_id, login_id) do update set moderator = false`);
    teamWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and name = 'Team' and not is_admin`)
    )[0]!.id;
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${teamWs}, ${maker}, false), (${teamWs}, ${teamOnly}, false)
                on conflict (workspace_id, login_id) do nothing`);
    await x(sql`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${owner}, 'openrouter', 'default', '\\x00'::bytea)`);
    agentSlug = `${tag}-admin`;
    await m.systemDb.insert(m.agents).values({
      ownerId: owner,
      slug: agentSlug,
      name: agentSlug,
      model: 'fake/model',
      provider: 'openrouter',
      apiKeyId,
      systemPrompt: 'p',
      role: 'responder',
      workspaceId: adminWs,
      toolGroupSlugs: [],
      memoryConfig: { chunk_limit: 0, content_hit_limit: 0, corpus_map_limit: 0 },
    });
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
    h.scope = null;
    h.gate = null;
    delete process.env.MANTLE_ADMIN_READS;
  });

  it("the switch on: the Admin assistant's heartbeat fires, its gates asking the maker", async () => {
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      const hb = await newHeartbeat(`${tag}-hb-sys`, maker);
      const fired = await hbs.tickFire(hb);
      expect(fired.disposition, fired.error).toBe('fired');
      expect(h.scope).toMatchObject({ kind: 'system' });
      expect(h.gate).toMatchObject({ kind: 'assistant', loginId: maker, ws: [adminWs], modWs: [] });
      expect(await lastFire(hb.id)).toEqual({ by: maker, reply: 'fired, done' });
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
  });

  it("the switch on: the anchor's heartbeat fires, its gates asking the anchor", async () => {
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      const hb = await newHeartbeat(`${tag}-hb-sys-o`, null);
      const fired = await hbs.tickFire(hb);
      expect(fired.disposition, fired.error).toBe('fired');
      expect(h.gate).toMatchObject({ kind: 'assistant', loginId: owner, ws: [adminWs] });
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
  });

  it('the switch off: unchanged, a turn scope of Admin that answers the maker', async () => {
    const hb = await newHeartbeat(`${tag}-hb-scoped`, maker);
    const fired = await hbs.tickFire(hb);
    expect(fired.disposition, fired.error).toBe('fired');
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: maker, ws: [adminWs], modWs: [] });
    expect(h.gate).toBeNull();
    expect(await lastFire(hb.id)).toEqual({ by: maker, reply: 'fired, done' });
  });

  it('the switch on: an asSystem exit from a narrower turn scope does not reuse the outer Admin gate', async () => {
    process.env.MANTLE_ADMIN_READS = 'system';
    try {
      const agent = { ownerId: owner, workspaceId: adminWs, role: 'responder' };
      // The Admin assistant's own gate scope, acting for the anchor.
      const outer = { kind: 'assistant' as const, loginId: owner, ws: [adminWs], modWs: [] };
      const inAdminGate = <T>(fn: () => Promise<T>) =>
        m.withTurnStamp({ workspaceId: adminWs, loginId: null }, () => m.withGateScope(outer, fn));
      const seenGate = () => rt.withAgentScope(agent, async () => m.currentGateScope());
      // Re-entered straight from its own gate scope it keeps the login chosen.
      expect(await inAdminGate(seenGate)).toMatchObject({ loginId: owner, ws: [adminWs] });
      // A narrower turn scope of the team workspace, then an asSystem exit.
      const fromNarrower = (login: string) =>
        inAdminGate(() =>
          m.withTurnScope({ kind: 'assistant', loginId: login, ws: [teamWs], modWs: [] }, () =>
            m.asSystem(seenGate, 'agent-workspace'),
          ),
        );
      // It answers the login of the scope it left, not the outer gate's.
      expect(await fromNarrower(maker)).toMatchObject({
        kind: 'assistant',
        loginId: maker,
        ws: [adminWs],
        modWs: [],
      });
      // A login of the left scope that is not a user of Admin is refused.
      await expect(fromNarrower(teamOnly)).rejects.toThrow(
        'The login this turn answers is not a user of the Admin workspace.',
      );
    } finally {
      delete process.env.MANTLE_ADMIN_READS;
    }
  });
});
