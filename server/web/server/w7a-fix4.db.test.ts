/**
 * W7a fix round 4, on a migrated scratch database: the anchor, and a second
 * Admin login L (a user of Admin, no Moderator there) whose limits switch
 * the keys area off unless a test turns it on.
 *
 * One rule (@mantle/tools secret-ref-gate.ts): a vault key may meet a host
 * only by a login with the keys area, or the anchor; a stored pair answers
 * at run time to the login that set it.
 *
 *  1. OpenAPI connectors: create and PATCH; synced tools take the
 *     connector's configuring login as their maker.
 *  2. MCP connectors: create and PATCH; the key goes out only while the
 *     configuring login holds the keys area.
 *  3. The API Console proxy resolves a vault ref only for the keys area.
 *  4. Model routes (agents, AI workers, the embedding probe, onboarding): a
 *     key with a base URL of the writer's choosing; onboarding's key writes.
 *  5. A skill or agent prompt L saves makes the heartbeats that run it L's.
 *  6. A heartbeat's name is a maker field.  7. The DTO carries createdBy.
 *  8. Plain integration groups: tool_group_ensure and the PATCH route; a
 *     tool authored into such a group answers to the group's configuring
 *     login.
 *
 * Only the model, its key, the vault seal and the outside hosts are faked.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/w7a-fix4.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ session: null as unknown }));

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

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Ping API', version: '1' },
  servers: [{ url: 'https://9.9.9.9/api' }],
  paths: {
    '/ping': {
      get: { operationId: 'ping', summary: 'Ping', responses: { '200': { description: 'ok' } } },
    },
  },
};

describe.skipIf(!URL)('W7a fix round 4', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  let rt: typeof import('@mantle/runtime/agent');
  let dir = '';
  const owner = randomUUID(); // the anchor
  const second = randomUUID(); // L: a user of Admin
  const tag = `w7ah${randomUUID().slice(0, 6)}`;
  const apiKeyId = randomUUID();
  let adminWs = '';
  let agent: import('@mantle/db').Agent;
  const outbound: string[] = [];

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const sys = <T>(fn: () => Promise<T>) => m.asSystem(fn);
  const dispatchAs = (login: string, slug: string, input: Record<string, unknown>) =>
    rt.withAgentScope(
      { id: agent.id, audience: 'admin', workspaceId: adminWs },
      () =>
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
      { ownerLoginId: login },
    );
  const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? '' : String(r.error));
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
  const setKeys = (on: boolean) =>
    x(sql`update workspace_users
             set limits = ${JSON.stringify(on ? {} : { areas: { keys: false } })}::jsonb
           where workspace_id = ${adminWs} and login_id = ${second}`);
  const groupRow = async (slug: string) => {
    const [row] = await m.systemDb
      .select()
      .from(m.toolGroups)
      .where(sql`${m.toolGroups.slug} = ${slug}`);
    return row ?? null;
  };
  const toolRow = async (slug: string) => {
    const [row] = await m.systemDb
      .select()
      .from(m.tools)
      .where(sql`${m.tools.slug} = ${slug}`);
    return row ?? null;
  };
  const hbMaker = async (slug: string) =>
    (
      await x<{ created_by: string | null }>(
        sql`select created_by::text from heartbeats where slug = ${slug}`,
      )
    )[0]!.created_by;
  const hbId = async (slug: string) =>
    (await x<{ id: string }>(sql`select id::text from heartbeats where slug = ${slug}`))[0]!.id;
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
        ...extra,
      })
      .returning();
    return row!;
  };
  const newHeartbeat = (slug: string, agentSlug: string, skillSlug: string) =>
    x(sql`insert into heartbeats (owner_id, slug, name, agent_slug, skill_slug,
                                   schedule_kind, schedule, surface)
      values (${owner}, ${slug}, 'Check', ${agentSlug}, ${skillSlug},
              'manual', ${JSON.stringify({ kind: 'manual' })}::jsonb,
              ${JSON.stringify({ kind: 'web' })}::jsonb)`);

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    dir = await mkdtemp(path.join(tmpdir(), 'w7a-fix4-'));
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
      vi.fn(async (input: unknown, init?: { method?: string; headers?: unknown }) => {
        const req = input instanceof Request ? input : null;
        const url = String(req ? req.url : input);
        const hdrs = new Headers((req?.headers ?? init?.headers ?? {}) as HeadersInit);
        outbound.push(
          `${req?.method ?? init?.method ?? 'GET'} ${url} ${hdrs.get('authorization') ?? ''} ${hdrs.get('x-key') ?? ''}`,
        );
        if (url.endsWith('/openapi.json')) return Response.json(SPEC);
        if (url.startsWith('https://')) return Response.json({ ok: true });
        return new Response('{"error":"offline in the W7a test"}', { status: 503 });
      }),
    );
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    rt = await import('@mantle/runtime/agent');
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
    const keys = await import('@mantle/api-keys');
    await sys(() => keys.setApiKey(owner, 'openai', 'default', 'sk-real-secret'));
    await x(sql`insert into api_keys (id, user_id, service, label, key_enc)
      values (${apiKeyId}, ${owner}, 'openrouter', ${tag}, '\\x00'::bytea)`);
    agent = await newAgent(`${tag}-admin`, {
      memoryConfig: { chunk_limit: 0, content_hit_limit: 0, corpus_map_limit: 0 },
    });
    await x(sql`insert into skills (owner_id, slug, name, description)
      values (${owner}, ${`${tag}-check`}, 'Check in', 'Ask how things are going.')`);
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await m?.closeDb();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    h.session = null;
    outbound.length = 0;
    await setKeys(false);
  });

  const leaked = () => outbound.filter((o) => o.includes('w7a-vault-plaintext'));

  // ── 1. OpenAPI connectors ──────────────────────────────────────────────

  it('1: L without the keys area cannot create an OpenAPI connector that carries a key', async () => {
    as(second);
    const route = await import('@/app/api/openapi-connectors/route');
    const res = await route.POST(
      json({
        slug: `${tag}x`,
        specUrl: 'https://1.0.0.1/openapi.json',
        baseUrl: 'https://1.0.0.1/api',
        secretRef: 'openai/default',
        authTemplate: { headers: { Authorization: 'Bearer {{secret:openai/default}}' } },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/keys area/);
    expect(await groupRow(`openapi-${tag}x`)).toBeNull();
    // Without a key it may.
    const plain = await route.POST(
      json({ slug: `${tag}p`, specUrl: 'https://1.0.0.1/openapi.json' }),
    );
    expect(plain.status, await plain.clone().text()).toBe(201);
  });

  it('1: synced tools are the configuring login’s; its key stops when that login loses the keys area', async () => {
    await setKeys(true);
    as(second);
    const route = await import('@/app/api/openapi-connectors/route');
    const res = await route.POST(
      json({
        slug: `${tag}o`,
        specUrl: 'https://9.9.9.9/openapi.json',
        baseUrl: 'https://9.9.9.9/api',
        secretRef: 'openai/default',
        authTemplate: { headers: { Authorization: 'Bearer {{secret:openai/default}}' } },
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const group = (await groupRow(`openapi-${tag}o`))!;
    expect(group.configuredBy).toBe(second);
    const [mirrored] = await x<{ slug: string }>(
      sql`select slug from tools where handler -> 'openapi' ->> 'group' = ${`openapi-${tag}o`}`,
    );
    const tool = (await toolRow(mirrored!.slug))!;
    expect(tool.createdBy).toBe(second);
    const run = () => sys(() => t.dispatchTool(tool, {}, { ownerId: owner }));
    expect((await run()).ok).toBe(true);
    expect(outbound.some((o) => o.includes('9.9.9.9/api/ping') && o.includes('plaintext'))).toBe(
      true,
    );
    // L loses the keys area: the key no longer resolves, whoever runs it,
    // and L may not move the host.
    await setKeys(false);
    outbound.length = 0;
    expect(errorOf(await run())).toMatch(/does not hold the keys area/);
    expect(outbound).toEqual([]);
    const one = await import('@/app/api/openapi-connectors/[slug]/route');
    const moved = await one.PATCH(
      json({ baseUrl: 'https://1.0.0.1/api' }, 'PATCH'),
      params('slug', `openapi-${tag}o`),
    );
    expect(moved.status).toBe(403);
    expect((await groupRow(`openapi-${tag}o`))!.integration?.baseUrl).toBe('https://9.9.9.9/api');
    // A rename is not a pairing.
    const renamed = await one.PATCH(
      json({ name: 'Ping' }, 'PATCH'),
      params('slug', `openapi-${tag}o`),
    );
    expect(renamed.status).toBe(200);
    // The anchor may move it, and the connector is then the anchor's.
    as(owner);
    const anchor = await one.PATCH(
      json({ baseUrl: 'https://8.8.8.8/api' }, 'PATCH'),
      params('slug', `openapi-${tag}o`),
    );
    expect(anchor.status, await anchor.clone().text()).toBe(200);
    expect((await groupRow(`openapi-${tag}o`))!.configuredBy).toBeNull();
    expect(leaked()).toEqual([]);
  });

  // ── 2. MCP connectors ──────────────────────────────────────────────────

  it('2: L without the keys area cannot pair an MCP connector’s key with a URL', async () => {
    as(second);
    const route = await import('@/app/api/mcp-connectors/route');
    const res = await route.POST(
      json({ slug: `${tag}m`, url: 'https://1.0.0.1/mcp', secretRef: 'openai/default' }),
    );
    expect(res.status).toBe(403);
    expect(await groupRow(`mcp-${tag}m`)).toBeNull();
    // An existing connector with a key: its URL stays.
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, integration)
      values (${owner}, ${`mcp-${tag}k`}, 'MCP', ${'{}'}::text[],
              ${JSON.stringify({ service: `${tag}k`, mcp: { url: 'https://9.9.9.9/mcp', secretRef: 'openai/default' } })}::jsonb)`);
    const one = await import('@/app/api/mcp-connectors/[slug]/route');
    const moved = await one.PATCH(
      json({ url: 'https://1.0.0.1/mcp' }, 'PATCH'),
      params('slug', `mcp-${tag}k`),
    );
    expect(moved.status).toBe(403);
    expect((await groupRow(`mcp-${tag}k`))!.integration?.mcp?.url).toBe('https://9.9.9.9/mcp');
    const rekeyed = await one.PATCH(
      json({ secretRef: 'openrouter/other' }, 'PATCH'),
      params('slug', `mcp-${tag}k`),
    );
    expect(rekeyed.status).toBe(403);
    expect(leaked()).toEqual([]);
  });

  it('2: an MCP connector L paired sends its key only while L holds the keys area', async () => {
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, integration, configured_by)
      values (${owner}, ${`mcp-${tag}l`}, 'MCP', ${'{}'}::text[],
              ${JSON.stringify({ service: `${tag}l`, mcp: { url: 'https://1.0.0.1/mcp', secretRef: 'openai/default' } })}::jsonb,
              ${second})`);
    await expect(sys(() => t.syncMcpConnector(owner, `mcp-${tag}l`))).rejects.toThrow(
      /does not hold the keys area/,
    );
    expect(outbound).toEqual([]);
  });

  // ── 3. the API Console proxy ───────────────────────────────────────────

  it('3: the API Console proxy resolves a vault ref only for the keys area', async () => {
    const route = await import('@/app/api/dev-tools/proxy/route');
    const send = (headers: Record<string, string>) =>
      route.POST(json({ url: 'https://1.0.0.1/echo', method: 'GET', headers }));
    as(second);
    const refused = await send({ 'X-Key': '{{secret:openai/default}}' });
    expect(refused.status).toBe(403);
    expect(outbound).toEqual([]);
    const plain = await send({ 'X-Key': 'not-a-ref' });
    expect(plain.status).toBe(200);
    as(owner);
    const anchor = await send({ 'X-Key': '{{secret:openai/default}}' });
    expect(anchor.status).toBe(200);
    expect(outbound.some((o) => o.includes('1.0.0.1/echo') && o.includes('plaintext'))).toBe(true);
  });

  // ── 4. model routes ────────────────────────────────────────────────────

  it('4: L without the keys area cannot pair a model route’s key with a host', async () => {
    const routed = await newAgent(`${tag}-routed`);
    const hosted = await newAgent(`${tag}-hosted`, {
      apiKeyId: null,
      baseUrl: 'https://1.0.0.1/v1',
    });
    as(second);
    const one = await import('@/app/api/agents/[id]/route');
    // A host for an agent with a key.
    const moved = await one.PATCH(
      json({ baseUrl: 'https://1.0.0.1/v1' }, 'PATCH'),
      params('id', routed.id),
    );
    expect(moved.status).toBe(403);
    // A key for an agent with a host.
    const keyed = await one.PATCH(json({ apiKeyId }, 'PATCH'), params('id', hosted.id));
    expect(keyed.status).toBe(403);
    // Neither: fine.
    const renamed = await one.PATCH(json({ name: 'Renamed' }, 'PATCH'), params('id', routed.id));
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect(
      (
        await x<{ n: number }>(sql`select count(*)::int as n from agents
        where (id = ${routed.id} and base_url is not null) or (id = ${hosted.id} and api_key_id is not null)`)
      )[0]!.n,
    ).toBe(0);
    // A new agent, a new AI worker, the embedding probe.
    const agentsRoute = await import('@/app/api/agents/route');
    const made = await agentsRoute.POST(
      json({
        slug: `${tag}-exfil`,
        name: 'Exfil',
        role: 'custom',
        model: 'x/y',
        apiKeyId,
        baseUrl: 'https://1.0.0.1/v1',
        systemPrompt: 'p',
      }),
    );
    expect(made.status).toBe(403);
    const workers = await import('@/app/api/ai-workers/route');
    const worker = await workers.POST(
      json({
        kind: 'summarizer',
        name: 'Exfil',
        provider: 'openrouter',
        model: 'x/y',
        apiKeyId,
        baseUrl: 'https://1.0.0.1/v1',
      }),
    );
    expect(worker.status).toBe(403);
    const probe = await import('@/app/api/embedding/test/route');
    const probed = await probe.POST(
      json({ provider: 'openai', model: 'm', baseUrl: 'https://1.0.0.1/v1', apiKeyId }),
    );
    expect(probed.status).toBe(403);
    // Onboarding: a vault key, or the Azure endpoint for the 'custom' key.
    const onboarding = await import('@/app/api/onboarding/route');
    const azure = await onboarding.POST(
      json({ action: 'models', route: 'azure', azureBaseUrl: 'https://1.0.0.1/openai/v1' }),
    );
    expect(azure.status).toBe(403);
    const saved = await onboarding.POST(
      json({ action: 'saveKey', service: 'openai', plaintext: 'sk-l' }),
    );
    expect(saved.status).toBe(403);
    expect(outbound).toEqual([]);
    // With the keys area L may.
    await setKeys(true);
    const ok = await one.PATCH(
      json({ baseUrl: 'https://1.0.0.1/v1' }, 'PATCH'),
      params('id', routed.id),
    );
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  // ── 5, 6, 7. heartbeat makers ──────────────────────────────────────────

  it('5: a skill L saves makes the heartbeats that run it L’s; the anchor’s saves do not', async () => {
    await newHeartbeat(`${tag}-hb-skill`, agent.slug, `${tag}-check`);
    const [skill] = await x<{ id: string }>(
      sql`select id::text from skills where slug = ${`${tag}-check`}`,
    );
    const one = await import('@/app/api/skills/[id]/route');
    as(owner);
    const byAnchor = await one.PATCH(
      json({ instructions: 'Ask kindly.' }, 'PATCH'),
      params('id', skill!.id),
    );
    expect(byAnchor.status).toBe(200);
    expect(await hbMaker(`${tag}-hb-skill`)).toBeNull();
    as(second);
    const byL = await one.PATCH(
      json({ instructions: 'Ask about the keys.' }, 'PATCH'),
      params('id', skill!.id),
    );
    expect(byL.status).toBe(200);
    expect(await hbMaker(`${tag}-hb-skill`)).toBe(second);
  });

  it('5: an agent prompt L saves (route or Studio) makes the heartbeats bound to it L’s', async () => {
    const a1 = await newAgent(`${tag}-a1`);
    const a2 = await newAgent(`${tag}-a2`);
    await newHeartbeat(`${tag}-hb-a1`, a1.slug, `${tag}-check`);
    await newHeartbeat(`${tag}-hb-a2`, a2.slug, `${tag}-check`);
    await x(
      sql`update heartbeats set created_by = null where slug in (${`${tag}-hb-a1`}, ${`${tag}-hb-a2`})`,
    );
    as(second);
    const one = await import('@/app/api/agents/[id]/route');
    const res = await one.PATCH(
      json({ systemPrompt: 'Do as L says.' }, 'PATCH'),
      params('id', a1.id),
    );
    expect(res.status).toBe(200);
    expect(await hbMaker(`${tag}-hb-a1`)).toBe(second);
    const studio = await import('@/app/api/studio/prose/route');
    const saved = await studio.POST(
      json({ entityType: 'agent', entityId: a2.id, field: 'system_prompt', body: 'L again.' }),
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await hbMaker(`${tag}-hb-a2`)).toBe(second);
  });

  it('6, 7: a name change is a maker change, and the heartbeat says who its maker is', async () => {
    await newHeartbeat(`${tag}-hb-name`, agent.slug, `${tag}-check`);
    await x(sql`update heartbeats set created_by = null where slug = ${`${tag}-hb-name`}`);
    as(second);
    const one = await import('@/app/api/heartbeats/[id]/route');
    const res = await one.PATCH(
      json({ name: 'Ask L' }, 'PATCH'),
      params('id', await hbId(`${tag}-hb-name`)),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await hbMaker(`${tag}-hb-name`)).toBe(second);
    const list = await import('@/app/api/heartbeats/route');
    const body = (await (await list.GET()).json()) as {
      heartbeats: { slug: string; createdBy: string | null }[];
    };
    expect(body.heartbeats.find((b) => b.slug === `${tag}-hb-name`)?.createdBy).toBe(second);
  });

  // ── 8. plain integration groups ────────────────────────────────────────

  it('8: L without the keys area cannot pair a group’s key with a host', async () => {
    const made = await dispatchAs(second, 'tool_group_ensure', {
      slug: `${tag}-grp-x`,
      name: 'Exfil',
      tool_slugs: [],
      service: 'exfil',
      base_url: 'https://1.0.0.1/v1',
      secret_ref: 'openai/default',
      auth_template: { headers: { Authorization: 'Bearer {{secret:openai/default}}' } },
    });
    expect(errorOf(made)).toMatch(/keys area/);
    expect(await groupRow(`${tag}-grp-x`)).toBeNull();
    // The anchor's keyed group: L may not move its host over the route.
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, integration)
      values (${owner}, ${`${tag}-grp-a`}, 'API', ${'{}'}::text[],
              ${JSON.stringify({
                service: 'acme',
                baseUrl: 'https://9.9.9.9/v1',
                secretRef: 'openai/default',
                authTemplate: { headers: { Authorization: 'Bearer {{secret:openai/default}}' } },
              })}::jsonb)`);
    const g = (await groupRow(`${tag}-grp-a`))!;
    as(second);
    const route = await import('@/app/api/tool-groups/[id]/route');
    const res = await route.PATCH(
      json(
        {
          integration: {
            service: 'acme',
            baseUrl: 'https://1.0.0.1/v1',
            secretRef: 'openai/default',
            authTemplate: { headers: { Authorization: 'Bearer {{secret:openai/default}}' } },
          },
        },
        'PATCH',
      ),
      params('id', g.id),
    );
    expect(res.status).toBe(403);
    const moved = await dispatchAs(second, 'tool_group_ensure', {
      slug: `${tag}-grp-a`,
      tool_slugs: [],
      base_url: 'https://1.0.0.1/v1',
    });
    expect(errorOf(moved)).toMatch(/keys area/);
    expect((await groupRow(`${tag}-grp-a`))!.integration?.baseUrl).toBe('https://9.9.9.9/v1');
    // Docs-only fields are not a pairing.
    const named = await dispatchAs(second, 'tool_group_ensure', {
      slug: `${tag}-grp-a`,
      tool_slugs: [],
      service: 'acme',
    });
    expect(named.ok, errorOf(named)).toBe(true);
  });

  it('8: a tool authored into a group L paired answers to L at run time', async () => {
    await setKeys(true);
    const made = await dispatchAs(second, 'tool_group_ensure', {
      slug: `${tag}-grp-l`,
      name: 'L API',
      tool_slugs: [],
      service: 'lapi',
      base_url: 'https://8.8.8.8/v1',
      secret_ref: 'openai/default',
      auth_template: { headers: { Authorization: 'Bearer {{secret:openai/default}}' } },
    });
    expect(made.ok, errorOf(made)).toBe(true);
    expect((await groupRow(`${tag}-grp-l`))!.configuredBy).toBe(second);
    // The anchor authors a call into it: the tool inherits the group's key,
    // so it answers to the group's configuring login.
    const tool = await dispatchAs(owner, 'api_tool_create', {
      slug: `${tag}_lapi_ping`,
      name: 'Ping',
      description: 'Pings the L API.',
      url: '/ping',
      method: 'GET',
      group_slug: `${tag}-grp-l`,
    });
    expect(tool.ok, errorOf(tool)).toBe(true);
    const row = (await toolRow(`${tag}_lapi_ping`))!;
    expect(row.createdBy).toBe(second);
    const run = () => sys(() => t.dispatchTool(row, {}, { ownerId: owner }));
    expect((await run()).ok).toBe(true);
    await setKeys(false);
    outbound.length = 0;
    expect(errorOf(await run())).toMatch(/does not hold the keys area/);
    expect(outbound).toEqual([]);
  });
});
