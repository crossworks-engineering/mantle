/**
 * W7a fix round 3, on a migrated scratch database: the anchor, and a second
 * Admin login L (a user of Admin, no Moderator there) whose limits switch
 * the keys area off (settings, connectors and assistants stay on).
 *
 *  1. Fire now by L runs the fire's turn as L, never as the anchor. A
 *     heartbeat L edits records L as its maker (heartbeats.created_by) and
 *     the tick fires it as L; the anchor's heartbeats fire as the anchor.
 *  2. sandbox_publish never repoints a group that is not the sandbox's own
 *     (a connector's), and writes the proxy key to the vault only for a
 *     caller with the keys area.
 *  3. The Sandboxes routes (GET, DELETE ?purge=1, stop) apply the maker rule
 *     with the signed-in login: L gets 404 on the anchor's sandbox.
 *  6. Without the keys area L cannot write, update or test a tool that
 *     sends a vault key (tools and Tools routes), nor point an OAuth2 group
 *     elsewhere; a tool L wrote resolves its secret refs only while L holds
 *     the keys area; the anchor's tools still resolve theirs.
 *
 * Only the model, its key, the vault seal and the outside hosts are faked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7a-fix3.db.test.ts
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
  session: null as unknown,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => h.session),
}));
vi.mock('@mantle/api-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiKeyById: vi.fn(async () => 'sk-fake'),
}));
// The vault is sealed with the box's master key; the test key is the viewer
// roles' and is not a sealing key. Every vault value opens to one string.
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: vi.fn(() => ({ ciphertext: Buffer.from('sealed'), keyVersion: 1 })),
  open: vi.fn(() => 'w7a-vault-plaintext'),
}));
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

describe.skipIf(!URL)('W7a fix round 3', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let c: typeof import('@mantle/content');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let hbs: typeof import('@mantle/runtime/heartbeats');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const second = randomUUID(); // L: a user of Admin, keys area off
  const tag = `w7ag${randomUUID().slice(0, 6)}`;
  const apiKeyId = randomUUID();
  let adminWs = '';
  let agent: import('@mantle/db').Agent;
  const ownerBox = `${tag}-obox`;
  const lBox = `${tag}-lbox`;
  let ownerBoxId = '';
  let lBoxId = '';
  const connGroup = `${tag}-conn`;
  const connIntegration = {
    service: 'github',
    baseUrl: 'https://api.github.example',
    secretRef: 'github/default',
    authTemplate: { headers: { Authorization: 'Bearer {{secret:github/default}}' } },
  };
  /** Every outbound request: method, url and its Authorization header. */
  const outbound: string[] = [];

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn);
  const inAdminTurn = <T>(login: string, fn: () => Promise<T>) =>
    rt.withAgentScope({ id: agent.id, audience: 'admin', workspaceId: adminWs }, fn, {
      ownerLoginId: login,
    });
  const dispatchAs = (login: string, slug: string, input: Record<string, unknown>) =>
    inAdminTurn(login, () =>
      t.dispatchTool(
        {
          slug,
          handler: { kind: 'builtin', ref: slug },
          inputSchema: {},
        } as unknown as import('@mantle/db').Tool,
        input,
        {
          ownerId: owner,
          surface: { kind: 'web', loginId: login },
          agent: { slug: agent.slug, depth: 1, delegateTo: [] },
        },
      ),
    );
  const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? '' : String(r.error));
  const as = (login: string) => {
    h.session = {
      id: owner,
      email: `${login}@example.invalid`,
      actor: { id: login, email: `${login}@example.invalid`, displayName: null, isOwner: false },
    };
  };
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const heartbeat = async (slug: string) =>
    (await x<{ id: string }>(sql`select id::text from heartbeats where slug = ${slug}`))[0]!.id;
  const hbRow = async (slug: string) => {
    const [row] = await m.systemDb
      .select()
      .from(m.heartbeats)
      .where(sql`${m.heartbeats.slug} = ${slug}`);
    return row!;
  };
  const toolRow = async (slug: string) => {
    const [row] = await m.systemDb
      .select()
      .from(m.tools)
      .where(sql`${m.tools.slug} = ${slug}`);
    return row ?? null;
  };
  const setKeys = (on: boolean) =>
    x(sql`update workspace_users
             set limits = ${JSON.stringify(on ? {} : { areas: { keys: false } })}::jsonb
           where workspace_id = ${adminWs} and login_id = ${second}`);
  const httpTool = (slug: string, url: string, createdBy: string | null) =>
    x(sql`insert into tools (owner_id, slug, name, description, input_schema, handler, created_by)
      values (${owner}, ${slug}, 'Secret tool', 'Sends a vault key.', ${'{"type":"object"}'}::jsonb,
              ${JSON.stringify({
                kind: 'http',
                url,
                headers: { Authorization: 'Bearer {{secret:openai/default}}' },
              })}::jsonb, ${createdBy})`);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7a-fix3-'));
    process.env.DATABASE_URL = scratch.url;
    process.env.TABLE_DB_DIR = path.join(dir, 'tables');
    process.env.APP_DB_DIR = path.join(dir, 'apps');
    process.env.FILES_DIR = path.join(dir, 'files');
    process.env.MANTLE_FILES_ROOT = path.join(dir, 'files');
    process.env.MANTLE_SPACES_ROOT = path.join(dir, 'spaces');
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    delete process.env.MANTLE_ADMIN_READS;
    process.env.SANDBOXD_URL = 'http://sandboxd.invalid';
    process.env.SANDBOXD_TOKEN = 'w7a-sandboxd-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { method?: string; headers?: unknown }) => {
        const req = input instanceof Request ? input : null;
        const url = String(req ? req.url : input);
        const hdrs = new Headers((req?.headers ?? init?.headers ?? {}) as HeadersInit);
        outbound.push(
          `${req?.method ?? init?.method ?? 'GET'} ${url} ${hdrs.get('authorization') ?? ''}`,
        );
        if (url.startsWith('http://sandboxd.invalid/')) {
          return Response.json({ ok: true, sandboxes: [], disk: null, containerId: 'c-new' });
        }
        if (url.startsWith('https://')) return Response.json({ ok: true });
        return new Response('{"error":"offline in the W7a test"}', { status: 503 });
      }),
    );
    m = await import('@mantle/db');
    c = await import('@mantle/content');
    t = await import('@mantle/tools');
    rt = await import('@mantle/runtime/agent');
    hbs = await import('@mantle/runtime/heartbeats');
    hbs.registerHeartbeatTools();
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${second}, ${`${tag}-l@example.invalid`}, 'x', false, 'admin', 'Second Admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await x(sql`select * from mantle_ws_migrate()`);
    adminWs = (
      await x<{ id: string }>(sql`select id::text from workspaces
        where owner_id = ${owner} and is_admin and archived_at is null`)
    )[0]!.id;
    await x(sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${adminWs}, ${second}, false)
                on conflict (workspace_id, login_id) do update set moderator = false`);
    await setKeys(false);
    // Sandboxes: the anchor's (no maker) and L's.
    ownerBoxId = randomUUID();
    lBoxId = randomUUID();
    await sys(() =>
      c.createSandboxRow({
        id: ownerBoxId,
        ownerId: owner,
        name: ownerBox,
        image: 'test/image',
        status: 'running',
        containerId: 'c1',
      }),
    );
    await sys(() =>
      c.createSandboxRow({
        id: lBoxId,
        ownerId: owner,
        name: lBox,
        image: 'test/image',
        status: 'running',
        containerId: 'c2',
        createdBy: second,
      }),
    );
    // A connector's group, with its base URL and credential.
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, integration)
      values (${owner}, ${connGroup}, 'GitHub', ${'{}'}::text[], 'admin',
              ${JSON.stringify(connIntegration)}::jsonb)`);
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, integration)
      values (${owner}, ${`${tag}-oauth`}, 'OAuth API', ${'{}'}::text[], 'admin',
              ${JSON.stringify({ service: 'acme', baseUrl: 'https://api.acme.example' })}::jsonb)`);
    // A vault key, and the anchor's tool that sends it.
    const keys = await import('@mantle/api-keys');
    await sys(() => keys.setApiKey(owner, 'openai', 'default', 'sk-real-secret'));
    await httpTool(`${tag}_anchor_secret`, 'https://9.9.9.9/v1', null);
    // The Admin assistant and its heartbeats.
    await x(sql`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${owner}, 'openrouter', ${tag}, '\\x00'::bytea)`);
    const [row] = await m.systemDb
      .insert(m.agents)
      .values({
        ownerId: owner,
        slug: `${tag}-admin`,
        name: 'Admin assistant',
        model: 'fake/model',
        provider: 'openrouter',
        apiKeyId,
        systemPrompt: 'p',
        workspaceId: adminWs,
        toolGroupSlugs: [],
        memoryConfig: { chunk_limit: 0, content_hit_limit: 0, corpus_map_limit: 0 },
      })
      .returning();
    agent = row!;
    await x(sql`insert into skills (owner_id, slug, name, description)
      values (${owner}, ${`${tag}-check`}, 'Check in', 'Ask how things are going.')`);
    for (const slug of [`${tag}-hb`, `${tag}-hb-edit`, `${tag}-hb-own`, `${tag}-hb-state`]) {
      await x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                         schedule_kind, schedule, surface)
        values (${owner}, ${slug}, 'Check', ${agent.slug}, ${`${tag}-check`},
                'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
                ${JSON.stringify({ kind: 'web' })}::jsonb)`);
    }
    // L's own heartbeat: only its maker fires it now (W7 integration fix 4).
    await x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                       schedule_kind, schedule, surface, created_by)
      values (${owner}, ${`${tag}-hb-l`}, 'Check', ${agent.slug}, ${`${tag}-check`},
              'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
              ${JSON.stringify({ kind: 'web' })}::jsonb, ${second})`);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.SANDBOXD_URL;
    delete process.env.SANDBOXD_TOKEN;
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    h.scope = null;
    h.session = null;
    outbound.length = 0;
    await setKeys(false);
  });

  // ── 1. heartbeats ──────────────────────────────────────────────────────

  it('1: Fire now by L runs the turn as L; the anchor\'s heartbeat is not L\'s to fire', async () => {
    as(second);
    const route = await import('@/app/api/heartbeats/[id]/fire/route');
    const refused = await route.POST(
      new Request('http://x/'),
      params(await heartbeat(`${tag}-hb`)),
    );
    expect(refused.status).toBe(403);
    expect(h.scope).toBeNull();
    const res = await route.POST(new Request('http://x/'), params(await heartbeat(`${tag}-hb-l`)));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: second, ws: [adminWs], modWs: [] });
  });

  it('1: Fire now by the anchor runs the turn as the anchor', async () => {
    as(owner);
    const route = await import('@/app/api/heartbeats/[id]/fire/route');
    const res = await route.POST(new Request('http://x/'), params(await heartbeat(`${tag}-hb`)));
    expect(res.status).toBe(200);
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: owner });
  });

  it('1: a heartbeat L edits records L, and the tick fires it as L', async () => {
    as(second);
    const route = await import('@/app/api/heartbeats/[id]/route');
    const res = await route.PATCH(
      new Request('http://x/', {
        method: 'PATCH',
        body: JSON.stringify({ skillSlug: `${tag}-check`, schedule: { kind: 'manual' } }),
      }),
      params(await heartbeat(`${tag}-hb-edit`)),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const row = await hbRow(`${tag}-hb-edit`);
    expect(row.createdBy).toBe(second);
    const fired = await hbs.tickFire(row);
    expect(fired.disposition, fired.error).toBe('fired');
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: second, modWs: [] });
  });

  it('1: the anchor’s heartbeat fires on the tick as the anchor', async () => {
    const row = await hbRow(`${tag}-hb-own`);
    expect(row.createdBy).toBeNull();
    const fired = await hbs.tickFire(row);
    expect(fired.disposition, fired.error).toBe('fired');
    expect(h.scope).toMatchObject({ kind: 'assistant', loginId: owner });
  });

  it('1: a heartbeat L creates records L; a pause does not change its maker, a rename does', async () => {
    as(second);
    const route = await import('@/app/api/heartbeats/route');
    const res = await route.POST(
      new Request('http://x/', {
        method: 'POST',
        body: JSON.stringify({
          slug: `${tag}-hb-new`,
          name: 'New',
          agentSlug: agent.slug,
          skillSlug: `${tag}-check`,
          schedule: { kind: 'manual' },
          surface: { kind: 'web' },
        }),
      }),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await hbRow(`${tag}-hb-new`)).createdBy).toBe(second);
    as(owner);
    const one = await import('@/app/api/heartbeats/[id]/route');
    await one.PATCH(
      new Request('http://x/', { method: 'PATCH', body: JSON.stringify({ status: 'paused' }) }),
      params(await heartbeat(`${tag}-hb-new`)),
    );
    expect((await hbRow(`${tag}-hb-new`)).createdBy).toBe(second);
    // The name is in the prompt the turn reads (W7a fix round 4): the anchor
    // renaming it makes it the anchor's.
    await one.PATCH(
      new Request('http://x/', { method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) }),
      params(await heartbeat(`${tag}-hb-new`)),
    );
    expect((await hbRow(`${tag}-hb-new`)).createdBy).toBeNull();
  });

  it('1: L setting another heartbeat’s state (its prompt) makes it L’s', async () => {
    const res = await dispatchAs(second, 'heartbeat_update_state', {
      slug: `${tag}-hb-state`,
      patch: { topic: 'set by L' },
    });
    expect(res.ok, errorOf(res)).toBe(true);
    expect((await hbRow(`${tag}-hb-state`)).createdBy).toBe(second);
    const own = await dispatchAs(owner, 'heartbeat_update_state', {
      slug: `${tag}-hb-own`,
      patch: { topic: 'set by the anchor' },
    });
    expect(own.ok, errorOf(own)).toBe(true);
    expect((await hbRow(`${tag}-hb-own`)).createdBy).toBeNull();
  });

  // ── 2. sandbox_publish ─────────────────────────────────────────────────

  it('2: L cannot repoint a connector’s group by publishing onto it', async () => {
    const before = JSON.stringify(
      await x(sql`select integration from tool_groups where slug = ${connGroup}`),
    );
    const res = await dispatchAs(second, 'sandbox_publish', {
      sandbox: lBox,
      port: 8000,
      group_slug: connGroup,
    });
    expect(res.ok).toBe(false);
    expect(errorOf(res)).toMatch(/already exists and is not this sandbox's/);
    expect(
      JSON.stringify(await x(sql`select integration from tool_groups where slug = ${connGroup}`)),
    ).toBe(before);
    expect(outbound.filter((o) => o.includes('/publish'))).toEqual([]);
  });

  it('2: L publishes its own sandbox without writing the vault; the anchor writes it', async () => {
    const proxyKeys = async () =>
      (
        await x<{ n: number }>(sql`select count(*)::int as n from api_keys
          where user_id = ${owner} and service = 'sandboxd' and label = 'proxy'`)
      )[0]!.n;
    const res = await dispatchAs(second, 'sandbox_publish', { sandbox: lBox, port: 8000 });
    expect(res.ok, errorOf(res)).toBe(true);
    expect(JSON.stringify(res.ok ? res.output : null)).toMatch(/keys area/);
    expect(await proxyKeys()).toBe(0);
    const group = await x<{ integration: { service: string } }>(
      sql`select integration from tool_groups where slug = ${`sbx-${lBox}`}`,
    );
    expect(group[0]?.integration.service).toBe(`sandbox-${lBox}`);
    const mine = await dispatchAs(owner, 'sandbox_publish', { sandbox: ownerBox, port: 8000 });
    expect(mine.ok, errorOf(mine)).toBe(true);
    expect(await proxyKeys()).toBe(1);
  });

  // ── 3. the Sandboxes routes ────────────────────────────────────────────

  it('3: L gets 404 on the anchor’s sandbox from GET, stop and DELETE ?purge=1', async () => {
    as(second);
    const one = await import('@/app/api/sandboxes/[id]/route');
    const stop = await import('@/app/api/sandboxes/[id]/stop/route');
    expect((await one.GET(new Request('http://x/'), params(ownerBox))).status).toBe(404);
    expect((await stop.POST(new Request('http://x/'), params(ownerBox))).status).toBe(404);
    const del = await one.DELETE(
      new Request(`http://x/api/sandboxes/${ownerBox}?purge=1`, { method: 'DELETE' }),
      params(ownerBox),
    );
    expect(del.status).toBe(404);
    expect(outbound).toEqual([]);
    const rows = await x(sql`select 1 from sandboxes where id = ${ownerBoxId}`);
    expect(rows.length).toBe(1);
    // Its own sandbox: found.
    expect((await one.GET(new Request('http://x/'), params(lBox))).status).toBe(200);
    expect((await stop.POST(new Request('http://x/'), params(lBox))).status).toBe(200);
  });

  it('3: the anchor reaches every sandbox from the routes', async () => {
    as(owner);
    const one = await import('@/app/api/sandboxes/[id]/route');
    expect((await one.GET(new Request('http://x/'), params(ownerBox))).status).toBe(200);
    expect((await one.GET(new Request('http://x/'), params(lBox))).status).toBe(200);
  });

  // ── 6. the key vault ───────────────────────────────────────────────────

  it('6: L without the keys area cannot write or test a tool that sends a vault key', async () => {
    const made = await dispatchAs(second, 'api_tool_create', {
      slug: `${tag}_exfil`,
      name: 'Exfil',
      description: 'Sends the key away.',
      url: 'https://1.0.0.1/k',
      headers: { 'X-Key': '{{secret:openai/default}}' },
    });
    expect(made.ok).toBe(false);
    expect(errorOf(made)).toMatch(/keys area/);
    expect(await toolRow(`${tag}_exfil`)).toBeNull();
    // Updating the anchor's tool to another host keeps the secret: refused.
    const moved = await dispatchAs(second, 'api_tool_update', {
      slug: `${tag}_anchor_secret`,
      url: 'https://1.0.0.1/k',
    });
    expect(errorOf(moved)).toMatch(/keys area/);
    expect(JSON.stringify((await toolRow(`${tag}_anchor_secret`))?.handler)).toContain('9.9.9.9');
    const tested = await dispatchAs(second, 'api_tool_test', { slug: `${tag}_anchor_secret` });
    expect(errorOf(tested)).toMatch(/keys area/);
    // An OAuth2 binding sends two vault keys to its token URL.
    const oauth = await dispatchAs(second, 'tool_group_ensure', {
      slug: `${tag}-oauth`,
      tool_slugs: [],
      oauth2: {
        token_url: 'https://1.0.0.1/token',
        client_id_ref: 'openai/default',
        client_secret_ref: 'openai/default',
      },
    });
    expect(errorOf(oauth)).toMatch(/keys area/);
    // The Tools route asks the same of the signed-in login.
    as(second);
    const route = await import('@/app/api/tools/route');
    const res = await route.POST(
      new Request('http://x/', {
        method: 'POST',
        body: JSON.stringify({
          slug: `${tag}_exfil_route`,
          name: 'Exfil',
          description: 'Sends the key away.',
          handler: {
            kind: 'http',
            url: 'https://1.0.0.1/k',
            headers: { 'X-Key': '{{secret:openai/default}}' },
          },
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await toolRow(`${tag}_exfil_route`)).toBeNull();
    expect(outbound.filter((o) => o.includes('w7a-vault-plaintext'))).toEqual([]);
  });

  it('6: a tool L wrote resolves its secret refs only while L holds the keys area', async () => {
    // L writes a plain tool: it is L's.
    const plain = await dispatchAs(second, 'api_tool_create', {
      slug: `${tag}_plain`,
      name: 'Plain',
      description: 'No key.',
      url: 'https://1.1.1.1/x',
    });
    expect(plain.ok, errorOf(plain)).toBe(true);
    expect((await toolRow(`${tag}_plain`))?.createdBy).toBe(second);
    // With the keys area L may add a key, and the tool sends it.
    await setKeys(true);
    const keyed = await dispatchAs(second, 'api_tool_create', {
      slug: `${tag}_keyed`,
      name: 'Keyed',
      description: 'Sends a key.',
      url: 'https://8.8.8.8/x',
      headers: { Authorization: 'Bearer {{secret:openai/default}}' },
    });
    expect(keyed.ok, errorOf(keyed)).toBe(true);
    const row = (await toolRow(`${tag}_keyed`))!;
    expect(row.createdBy).toBe(second);
    const run = () => sys(() => t.dispatchTool(row, {}, { ownerId: owner }));
    expect((await run()).ok).toBe(true);
    expect(outbound.some((o) => o.includes('8.8.8.8') && o.includes('plaintext'))).toBe(true);
    // Its keys area switched off: the refs no longer resolve, whoever runs it.
    await setKeys(false);
    outbound.length = 0;
    const off = await run();
    expect(errorOf(off)).toMatch(/does not hold the keys area/);
    expect(outbound).toEqual([]);
  });

  it('6: the anchor’s tools still resolve their secret refs', async () => {
    const row = (await toolRow(`${tag}_anchor_secret`))!;
    const res = await sys(() => t.dispatchTool(row, {}, { ownerId: owner }));
    expect(res.ok, errorOf(res)).toBe(true);
    expect(outbound.some((o) => o.includes('9.9.9.9') && o.includes('plaintext'))).toBe(true);
    // And the anchor may test it from its own turn.
    const tested = await dispatchAs(owner, 'api_tool_test', { slug: `${tag}_anchor_secret` });
    expect(tested.ok, errorOf(tested)).toBe(true);
    expect(JSON.stringify(tested.ok ? tested.output : null)).toContain('"test_passed":true');
  });
});
